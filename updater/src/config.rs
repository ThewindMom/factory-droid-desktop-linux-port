//! Runtime configuration loading and XDG path discovery for the updater.

use anyhow::{Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const SERVICE_NAME: &str = "factory-update-manager";
const DEFAULT_DESKTOP_API: &str = "https://app.factory.ai/api/desktop";
const DEFAULT_GITHUB_OWNER: &str = "ThewindMom";
const DEFAULT_GITHUB_REPO: &str = "factory-desktop-linux";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Runtime configuration values that control how the updater behaves on Linux.
pub struct RuntimeConfig {
    /// Factory Desktop download API URL. Returns a 30x redirect to a
    /// presigned S3 URL containing the version. Unlike the reference's stable
    /// DMG URL, Factory's endpoint is a redirect API, so we fingerprint the
    /// resolved version + content-length rather than ETag headers.
    pub dmg_api_url: String,
    /// Architecture to fetch from the Factory endpoint ("x64" or "arm64").
    #[serde(default = "default_arch")]
    pub arch: String,
    pub initial_check_delay_seconds: u64,
    pub check_interval_hours: u64,
    pub auto_install_on_app_exit: bool,
    pub notifications: bool,
    pub workspace_root: PathBuf,
    /// Root of the builder checkout (the factory-droid-desktop-linux-port repo).
    /// Contains `dist/cli.js`, `package.json`, etc. In a packaged install
    /// this is `/opt/factory-desktop/update-builder`.
    pub builder_bundle_root: PathBuf,
    pub app_executable_path: PathBuf,
    /// GitHub repository owner for port-build update checks.
    #[serde(default = "default_github_owner")]
    pub github_owner: String,
    /// GitHub repository name for port-build update checks.
    #[serde(default = "default_github_repo")]
    pub github_repo: String,
}
fn default_arch() -> String {
    "x64".to_string()
}

fn default_github_owner() -> String {
    DEFAULT_GITHUB_OWNER.to_string()
}

fn default_github_repo() -> String {
    DEFAULT_GITHUB_REPO.to_string()
}

#[derive(Debug, Clone)]
/// Resolved XDG filesystem locations used by the updater at runtime.
pub struct RuntimePaths {
    pub config_file: PathBuf,
    pub state_file: PathBuf,
    pub log_file: PathBuf,
    pub cache_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl RuntimePaths {
    /// Resolves updater paths from the current user's XDG base directories.
    pub fn from_base_dirs(base_dirs: &BaseDirs) -> Self {
        let config_dir = base_dirs.config_dir().join(SERVICE_NAME);
        let state_root = base_dirs
            .state_dir()
            .unwrap_or_else(|| base_dirs.data_local_dir());
        let state_dir = state_root.join(SERVICE_NAME);
        let cache_dir = base_dirs.cache_dir().join(SERVICE_NAME);

        Self {
            config_file: config_dir.join("config.toml"),
            state_file: state_dir.join("state.json"),
            log_file: state_dir.join("service.log"),
            cache_dir,
            state_dir,
            config_dir,
        }
    }

    /// Detects updater paths for the current machine.
    pub fn detect() -> Result<Self> {
        let base_dirs = BaseDirs::new().context("Could not resolve XDG base directories")?;
        Ok(Self::from_base_dirs(&base_dirs))
    }

    /// Creates the runtime directories needed by the updater.
    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("Failed to create {}", self.config_dir.display()))?;
        fs::create_dir_all(&self.state_dir)
            .with_context(|| format!("Failed to create {}", self.state_dir.display()))?;
        fs::create_dir_all(&self.cache_dir)
            .with_context(|| format!("Failed to create {}", self.cache_dir.display()))?;
        Ok(())
    }
}

impl RuntimeConfig {
    /// Builds the default runtime configuration for the resolved paths.
    pub fn default_with_paths(paths: &RuntimePaths) -> Self {
        let packaged_bundle_root = PathBuf::from("/opt/factory-desktop/update-builder");
        let builder_bundle_root = if packaged_bundle_root.exists() {
            packaged_bundle_root
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("updater crate should live inside the repository root")
                .to_path_buf()
        };

        Self {
            dmg_api_url: DEFAULT_DESKTOP_API.to_string(),
            arch: default_arch(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: paths.cache_dir.clone(),
            builder_bundle_root,
            app_executable_path: PathBuf::from("/opt/Factory/factory-desktop"),
            github_owner: default_github_owner(),
            github_repo: default_github_repo(),
        }
    }

    /// Loads the runtime configuration from disk, or returns defaults if missing.
    pub fn load_or_default(paths: &RuntimePaths) -> Result<Self> {
        if !paths.config_file.exists() {
            return Ok(Self::default_with_paths(paths));
        }

        let content = fs::read_to_string(&paths.config_file)
            .with_context(|| format!("Failed to read {}", paths.config_file.display()))?;
        let config = toml::from_str::<Self>(&content)
            .with_context(|| format!("Failed to parse {}", paths.config_file.display()))?;
        Ok(config)
    }

    /// The full API URL to query for the DMG (includes arch query param).
    pub fn dmg_api_url_with_arch(&self) -> String {
        if self.dmg_api_url.contains("architecture=") {
            self.dmg_api_url.clone()
        } else {
            format!(
                "{}?platform=darwin&architecture={}",
                self.dmg_api_url, self.arch
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_factory_endpoint() {
        let paths = RuntimePaths {
            config_file: PathBuf::from("/tmp/config.toml"),
            state_file: PathBuf::from("/tmp/state.json"),
            log_file: PathBuf::from("/tmp/service.log"),
            cache_dir: PathBuf::from("/tmp/cache"),
            state_dir: PathBuf::from("/tmp"),
            config_dir: PathBuf::from("/tmp"),
        };
        let config = RuntimeConfig::default_with_paths(&paths);
        assert_eq!(config.dmg_api_url, DEFAULT_DESKTOP_API);
        assert_eq!(config.arch, "x64");
        assert_eq!(config.check_interval_hours, 6);
    }

    #[test]
    fn dmg_api_url_with_arch_appends_query() {
        let config = RuntimeConfig {
            github_owner: "ThewindMom".to_string(),
            github_repo: "factory-desktop-linux".to_string(),
            dmg_api_url: DEFAULT_DESKTOP_API.to_string(),
            arch: "arm64".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: PathBuf::from("/tmp"),
            builder_bundle_root: PathBuf::from("/tmp"),
            app_executable_path: PathBuf::from("/tmp/factory-desktop"),
        };
        assert_eq!(
            config.dmg_api_url_with_arch(),
            "https://app.factory.ai/api/desktop?platform=darwin&architecture=arm64"
        );
    }

    #[test]
    fn dmg_api_url_with_arch_preserves_existing_param() {
        let config = RuntimeConfig {
            github_owner: "ThewindMom".to_string(),
            github_repo: "factory-desktop-linux".to_string(),
            dmg_api_url: "https://app.factory.ai/api/desktop?architecture=x64".to_string(),
            arch: "x64".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: PathBuf::from("/tmp"),
            builder_bundle_root: PathBuf::from("/tmp"),
            app_executable_path: PathBuf::from("/tmp/factory-desktop"),
        };
        assert_eq!(
            config.dmg_api_url_with_arch(),
            "https://app.factory.ai/api/desktop?architecture=x64"
        );
    }
}
