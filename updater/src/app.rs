//! Application entrypoints and orchestration for the local updater daemon.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, rollback,
    state::{PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tokio::time::{self, Duration};
use tracing::{error, info, warn};

const RECONCILE_INTERVAL_SECONDS: u64 = 15;
const POLKIT_AUTH_AGENT_PROCESS_TOKENS: &[&str] = &[
    "budgie-polkit",
    "cinnamon-polkit",
    "cosmic-osd",
    "gnome-shell",
    "hyprpolkitagent",
    "io.elementary.desktop.agent-polkit",
    "lxpolkit",
    "lxqt-policykit-agent",
    "mate-polkit",
    "polkit-agent",
    "polkit-dde-agent",
    "polkit-gnome-authentication-agent",
    "polkit-kde-authentication-agent",
    "soteria",
    "ukui-polkit",
    "xfce-polkit",
];

/// Runs the updater command-line entrypoint.
pub async fn run(cli: Cli) -> Result<()> {
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;

    let config = RuntimeConfig::load_or_default(&paths)?;
    let mut state =
        PersistedState::load_or_default(&paths.state_file, effective_auto_install(&config))?;
    let original_state = state.clone();
    state.installed_version = install::installed_package_version();
    persist_if_changed(&paths, &state, &original_state)?;

    match cli.command {
        Commands::Daemon => run_daemon(&config, &mut state, &paths).await,
        Commands::CheckNow { if_stale } => {
            run_check_now(&config, &mut state, &paths, if_stale).await
        }
        Commands::Status { json } => run_status(&config, &mut state, &paths, json),
        Commands::InstallReady => run_install_ready(&config, &mut state, &paths).await,
        Commands::Rollback => rollback::run(&config, &mut state, &paths).await,
        Commands::InstallDeb { path } => install::install_deb(&path),
        Commands::InstallRollbackDeb { path } => install_rollback::install_deb(&path),
    }
}

fn persist_state(paths: &RuntimePaths, state: &PersistedState) -> Result<()> {
    state.save(&paths.state_file)
}

fn persist_if_changed(
    paths: &RuntimePaths,
    state: &PersistedState,
    original_state: &PersistedState,
) -> Result<()> {
    if state != original_state {
        persist_state(paths, state)?;
    }
    Ok(())
}

fn effective_auto_install(config: &RuntimeConfig) -> bool {
    config.auto_install_on_app_exit
}

fn sync_runtime_state(config: &RuntimeConfig, state: &mut PersistedState) {
    state.auto_install_on_app_exit = effective_auto_install(config);
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    state.installed_version = install::installed_package_version();
}

fn sync_and_persist(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    sync_runtime_state(config, state);
    persist_if_changed(paths, state, &original_state)
}

fn normalize_workspace_dir_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_if_changed(paths, state, &original_state)
}

fn maybe_prune_workspace_cache(workspace_root: &Path, state: &PersistedState) {
    match cache_cleanup::prune_unreferenced_workspaces(workspace_root, state) {
        Ok(summary) if summary.pruned_workspaces > 0 => {
            info!(
                pruned_workspaces = summary.pruned_workspaces,
                workspace_root = %workspace_root.display(),
                "pruned unreferenced updater workspaces"
            );
        }
        Ok(_) => {}
        Err(error) => {
            warn!(
                ?error,
                workspace_root = %workspace_root.display(),
                "failed to prune unreferenced updater workspaces"
            );
        }
    }
}

fn set_status(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    status: UpdateStatus,
) -> Result<()> {
    state.status = status;
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    persist_state(paths, state)
}

fn set_waiting_for_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    auto_install: bool,
) -> Result<()> {
    state.waiting_for_app_exit_auto_install = auto_install;
    state.status = UpdateStatus::WaitingForAppExit;
    persist_state(paths, state)
}

fn mark_failed_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: impl Into<String>,
) -> Result<()> {
    state.mark_failed(message);
    persist_state(paths, state)
}

fn packaged_runtime_removed(config: &RuntimeConfig) -> bool {
    config.builder_bundle_root == Path::new("/opt/factory-desktop/update-builder")
        && !config.app_executable_path.exists()
        && !install::is_primary_package_installed()
}

fn summarize_command_output(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    let mut lines = text.lines().rev().take(3).collect::<Vec<_>>();
    lines.reverse();
    Some(lines.join(" | "))
}

struct CheckLock {
    _file: fs::File,
}

fn try_acquire_check_lock(paths: &RuntimePaths) -> Result<Option<CheckLock>> {
    let lock_path = paths.state_dir.join("check.lock");
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("Failed to open {}", lock_path.display()))?;

    match file.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            info!("skipping upstream check because another check is already active");
            return Ok(None);
        }
        Err(fs::TryLockError::Error(error)) => {
            return Err(error).with_context(|| format!("Failed to lock {}", lock_path.display()));
        }
    }

    file.set_len(0)
        .with_context(|| format!("Failed to truncate {}", lock_path.display()))?;
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("Failed to seek {}", lock_path.display()))?;
    writeln!(file, "{}", std::process::id())
        .with_context(|| format!("Failed to write {}", lock_path.display()))?;

    Ok(Some(CheckLock { _file: file }))
}

fn update_install_is_pending(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Installing
    )
}

async fn run_daemon(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_workspace_cache(&config.workspace_root, state);
    maybe_notify_installed(state, paths, config.notifications)?;
    if packaged_runtime_removed(config) {
        info!("packaged app files are gone; stopping updater daemon");
        return Ok(());
    }
    info!("daemon initialized");

    time::sleep(Duration::from_secs(config.initial_check_delay_seconds)).await;
    if let Err(error) = run_check_cycle(config, state, paths).await {
        error!(?error, "initial check failed");
    }
    if let Err(error) = reconcile_pending_install(config, state, paths).await {
        error!(?error, "initial reconciliation failed");
    }

    let mut check_interval =
        time::interval(Duration::from_secs(config.check_interval_hours * 3600));
    let mut reconcile_interval = time::interval(Duration::from_secs(RECONCILE_INTERVAL_SECONDS));
    check_interval.tick().await;
    reconcile_interval.tick().await;
    loop {
        if packaged_runtime_removed(config) {
            info!("packaged app files are gone; stopping updater daemon");
            break;
        }

        tokio::select! {
            _ = check_interval.tick() => {
                if let Err(error) = run_check_cycle(config, state, paths).await {
                    error!(?error, "periodic check failed");
                }
            }
            _ = reconcile_interval.tick() => {
                if let Err(error) = reconcile_pending_install(config, state, paths).await {
                    error!(?error, "pending install reconciliation failed");
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                info!("daemon received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

async fn run_check_now(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    if_stale: bool,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_workspace_cache(&config.workspace_root, state);
    maybe_notify_installed(state, paths, config.notifications)?;
    if if_stale && upstream_check_is_fresh(config, state) {
        info!("skipping check-now because the last successful upstream check is still fresh");
        return reconcile_pending_install(config, state, paths).await;
    }
    run_check_cycle(config, state, paths).await?;
    reconcile_pending_install(config, state, paths).await
}

fn upstream_check_is_fresh(config: &RuntimeConfig, state: &PersistedState) -> bool {
    let Some(last_successful_check_at) = state.last_successful_check_at else {
        return false;
    };

    let freshness_window = ChronoDuration::hours(config.check_interval_hours as i64);
    Utc::now().signed_duration_since(last_successful_check_at) < freshness_window
}

fn run_status(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    complete_pending_install_if_already_installed(state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;

    if json {
        println!("{}", serde_json::to_string_pretty(state)?);
    } else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!(
            "candidate_version: {}",
            state.candidate_version.as_deref().unwrap_or("none")
        );
        println!(
            "last_known_good_version: {}",
            state.last_known_good_version.as_deref().unwrap_or("none")
        );
        println!(
            "rollback_blocked_candidate_version: {}",
            state
                .rollback_blocked_candidate_version
                .as_deref()
                .unwrap_or("none")
        );
        println!("{}", update_error_status_line(state));
    }

    Ok(())
}

fn update_error_status_line(state: &PersistedState) -> String {
    format!(
        "update_error: {}",
        state.error_message.as_deref().unwrap_or("none")
    )
}

async fn run_check_cycle(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    if update_install_is_pending(&state.status) {
        info!("skipping upstream check because an update is already pending");
        return Ok(());
    }

    let retrying_failed_update = state.status == UpdateStatus::Failed;

    let Some(_check_lock) = try_acquire_check_lock(paths)? else {
        return Ok(());
    };

    let client = Client::builder().build()?;

    sync_runtime_state(config, state);
    state.status = UpdateStatus::CheckingUpstream;
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    persist_state(paths, state)?;

    let result: Result<()> = async {
        let metadata =
            upstream::fetch_remote_metadata(&client, &config.dmg_api_url_with_arch()).await?;
        let previous_headers_fingerprint = state.remote_headers_fingerprint.clone();
        state.remote_headers_fingerprint = Some(metadata.headers_fingerprint.clone());
        state.last_successful_check_at = Some(Utc::now());

        if previous_headers_fingerprint.as_deref() == Some(metadata.headers_fingerprint.as_str())
            && state.dmg_sha256.is_some()
            && !retrying_failed_update
        {
            set_status(state, paths, UpdateStatus::Idle)?;
            info!("upstream fingerprint unchanged; skipping download");
            return Ok(());
        }

        set_status(state, paths, UpdateStatus::DownloadingDmg)?;

        let downloads_dir = config.workspace_root.join("downloads");
        let downloaded = upstream::download_dmg(
            &client,
            &config.dmg_api_url_with_arch(),
            &downloads_dir,
            Utc::now(),
        )
        .await?;

        if installed_upstream_dmg_matches(config, &downloaded.sha256) {
            clear_dmg_update_candidate(
                state,
                paths,
                Some(downloaded.path),
                Some(downloaded.sha256),
            )?;
            info!("downloaded DMG hash matches installed app; no update detected");
            return Ok(());
        }

        if state
            .rollback_blocked_candidate_version
            .as_deref()
            .is_some_and(|blocked| {
                installed_version_matches_candidate(blocked, &downloaded.candidate_version)
            })
        {
            state.status = UpdateStatus::Idle;
            state.error_message = Some(format!(
                "Candidate {} was rolled back and will not be reinstalled automatically",
                downloaded.candidate_version
            ));
            persist_state(paths, state)?;
            info!(
                candidate_version = %downloaded.candidate_version,
                "skipping candidate blocked by rollback"
            );
            return Ok(());
        }

        if state.dmg_sha256.as_deref() == Some(downloaded.sha256.as_str())
            && !retrying_failed_update
        {
            state.status = UpdateStatus::Idle;
            state.artifact_paths.dmg_path = Some(downloaded.path);
            persist_state(paths, state)?;
            info!("downloaded DMG hash matches current cached DMG; no update detected");
            return Ok(());
        }

        rollback::record_current_package_as_known_good(state);
        state.status = UpdateStatus::UpdateDetected;
        state.candidate_version = Some(downloaded.candidate_version.clone());
        state.dmg_sha256 = Some(downloaded.sha256.clone());
        state.artifact_paths.dmg_path = Some(downloaded.path.clone());
        state.notified_events.clear();
        state.save(&paths.state_file)?;

        maybe_notify(
            state,
            paths,
            config.notifications,
            "update_detected",
            "New Factory Desktop update detected",
            "Preparing a local Linux package from the new upstream DMG.",
        )?;

        let candidate_version = state
            .candidate_version
            .clone()
            .expect("candidate version should be set before local build");
        builder::build_update(config, state, paths, &candidate_version, &downloaded.path).await?;
        maybe_prune_workspace_cache(&config.workspace_root, state);
        maybe_notify_update_ready(state, paths, config.notifications)?;
        Ok(())
    }
    .await;

    if let Err(error) = result {
        mark_failed_and_persist(state, paths, error.to_string())?;
        maybe_prune_workspace_cache(&config.workspace_root, state);
        let _ = notify_failure(config, state, paths, &error);
        return Err(error);
    }

    Ok(())
}

async fn reconcile_pending_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_runtime_state(config, state);
    recover_interrupted_install(state, paths)?;
    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.auto_install_on_app_exit && liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                set_waiting_for_app_exit(state, paths, true)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "ready_to_install",
                    "Factory Desktop update ready",
                    "Close Factory Desktop to install the ready update.",
                )?;
                return Ok(());
            }

            set_status(state, paths, UpdateStatus::ReadyToInstall)?;
        }
        UpdateStatus::WaitingForAppExit => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.waiting_for_app_exit_auto_install && !state.auto_install_on_app_exit {
                set_status(state, paths, UpdateStatus::ReadyToInstall)?;
                return Ok(());
            }

            if liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "waiting_for_app_exit",
                    "Factory Desktop update ready",
                    "The update will install after you close Factory Desktop.",
                )?;
                return Ok(());
            }

            if install_auth_retry_is_blocked(state) {
                return Ok(());
            }

            if !graphical_polkit_auth_agent_is_likely_available() {
                defer_install_for_manual_auth(state, paths, &package_path)?;
                maybe_notify_manual_install_required(state, paths, config.notifications)?;
                return Ok(());
            }

            trigger_install(state, paths, &config.workspace_root, &package_path).await?;
        }
        _ => {}
    }

    Ok(())
}

async fn run_install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;

    if complete_current_dmg_update_if_already_installed(config, state, paths)? {
        println!("Factory Desktop is already up to date.");
        return Ok(());
    }

    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
        println!("Factory Desktop update is already installed or superseded.");
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit => {}
        UpdateStatus::Installing => {
            maybe_send_notification(
                config.notifications,
                "Factory update already installing",
                "Factory Desktop is already applying the ready update.",
            );
            println!("Factory Desktop update is already installing.");
            return Ok(());
        }
        _ => {
            maybe_send_notification(
                config.notifications,
                "No Factory update ready",
                "There is no rebuilt Factory Desktop update waiting to install.",
            );
            println!("No Factory Desktop update is ready to install.");
            return Ok(());
        }
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(state, paths, "No ready update package is recorded")?;
        println!("No ready update package is recorded.");
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Pending package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        println!(
            "Ready update package is missing: {}",
            package_path.display()
        );
        return Ok(());
    }

    if liveness::is_app_running(config)? {
        if !graphical_polkit_auth_agent_is_likely_available() {
            defer_install_for_manual_auth(state, paths, &package_path)?;
            maybe_send_manual_install_required_notification(config.notifications);
            print_manual_install_required(&package_path);
            return Ok(());
        }
        clear_install_auth_required_event(state, paths)?;
        set_waiting_for_app_exit(state, paths, false)?;
        maybe_send_notification(
            config.notifications,
            "Factory Desktop update ready",
            "Close Factory Desktop to install the ready update.",
        );
        println!("Factory Desktop is running. Close it to install the ready update.");
        return Ok(());
    }

    clear_install_auth_required_event(state, paths)?;
    state.waiting_for_app_exit_auto_install = false;
    if !graphical_polkit_auth_agent_is_likely_available() {
        defer_install_for_manual_auth(state, paths, &package_path)?;
        maybe_send_manual_install_required_notification(config.notifications);
        print_manual_install_required(&package_path);
        return Ok(());
    }
    trigger_install(state, paths, &config.workspace_root, &package_path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledBuildInfo {
    upstream_dmg: Option<InstalledUpstreamDmg>,
}

#[derive(Debug, Deserialize)]
struct InstalledUpstreamDmg {
    sha256: Option<String>,
}

fn complete_current_dmg_update_if_already_installed(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !dmg_update_state_can_be_cleared_as_current(&state.status) {
        return Ok(false);
    }

    if state.candidate_version.is_none() {
        return Ok(false);
    }

    let Some(candidate_sha256) = state.dmg_sha256.clone() else {
        return Ok(false);
    };

    if !installed_upstream_dmg_matches(config, &candidate_sha256) {
        return Ok(false);
    }

    clear_dmg_update_candidate(state, paths, None, Some(candidate_sha256))?;
    info!("recovered DMG update state because the candidate DMG is already installed");
    Ok(true)
}

fn dmg_update_state_can_be_cleared_as_current(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::UpdateDetected
            | UpdateStatus::DownloadingDmg
            | UpdateStatus::PreparingWorkspace
            | UpdateStatus::BuildingPackage
            | UpdateStatus::ReadyToInstall
            | UpdateStatus::WaitingForAppExit
            | UpdateStatus::Installing
            | UpdateStatus::Failed
    )
}

fn clear_dmg_update_candidate(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    dmg_path: Option<PathBuf>,
    sha256: Option<String>,
) -> Result<()> {
    state.status = UpdateStatus::Idle;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    if let Some(sha256) = sha256 {
        state.dmg_sha256 = Some(sha256);
    }
    if let Some(dmg_path) = dmg_path {
        state.artifact_paths.dmg_path = Some(dmg_path);
    }
    state.artifact_paths.package_path = None;
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)
}

fn installed_upstream_dmg_matches(config: &RuntimeConfig, sha256: &str) -> bool {
    installed_upstream_dmg_sha256(config).as_deref() == Some(sha256)
}

fn installed_upstream_dmg_sha256(config: &RuntimeConfig) -> Option<String> {
    installed_build_info_paths(config)
        .into_iter()
        .find_map(|path| upstream_dmg_sha256_from_build_info(&path))
}

fn installed_build_info_paths(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_root) = config.app_executable_path.parent() {
        paths.push(app_root.join(".factory-linux/build-info.json"));
        paths.push(app_root.join("resources/factory-linux-build-info.json"));
    }
    paths
}

fn upstream_dmg_sha256_from_build_info(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let build_info = serde_json::from_str::<InstalledBuildInfo>(&content).ok()?;
    build_info
        .upstream_dmg?
        .sha256
        .filter(|value| !value.is_empty())
}

fn complete_pending_install_if_already_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(false);
    }

    let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) else {
        return Ok(false);
    };

    let candidate_is_installed =
        installed_version_matches_candidate(&state.installed_version, &candidate_version);

    state.status = UpdateStatus::Installed;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    if !candidate_is_installed {
        state.artifact_paths.package_path = None;
    }
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!("recovered pending install state because the candidate version is already installed or superseded");
    Ok(true)
}

fn recover_interrupted_install(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    if state.status != UpdateStatus::Installing {
        return Ok(());
    }

    if let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) {
        let candidate_is_installed =
            installed_version_matches_candidate(&state.installed_version, &candidate_version);

        state.status = UpdateStatus::Installed;
        state.waiting_for_app_exit_auto_install = false;
        state.candidate_version = None;
        if !candidate_is_installed {
            state.artifact_paths.package_path = None;
        }
        state.error_message = None;
        state.notified_events.clear();
        cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
        persist_state(paths, state)?;
        info!("recovered interrupted install state because the candidate version is already installed");
        return Ok(());
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(
            state,
            paths,
            "Previous install attempt was interrupted and no package artifact is recorded",
        )?;
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Previous install attempt was interrupted and the package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        return Ok(());
    }

    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message =
        Some("Previous install attempt was interrupted before completion".to_string());
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!(package = %package_path.display(), "recovered interrupted install state back to ready_to_install");
    Ok(())
}

/// Compares versions using semver. Factory uses semver (e.g. "0.108.0"),
/// so we parse and compare directly. Falls back to string equality.
fn installed_version_satisfies_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match (
        semver::Version::parse(installed),
        semver::Version::parse(candidate),
    ) {
        (Ok(installed_ver), Ok(candidate_ver)) => installed_ver >= candidate_ver,
        _ => installed == candidate,
    }
}

fn installed_version_matches_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match (
        semver::Version::parse(installed),
        semver::Version::parse(candidate),
    ) {
        (Ok(installed_ver), Ok(candidate_ver)) => installed_ver == candidate_ver,
        _ => installed == candidate,
    }
}

fn maybe_notify(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_name: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("{event_name}:{version}");
    maybe_notify_with_event_key(state, paths, enabled, &event_key, summary, body)
}

fn maybe_notify_with_event_key(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_key: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    if !state.notified_events.insert(event_key.to_string()) {
        return Ok(());
    }

    if enabled {
        if let Err(error) = notify::send(summary, body) {
            warn!(?error, "failed to send desktop notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

#[allow(dead_code)]
fn clear_notification_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    event_key: &str,
) -> Result<()> {
    if state.notified_events.remove(event_key) {
        persist_state(paths, state)?;
    }
    Ok(())
}

fn maybe_notify_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    if state.status != UpdateStatus::Installed {
        return Ok(());
    }

    maybe_notify(
        state,
        paths,
        enabled,
        "installed",
        "Factory Desktop updated",
        "The new package is installed and will be used the next time you open the app.",
    )
}

fn maybe_notify_update_ready(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("ready_to_install:{version}");
    if !state.notified_events.insert(event_key) {
        return Ok(());
    }

    if enabled {
        let body = if state.auto_install_on_app_exit {
            "A rebuilt Linux package is ready. Close Factory Desktop to install it, or open Factory Desktop and choose Update."
        } else {
            "A rebuilt Linux package is ready. Open Factory Desktop and choose Update to install it."
        };
        if let Err(error) = notify::send("Factory Desktop update ready", body) {
            warn!(?error, "failed to send update-ready notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

fn maybe_send_notification(enabled: bool, summary: &str, body: &str) {
    if enabled {
        let _ = notify::send(summary, body);
    }
}

async fn trigger_install(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace_root: &Path,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::Installing;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
    persist_state(paths, state)?;

    let _ = notify::send(
        "Installing Factory Desktop update",
        "Applying the locally rebuilt Linux package.",
    );

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;
    let output = install::pkexec_command(&current_exe, package_path)
        .output()
        .context("Failed to launch pkexec for update installation")?;
    let status = output.status;

    if status.success() {
        state.status = UpdateStatus::Installed;
        state.waiting_for_app_exit_auto_install = false;
        state.installed_version = install::installed_package_version();
        state.candidate_version = None;
        state.rollback_blocked_candidate_version = None;
        state.error_message = None;
        state.notified_events.clear();
        cache_cleanup::normalize_artifact_workspace_dir(workspace_root, state);
        persist_state(paths, state)?;
        let _ = maybe_notify_installed(state, paths, true);
        maybe_prune_workspace_cache(workspace_root, state);
        return Ok(());
    }

    let stdout = summarize_command_output(&output.stdout);
    let stderr = summarize_command_output(&output.stderr);
    error!(
        status = %status,
        stdout = stdout.as_deref().unwrap_or(""),
        stderr = stderr.as_deref().unwrap_or(""),
        "privileged install failed"
    );

    let mut message = format!("Privileged install exited with status {status}");
    if let Some(stderr) = stderr {
        message.push_str(": ");
        message.push_str(&stderr);
    }

    let error = anyhow::anyhow!(message);
    if pkexec_authentication_was_not_obtained(&status) {
        defer_install_until_next_app_exit(state, paths, error.to_string())?;
        return Err(error);
    }

    mark_failed_and_persist(state, paths, error.to_string())?;
    let _ = notify::send(
        "Factory update failed",
        "The package could not be installed. Check the updater log for details.",
    );
    Err(error)
}

fn pkexec_authentication_was_not_obtained(status: &std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

fn install_auth_required_event_key(state: &PersistedState) -> Option<String> {
    state
        .candidate_version
        .as_deref()
        .map(|candidate| format!("install_auth_required:{candidate}"))
}

fn install_auth_retry_is_blocked(state: &PersistedState) -> bool {
    install_auth_required_event_key(state)
        .as_ref()
        .is_some_and(|event_key| state.notified_events.contains(event_key))
}

fn manual_install_required_message(package_path: &Path) -> String {
    format!(
        "No graphical polkit authentication agent is available for pkexec. Run this from a terminal after closing Factory Desktop: {}",
        manual_install_command(package_path)
    )
}

fn manual_install_command(package_path: &Path) -> String {
    format!(
        "sudo /usr/bin/factory-update-manager install-deb --path {}",
        shell_quote_path(package_path)
    )
}

fn shell_quote_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn print_manual_install_required(package_path: &Path) {
    println!("Manual install required: no graphical polkit authentication agent is available.");
    println!("Run this from a terminal after closing Factory Desktop:");
    println!("{}", manual_install_command(package_path));
}

fn defer_install_for_manual_auth(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(manual_install_required_message(package_path));
    persist_state(paths, state)
}

fn maybe_notify_manual_install_required(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    maybe_notify(
        state,
        paths,
        enabled,
        "manual_install_required",
        "Factory update needs manual install",
        "No graphical authentication agent was found for pkexec. Run factory-update-manager status for details.",
    )
}

fn maybe_send_manual_install_required_notification(enabled: bool) {
    maybe_send_notification(
        enabled,
        "Factory update needs manual install",
        "No graphical authentication agent was found for pkexec. Run factory-update-manager status for details.",
    );
}

fn graphical_polkit_auth_agent_is_likely_available() -> bool {
    if std::env::var_os("FACTORY_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT").is_some() {
        return false;
    }
    if std::env::var_os("FACTORY_UPDATE_MANAGER_ASSUME_POLKIT_AGENT").is_some() {
        return true;
    }
    if !has_user_session_bus_for_polkit() {
        return false;
    }
    polkit_auth_agent_process_is_running()
}

fn has_user_session_bus_for_polkit() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some()
}

fn polkit_auth_agent_process_is_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return true;
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        if !file_name
            .to_string_lossy()
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let process_dir = entry.path();
        let mut process_text = String::new();
        if let Ok(comm) = fs::read_to_string(process_dir.join("comm")) {
            process_text.push_str(&comm);
            process_text.push('\n');
        }
        if let Ok(cmdline) = fs::read(process_dir.join("cmdline")) {
            process_text.push_str(&String::from_utf8_lossy(&cmdline).replace('\0', " "));
        }
        if process_text_matches_polkit_auth_agent(&process_text) {
            return true;
        }
    }

    false
}

fn process_text_matches_polkit_auth_agent(process_text: &str) -> bool {
    let normalized = process_text.to_ascii_lowercase();
    if normalized.contains("polkitd") || normalized.contains("polkit-agent-helper") {
        return false;
    }
    POLKIT_AUTH_AGENT_PROCESS_TOKENS
        .iter()
        .any(|token| normalized.contains(token))
}

fn clear_install_auth_required_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let Some(event_key) = install_auth_required_event_key(state) else {
        return Ok(());
    };

    if state.notified_events.remove(&event_key) {
        persist_state(paths, state)?;
    }

    Ok(())
}

fn defer_install_until_next_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: String,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(message);

    if let Some(event_key) = install_auth_required_event_key(state) {
        if state.notified_events.insert(event_key) {
            let _ = notify::send(
                "Factory update needs permission",
                "The ready update will retry after the next app close. Approve the system authentication dialog to install it.",
            );
        }
    }

    persist_state(paths, state)
}

fn notify_failure(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
) -> Result<()> {
    let body = format!("The local rebuild failed: {error}");
    maybe_notify(
        state,
        paths,
        config.notifications,
        "build_failed",
        "Factory update failed",
        &body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(root: &std::path::Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn test_config(root: &std::path::Path) -> RuntimeConfig {
        RuntimeConfig {
            dmg_api_url: "https://example.com/api/desktop".to_string(),
            arch: "x64".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: root.join("cache"),
            builder_bundle_root: root.join("builder"),
            app_executable_path: root.join("not-running-electron"),
        }
    }

    #[test]
    fn upstream_check_freshness_respects_configured_interval() {
        let config = RuntimeConfig {
            dmg_api_url: "https://example.com/api/desktop".to_string(),
            arch: "x64".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: std::path::PathBuf::from("/tmp/cache"),
            builder_bundle_root: std::path::PathBuf::from("/tmp/builder"),
            app_executable_path: std::path::PathBuf::from("/tmp/electron"),
        };

        let mut state = PersistedState::new(true);
        assert!(!upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(1));
        assert!(upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(7));
        assert!(!upstream_check_is_fresh(&config, &state));
    }

    #[test]
    fn plain_status_reports_update_error() {
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Failed;
        state.error_message = Some("build-all failed during local rebuild".to_string());

        assert_eq!(
            update_error_status_line(&state),
            "update_error: build-all failed during local rebuild"
        );

        state.error_message = None;
        assert_eq!(update_error_status_line(&state), "update_error: none");
    }

    #[test]
    fn semver_version_comparison_works() {
        assert!(installed_version_satisfies_candidate("0.109.0", "0.108.0"));
        assert!(!installed_version_satisfies_candidate("0.107.0", "0.108.0"));
        assert!(installed_version_satisfies_candidate("0.108.0", "0.108.0"));
        assert!(!installed_version_satisfies_candidate("unknown", "0.108.0"));

        assert!(installed_version_matches_candidate("0.108.0", "0.108.0"));
        assert!(!installed_version_matches_candidate("0.109.0", "0.108.0"));
    }

    #[tokio::test]
    async fn run_check_cycle_skips_when_update_is_already_pending() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let config = test_config(temp.path());

        for status in [
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
            UpdateStatus::Installing,
        ] {
            let mut state = PersistedState::new(true);
            state.status = status.clone();

            run_check_cycle(&config, &mut state, &paths).await?;

            assert_eq!(state.status, status);
            assert_eq!(state.last_check_at, None);
        }
        Ok(())
    }
}
