//! Persisted updater state and compatibility with older on-disk formats.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// High-level lifecycle states for the local updater daemon.
pub enum UpdateStatus {
    Idle,
    CheckingUpstream,
    UpdateDetected,
    DownloadingDmg,
    PreparingWorkspace,
    BuildingPackage,
    ReadyToInstall,
    WaitingForAppExit,
    Installing,
    Installed,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
/// Status of the user-installed Factory CLI preflight check.
pub enum CliStatus {
    #[default]
    Unknown,
    NotInstalled,
    Checking,
    UpToDate,
    UpdateRequired,
    Updating,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
/// Artifact paths tracked across update checks, rebuilds, and installation.
pub struct ArtifactPaths {
    pub dmg_path: Option<PathBuf>,
    pub workspace_dir: Option<PathBuf>,
    #[serde(rename = "deb_path")]
    pub package_path: Option<PathBuf>,
    #[serde(default)]
    pub rollback_package_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Full updater state stored on disk between daemon runs.
pub struct PersistedState {
    pub installed_version: String,
    pub candidate_version: Option<String>,
    pub status: UpdateStatus,
    pub last_check_at: Option<DateTime<Utc>>,
    pub last_successful_check_at: Option<DateTime<Utc>>,
    /// Fingerprint of the upstream DMG (version + content-length) used to
    /// detect changes. Factory's endpoint uses a redirect API, so we
    /// fingerprint the resolved version + size rather than ETag headers.
    pub remote_headers_fingerprint: Option<String>,
    pub dmg_sha256: Option<String>,
    pub artifact_paths: ArtifactPaths,
    pub error_message: Option<String>,
    pub notified_events: BTreeSet<String>,
    pub auto_install_on_app_exit: bool,
    #[serde(default)]
    pub waiting_for_app_exit_auto_install: bool,
    #[serde(default)]
    pub last_known_good_version: Option<String>,
    #[serde(default)]
    pub rollback_blocked_candidate_version: Option<String>,
    /// The port build SHA of the currently installed .deb, read from
    /// build-info.json. Used to detect new port builds on GitHub Releases.
    #[serde(default)]
    pub installed_port_sha: Option<String>,
    /// The port build SHA of a pending port .deb download (if any).
    #[serde(default)]
    pub port_candidate_sha: Option<String>,
    /// Path to the result sentinel file for an in-progress install launched
    /// via systemd-run transient unit. Set when `trigger_install` launches
    /// the install, cleared when the daemon processes the result.
    #[serde(default)]
    pub install_task_result_file: Option<String>,
}

impl PersistedState {
    /// Creates a new default state using the selected auto-install preference.
    pub fn new(auto_install_on_app_exit: bool) -> Self {
        Self {
            installed_version: "unknown".to_string(),
            candidate_version: None,
            status: UpdateStatus::Idle,
            last_check_at: None,
            last_successful_check_at: None,
            remote_headers_fingerprint: None,
            dmg_sha256: None,
            artifact_paths: ArtifactPaths::default(),
            error_message: None,
            notified_events: BTreeSet::new(),
            auto_install_on_app_exit,
            waiting_for_app_exit_auto_install: false,
            last_known_good_version: None,
            rollback_blocked_candidate_version: None,
            installed_port_sha: None,
            port_candidate_sha: None,
            install_task_result_file: None,
        }
    }

    /// Loads state from disk or returns a new default state if the file is missing.
    pub fn load_or_default(path: &Path, auto_install_on_app_exit: bool) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new(auto_install_on_app_exit));
        }

        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let state = serde_json::from_str::<Self>(&content)
            .with_context(|| format!("Failed to parse {}", path.display()))?;
        Ok(state)
    }

    /// Persists the updater state to JSON on disk.
    pub fn save(&self, path: &Path) -> Result<()> {
        let content = serde_json::to_string_pretty(self)?;
        atomic_write(path, content.as_bytes())?;
        Ok(())
    }

    /// Marks the state as failed while preserving any useful recovery metadata.
    pub fn mark_failed(&mut self, message: impl Into<String>) {
        self.status = UpdateStatus::Failed;
        self.waiting_for_app_exit_auto_install = false;
        self.error_message = Some(message.into());
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;

    let temp_path = atomic_temp_path(path);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .with_context(|| format!("Failed to create {}", temp_path.display()))?;

    let write_result = (|| -> Result<()> {
        temp_file
            .write_all(contents)
            .with_context(|| format!("Failed to write {}", temp_path.display()))?;
        temp_file
            .sync_all()
            .with_context(|| format!("Failed to sync {}", temp_path.display()))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, path).with_context(|| {
        format!(
            "Failed to atomically replace {} with {}",
            path.display(),
            temp_path.display()
        )
    })?;
    Ok(())
}

fn atomic_temp_path(path: &Path) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(".{file_name}.tmp.{}.{}", process::id(), timestamp))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use tempfile::tempdir;

    #[test]
    fn creates_default_state_when_missing() -> Result<()> {
        let temp = tempdir()?;
        let state = PersistedState::load_or_default(&temp.path().join("state.json"), true)?;
        assert_eq!(state.status, UpdateStatus::Idle);
        assert!(state.auto_install_on_app_exit);
        Ok(())
    }

    #[test]
    fn roundtrips_persisted_state() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        let mut state = PersistedState::new(false);
        state.installed_version = "0.108.0".to_string();
        state.status = UpdateStatus::WaitingForAppExit;
        state.candidate_version = Some("0.109.0".to_string());
        state.notified_events.insert("ready_to_install".to_string());
        state.waiting_for_app_exit_auto_install = true;
        state.save(&path)?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.installed_version, "0.108.0");
        assert_eq!(loaded.status, UpdateStatus::WaitingForAppExit);
        assert_eq!(loaded.candidate_version.as_deref(), Some("0.109.0"));
        assert!(loaded.notified_events.contains("ready_to_install"));
        assert!(!loaded.auto_install_on_app_exit);
        assert!(loaded.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn mark_failed_sets_error_message() {
        let mut state = PersistedState::new(true);
        state.mark_failed("build failed");
        assert_eq!(state.status, UpdateStatus::Failed);
        assert_eq!(state.error_message.as_deref(), Some("build failed"));
        assert!(!state.waiting_for_app_exit_auto_install);
    }
}
