//! Rebuilds native Linux packages from a downloaded upstream DMG.
//!
//! Unlike the reference (which orchestrates `install.sh` +
//! `scripts/build-deb.sh`), Factory Droid's build pipeline is TypeScript:
//! `node dist/cli.js build-all --dmg <path> --targets deb`. This module
//! shells out to that command, passing the downloaded DMG and pointing
//! the output to a per-candidate workspace.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install::PackageKind,
    state::{ArtifactPaths, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};
use tokio::process::Command;
use tracing::info;

/// Files/dirs from the builder checkout needed for a local rebuild.
/// `dist/cli.js` is the compiled entrypoint; `package.json` + `node_modules/`
/// are needed for runtime deps. `linux-features/` and `src/patches/` provide
/// the patch registry and feature boundary.
const REQUIRED_BUNDLE_ENTRIES: &[&str] = &[
    "dist",
    "package.json",
    "package-lock.json",
    "node_modules",
    "src/patches",
    "linux-features",
    "packaging",
];

/// Optional entries copied when present.
const OPTIONAL_BUNDLE_ENTRIES: &[&str] = &["assets", "CHANGELOG.md", "README.md", "tsconfig.json"];

#[derive(Debug, Clone, PartialEq, Eq)]
/// Paths to the temporary workspace and generated package produced by a rebuild.
pub struct BuildArtifacts {
    pub workspace_dir: PathBuf,
    pub package_path: PathBuf,
}

/// Rebuilds a Linux package from the downloaded upstream DMG.
pub async fn build_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    build_update_from(
        &config.builder_bundle_root,
        config,
        state,
        paths,
        candidate_version,
        dmg_path,
    )
    .await
}

/// Rebuilds a Linux package using an explicit builder source tree.
pub async fn build_update_from(
    bundle_source: &Path,
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    let workspace = BuilderWorkspace::prepare(&config.workspace_root, candidate_version)?;

    state.status = UpdateStatus::PreparingWorkspace;
    state.artifact_paths.workspace_dir = Some(workspace.workspace_dir.clone());
    state.save(&paths.state_file)?;

    copy_builder_bundle(bundle_source, &workspace.bundle_dir)?;

    state.status = UpdateStatus::BuildingPackage;
    state.save(&paths.state_file)?;

    let build_path = build_command_path(&config.builder_bundle_root);

    // Run: node dist/cli.js build-all --dmg <path> --targets deb
    //
    // The build-all command reads FACTORY_WORK_DIR / FACTORY_BUILD_DIR /
    // FACTORY_DIST_DIR env vars (via resolveDirs) to redirect all outputs
    // into the per-candidate workspace. This keeps the builder checkout clean
    // and lets find_package_in locate the produced .deb.
    let node_bin = resolve_node_binary(&config.builder_bundle_root, &build_path);

    let mut build = Command::new(node_bin);
    build
        .arg("dist/cli.js")
        .arg("build-all")
        .arg("--dmg")
        .arg(dmg_path)
        .arg("--targets")
        .arg("deb")
        .arg("--factory-version")
        .arg(candidate_version)
        .env("FACTORY_WORK_DIR", &workspace.work_dir)
        .env("FACTORY_BUILD_DIR", &workspace.app_dir)
        .env("FACTORY_DIST_DIR", &workspace.dist_dir)
        .env("PATH", &build_path)
        .current_dir(&workspace.bundle_dir);

    run_and_log(&mut build, &workspace.build_log)
        .await
        .context("build-all failed during local rebuild")?;

    let package_path = find_package_in(&workspace.dist_dir)?;
    state.status = UpdateStatus::ReadyToInstall;
    state.artifact_paths = ArtifactPaths {
        dmg_path: Some(dmg_path.to_path_buf()),
        workspace_dir: Some(workspace.workspace_dir.clone()),
        package_path: Some(package_path.clone()),
        rollback_package_path: state.artifact_paths.rollback_package_path.clone(),
    };
    state.save(&paths.state_file)?;
    info!(candidate_version, package = %package_path.display(), "local update build ready");

    Ok(BuildArtifacts {
        workspace_dir: workspace.workspace_dir,
        package_path,
    })
}

#[derive(Debug, Clone)]
struct BuilderWorkspace {
    workspace_dir: PathBuf,
    bundle_dir: PathBuf,
    dist_dir: PathBuf,
    app_dir: PathBuf,
    work_dir: PathBuf,
    build_log: PathBuf,
}

impl BuilderWorkspace {
    fn prepare(workspace_root: &Path, candidate_version: &str) -> Result<Self> {
        let workspace_dir = workspace_root.join("workspaces").join(candidate_version);
        let bundle_dir = workspace_dir.join("builder");
        // All build outputs go inside bundle_dir so ArtifactTracker
        // sees them as under the project root's generated dirs.
        let dist_dir = bundle_dir.join("dist");
        let app_dir = bundle_dir.join("build");
        let work_dir = bundle_dir.join("work");
        let logs_dir = workspace_dir.join("logs");

        if workspace_dir.exists() {
            fs::remove_dir_all(&workspace_dir)
                .with_context(|| format!("Failed to remove {}", workspace_dir.display()))?;
        }

        fs::create_dir_all(&logs_dir)
            .with_context(|| format!("Failed to create {}", logs_dir.display()))?;

        Ok(Self {
            workspace_dir,
            bundle_dir,
            dist_dir,
            app_dir,
            work_dir,
            build_log: logs_dir.join("build-all.log"),
        })
    }
}

/// Returns the path to the native-package build script appropriate for the running system.
#[allow(dead_code)]
pub fn package_build_script(_bundle_dir: &Path) -> PathBuf {
    // Factory uses a single `build-all` command; the target is selected
    // via --targets. This function is retained for API compatibility.
    _bundle_dir.join("dist/cli.js")
}

/// Returns the PackageKind detected on the current system.
#[allow(dead_code)]
pub fn detected_package_kind() -> PackageKind {
    PackageKind::detect()
}

fn copy_builder_bundle(source_root: &Path, destination_root: &Path) -> Result<()> {
    for entry in REQUIRED_BUNDLE_ENTRIES {
        if *entry == "node_modules" {
            // node_modules contains symlinks (.bin/) that break when copied.
            // Create a symlink to the source node_modules instead.
            let source = source_root.join(entry);
            let destination = destination_root.join(entry);
            if !source.exists() {
                anyhow::bail!(
                    "Required builder bundle path is missing: {}",
                    source.display()
                );
            }
            // Remove existing destination if present
            if destination.exists() || destination.is_symlink() {
                fs::remove_dir_all(&destination)
                    .or_else(|_| fs::remove_file(&destination))
                    .with_context(|| format!("Failed to remove {}", destination.display()))?;
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(&source, &destination).with_context(|| {
                format!(
                    "Failed to symlink {} to {}",
                    source.display(),
                    destination.display()
                )
            })?;
            #[cfg(not(unix))]
            {
                // Fallback: copy recursively on non-Unix
                copy_dir_recursive(&source, &destination)?;
            }
        } else {
            copy_entry(
                &source_root.join(entry),
                &destination_root.join(entry),
                false,
            )?;
        }
    }

    for entry in OPTIONAL_BUNDLE_ENTRIES {
        copy_entry(
            &source_root.join(entry),
            &destination_root.join(entry),
            true,
        )?;
    }

    Ok(())
}

fn copy_entry(source: &Path, destination: &Path, optional: bool) -> Result<()> {
    if !source.exists() {
        if optional {
            return Ok(());
        }
        anyhow::bail!(
            "Required builder bundle path is missing: {}",
            source.display()
        );
    }

    if source.is_dir() {
        copy_dir_recursive(source, destination)?;
    } else {
        copy_path(source, destination)?;
    }

    Ok(())
}

fn copy_path(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Destination path has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;
    fs::copy(source, destination).with_context(|| {
        format!(
            "Failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    let metadata =
        fs::metadata(source).with_context(|| format!("Failed to stat {}", source.display()))?;
    fs::set_permissions(destination, metadata.permissions())
        .with_context(|| format!("Failed to set permissions on {}", destination.display()))?;
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    for entry in
        fs::read_dir(source).with_context(|| format!("Failed to read {}", source.display()))?
    {
        let entry = entry?;
        let entry_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry_path, &destination_path)?;
        } else {
            copy_path(&entry_path, &destination_path)?;
        }
    }

    Ok(())
}

/// Find a native package file inside `dist_dir`.
fn find_package_in(dist_dir: &Path) -> Result<PathBuf> {
    for entry in
        fs::read_dir(dist_dir).with_context(|| format!("Failed to read {}", dist_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if is_native_package_file(&path) {
            return Ok(path);
        }
    }

    anyhow::bail!("No native package (.deb) found in {}", dist_dir.display())
}

fn is_native_package_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.ends_with(".deb")
}

fn build_command_path(builder_bundle_root: &Path) -> OsString {
    let mut entries = managed_node_bin_dirs(builder_bundle_root);
    entries.extend(preferred_node_bin_dirs());
    entries.extend(preferred_rust_bin_dirs());
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    entries.extend(system_bin_dirs());
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn managed_node_bin_dirs(builder_bundle_root: &Path) -> Vec<PathBuf> {
    let bin_dir = builder_bundle_root.join("node-runtime/bin");
    if is_node_toolchain_dir(&bin_dir) {
        vec![bin_dir]
    } else {
        Vec::new()
    }
}

fn system_bin_dirs() -> Vec<PathBuf> {
    [
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn preferred_node_bin_dirs() -> Vec<PathBuf> {
    let nvm_root = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".nvm")));

    let Some(nvm_root) = nvm_root else {
        return Vec::new();
    };

    collect_nvm_bin_dirs(&nvm_root)
}

fn preferred_rust_bin_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };

    let cargo_bin = PathBuf::from(home).join(".cargo/bin");
    if cargo_bin.join("cargo").is_file() {
        vec![cargo_bin]
    } else {
        Vec::new()
    }
}

fn collect_nvm_bin_dirs(nvm_root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    let current_bin = nvm_root.join("versions/node/current/bin");
    if is_node_toolchain_dir(&current_bin) {
        seen.insert(current_bin.clone());
        directories.push(current_bin);
    }

    let versions_root = nvm_root.join("versions/node");
    if let Ok(entries) = fs::read_dir(&versions_root) {
        let mut version_bins = entries
            .filter_map(|entry| entry.ok().map(|item| item.path().join("bin")))
            .filter(|path| is_node_toolchain_dir(path))
            .collect::<Vec<_>>();
        version_bins.sort();
        version_bins.reverse();

        for path in version_bins {
            if seen.insert(path.clone()) {
                directories.push(path);
            }
        }
    }

    directories
}

/// Resolves the node binary to use for the build. Prefers a managed runtime
/// bundled with the builder, then nvm, then system `node`.
fn resolve_node_binary(builder_bundle_root: &Path, _build_path: &OsString) -> PathBuf {
    let managed = builder_bundle_root.join("node-runtime/bin/node");
    if managed.is_file() {
        return managed;
    }

    if let Some(node) = find_in_path("node") {
        return node;
    }

    PathBuf::from("node")
}

/// Searches `$PATH` for an executable named `name`, returning the first match.
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    std::env::split_paths(&path_env).find_map(|entry| {
        let candidate = entry.join(name);
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    })
}

fn is_node_toolchain_dir(path: &Path) -> bool {
    ["node", "npm", "npx"]
        .into_iter()
        .all(|binary| path.join(binary).is_file())
}

async fn run_and_log(command: &mut Command, log_path: &Path) -> Result<()> {
    let output = command
        .output()
        .await
        .context("Failed to spawn external command")?;

    let mut combined = Vec::new();
    combined.extend_from_slice(&output.stdout);
    combined.extend_from_slice(&output.stderr);
    fs::write(log_path, &combined)
        .with_context(|| format!("Failed to write {}", log_path.display()))?;

    if !output.status.success() {
        anyhow::bail!(
            "Command failed with status {:?}; see {}",
            output.status.code(),
            log_path.display()
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use tempfile::tempdir;

    #[test]
    fn finds_deb_package_in_dist_dir() -> Result<()> {
        let temp = tempdir()?;
        let pkg_path = temp.path().join("factory-desktop_0.108.0_amd64.deb");
        fs::write(&pkg_path, b"deb")?;

        let found = find_package_in(temp.path())?;
        assert_eq!(found, pkg_path);
        Ok(())
    }

    #[test]
    fn returns_error_when_dist_has_no_native_package() -> Result<()> {
        let temp = tempdir()?;
        fs::write(temp.path().join("README.txt"), b"no packages here")?;

        let error = find_package_in(temp.path()).expect_err("package discovery should fail");
        assert!(error.to_string().contains("No native package (.deb)"));
        Ok(())
    }

    #[test]
    fn build_command_path_includes_system_dirs() {
        let path = build_command_path(Path::new("/tmp/missing-builder"));
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();

        assert!(directories.iter().any(|dir| dir == Path::new("/usr/bin")));
        assert!(directories.iter().any(|dir| dir == Path::new("/bin")));
    }

    #[test]
    fn build_command_path_prefers_packaged_managed_node_runtime() -> Result<()> {
        let temp = tempdir()?;
        let runtime_bin = temp.path().join("node-runtime/bin");
        fs::create_dir_all(&runtime_bin)?;
        for binary in ["node", "npm", "npx"] {
            fs::write(runtime_bin.join(binary), b"bin")?;
        }

        let path = build_command_path(temp.path());
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(directories.first(), Some(&runtime_bin));
        Ok(())
    }

    #[test]
    fn is_native_package_file_detects_deb() {
        assert!(is_native_package_file(Path::new(
            "factory-desktop_0.108.0_amd64.deb"
        )));
        assert!(!is_native_package_file(Path::new("README.txt")));
        assert!(!is_native_package_file(Path::new(
            "factory-desktop-0.108.0.AppImage"
        )));
    }

    #[test]
    fn copy_builder_bundle_fails_on_missing_required_entry() -> Result<()> {
        let temp = tempdir()?;
        let source = temp.path().join("source");
        let dest = temp.path().join("dest");
        fs::create_dir_all(&source)?;

        let error =
            copy_builder_bundle(&source, &dest).expect_err("should fail on missing entries");
        assert!(error
            .to_string()
            .contains("Required builder bundle path is missing"));
        Ok(())
    }
}
