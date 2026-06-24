//! Installation helpers for privileged and non-privileged package application.

use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

const PACKAGE_NAME: &str = "factory-desktop";
const INSTALLED_UPDATER_BINARY: &str = "/usr/bin/factory-update-manager";
const APT_CANDIDATES: &[&str] = &["/usr/bin/apt", "/bin/apt"];
const DPKG_CANDIDATES: &[&str] = &["/usr/bin/dpkg", "/bin/dpkg"];
const DPKG_DEB_CANDIDATES: &[&str] = &["/usr/bin/dpkg-deb", "/bin/dpkg-deb"];
const DPKG_QUERY_CANDIDATES: &[&str] = &["/usr/bin/dpkg-query", "/bin/dpkg-query"];

/// The native package format in use on the current system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageKind {
    Deb,
}

#[allow(dead_code)]
impl PackageKind {
    pub fn detect() -> Self {
        // Factory Desktop currently ships .deb + AppImage. The updater only
        // installs .deb natively (AppImage is a portable file, not installed
        // via a package manager). RPM/Pacman support is deferred.
        PackageKind::Deb
    }

    pub fn from_path(path: &Path) -> Self {
        // Only .deb is supported for native installation.
        let _ = path;
        PackageKind::Deb
    }
}

/// Returns the currently installed package version when available.
pub fn installed_package_version() -> String {
    installed_deb_version()
}

/// Returns whether the primary native package still appears to be installed.
pub fn is_primary_package_installed() -> bool {
    installed_package_version() != "unknown"
}

fn installed_deb_version() -> String {
    installed_version_from_command(
        &program_path(DPKG_QUERY_CANDIDATES, "dpkg-query"),
        &["-W", "-f=${Version}", PACKAGE_NAME],
    )
}

fn installed_version_from_command(program: &Path, args: &[&str]) -> String {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if version.is_empty() {
                "unknown".to_string()
            } else {
                version
            }
        }
        _ => "unknown".to_string(),
    }
}

/// Installs a rebuilt Debian package on the local machine.
pub fn install_deb(path: &Path) -> Result<()> {
    let stable = stable_validated_package(path)
        .with_context(|| format!("Failed to stabilize Debian package {}", path.display()))?;
    ensure_upgrade_path(stable.path())?;

    if program_exists(APT_CANDIDATES, "apt") {
        let mut command = apt_install_command(stable.path())?;
        run_install(&mut command).context("apt install failed")?;
        return Ok(());
    }

    let mut command = dpkg_install_command(stable.path());
    run_install(&mut command).context("dpkg -i failed")
}

/// Builds the `pkexec` command used for privileged package installation.
pub fn pkexec_command(current_exe: &Path, package_path: &Path) -> Command {
    let updater_binary = updater_binary_for_privileged_install(current_exe);
    let subcommand = "install-deb";
    let mut command = Command::new("pkexec");
    command
        .arg("--disable-internal-agent")
        .arg(updater_binary)
        .arg(subcommand)
        .arg("--path")
        .arg(package_path);
    command
}

fn run_install(command: &mut Command) -> Result<()> {
    let output = command
        .output()
        .context("Failed to execute installation command")?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut message = format!("installation command exited with {}", output.status);
    if !stderr.trim().is_empty() {
        message.push_str(": ");
        message.push_str(stderr.trim());
    } else if !stdout.trim().is_empty() {
        message.push_str(": ");
        message.push_str(stdout.trim());
    }
    anyhow::bail!(message);
}
pub(crate) struct StablePackage {
    #[allow(dead_code)]
    dir: PathBuf,
    path: PathBuf,
}

impl StablePackage {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// Copies the package into a stable temp directory and validates it exists.
///
/// Some package managers (apt) refuse paths containing certain characters
/// or paths in certain directories. This normalizes the path.
pub(crate) fn stable_validated_package(path: &Path) -> Result<StablePackage> {
    if !path.exists() {
        anyhow::bail!("Package file does not exist: {}", path.display());
    }

    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;

    // If the parent directory is already stable (no problematic characters),
    // use the path directly. Otherwise copy to a temp dir.
    let parent_str = parent.to_string_lossy();
    if !parent_str.contains(' ')
        && !parent_str.contains('\'')
        && !parent_str.contains('"')
        && parent_str.starts_with('/')
    {
        return Ok(StablePackage {
            dir: parent.to_path_buf(),
            path: path.to_path_buf(),
        });
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let temp_dir = std::env::temp_dir().join(format!("factory-update-{timestamp}"));
    #[cfg(unix)]
    {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&temp_dir)
            .with_context(|| format!("Failed to create {}", temp_dir.display()))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(&temp_dir)
            .with_context(|| format!("Failed to create {}", temp_dir.display()))?;
    }

    let stable_path = temp_dir.join(path.file_name().unwrap_or_default());
    fs::copy(path, &stable_path).with_context(|| {
        format!(
            "Failed to copy {} to {}",
            path.display(),
            stable_path.display()
        )
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(&stable_path, fs::Permissions::from_mode(0o644))
            .with_context(|| format!("Failed to set permissions on {}", stable_path.display()))?;
    }

    Ok(StablePackage {
        dir: temp_dir,
        path: stable_path,
    })
}

fn ensure_upgrade_path(path: &Path) -> Result<()> {
    // Validate the package can be read by dpkg-deb
    if program_exists(DPKG_DEB_CANDIDATES, "dpkg-deb") {
        let status = Command::new(program_path(DPKG_DEB_CANDIDATES, "dpkg-deb"))
            .arg("--info")
            .arg(path)
            .status()
            .context("Failed to run dpkg-deb --info")?;
        anyhow::ensure!(
            status.success(),
            "dpkg-deb --info failed for {}",
            path.display()
        );
    }
    Ok(())
}

fn apt_install_command(path: &Path) -> Result<Command> {
    let parent = package_parent(path, "apt install")?;
    let file_name = package_file_name(path, "apt install")?;
    let mut command = Command::new(program_path(APT_CANDIDATES, "apt"));
    command
        .current_dir(parent)
        .args(["install", "-y", "--allow-downgrades"])
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn dpkg_install_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(DPKG_CANDIDATES, "dpkg"));
    command.arg("-i").arg("--").arg(path.as_os_str());
    command
}

fn package_parent<'a>(path: &'a Path, label: &str) -> Result<&'a Path> {
    path.parent()
        .with_context(|| format!("{label} package path has no parent directory"))
}

fn package_file_name(path: &Path, label: &str) -> Result<String> {
    Ok(path
        .file_name()
        .with_context(|| format!("{label} package path has no file name"))?
        .to_string_lossy()
        .into_owned())
}

fn program_path(candidates: &[&str], fallback: &str) -> PathBuf {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn program_exists(candidates: &[&str], name: &str) -> bool {
    candidates.iter().map(Path::new).any(|path| path.is_file()) || command_exists(name)
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path).any(|entry| {
                let candidate: PathBuf = entry.join(name);
                candidate.is_file()
            })
        })
        .unwrap_or(false)
}

fn updater_binary_for_privileged_install(current_exe: &Path) -> PathBuf {
    let installed = PathBuf::from(INSTALLED_UPDATER_BINARY);
    if installed.is_file() {
        installed
    } else {
        current_exe.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpkg_install_command_stops_option_parsing() {
        let command = dpkg_install_command(Path::new("-evil.deb"));
        let args: Vec<String> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, vec!["-i", "--", "-evil.deb"]);
    }

    #[test]
    fn apt_install_command_uses_relative_path() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let deb_path = temp.path().join("factory.deb");
        std::fs::write(&deb_path, b"deb")?;
        let command = apt_install_command(&deb_path)?;
        assert!(command.get_program().to_string_lossy().ends_with("apt"));
        let args: Vec<String> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["install", "-y", "--allow-downgrades", "./factory.deb"]
        );
        Ok(())
    }

    #[test]
    fn pkexec_command_targets_install_deb() {
        let command = pkexec_command(
            Path::new("/usr/bin/factory-update-manager"),
            Path::new("/tmp/factory.deb"),
        );
        let args: Vec<String> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"install-deb".to_string()));
        assert!(args.contains(&"--path".to_string()));
        assert!(args.contains(&"/tmp/factory.deb".to_string()));
    }
}
