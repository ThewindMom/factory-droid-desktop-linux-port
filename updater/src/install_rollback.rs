//! Explicit rollback package installation helpers.

use crate::install::{stable_validated_package, PackageKind};
use anyhow::{Context, Result};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const INSTALLED_UPDATER_BINARY: &str = "/usr/bin/factory-update-manager";
const APT_CANDIDATES: &[&str] = &["/usr/bin/apt", "/bin/apt"];
const DPKG_CANDIDATES: &[&str] = &["/usr/bin/dpkg", "/bin/dpkg"];

pub fn install_deb(path: &Path) -> Result<()> {
    let stable = stable_validated_package(path).with_context(|| {
        format!(
            "Failed to stabilize Debian rollback package {}",
            path.display()
        )
    })?;

    if program_exists(APT_CANDIDATES, "apt") {
        let mut command = apt_command(stable.path())?;
        run_install(&mut command).context("apt rollback install failed")?;
        return Ok(());
    }

    let mut command = dpkg_command(stable.path());
    run_install(&mut command).context("dpkg rollback install failed")
}

pub fn pkexec_command(current_exe: &Path, package_path: &Path) -> Command {
    let updater_binary = updater_binary_for_privileged_install(current_exe);
    let subcommand = "install-rollback-deb";
    let _ = PackageKind::from_path(package_path);
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
    let status = command
        .status()
        .context("Failed to execute rollback installation command")?;
    anyhow::ensure!(
        status.success(),
        "rollback installation command exited with {status}"
    );
    Ok(())
}

fn apt_command(path: &Path) -> Result<Command> {
    let parent = package_parent(path, "apt rollback")?;
    let file_name = package_file_name(path, "apt rollback")?;
    let mut command = Command::new(program_path(APT_CANDIDATES, "apt"));
    command
        .current_dir(parent)
        .args(["install", "-y", "--allow-downgrades"])
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn dpkg_command(path: &Path) -> Command {
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

fn updater_binary_for_privileged_install(current_exe: &Path) -> PathBuf {
    let installed = PathBuf::from(INSTALLED_UPDATER_BINARY);
    if installed.is_file() {
        installed
    } else {
        current_exe.to_path_buf()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_local_apt_rollback_command() -> Result<()> {
        let command = apt_command(Path::new("/tmp/build/factory.deb"))?;
        assert!(command.get_program().to_string_lossy().ends_with("apt"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["install", "-y", "--allow-downgrades", "./factory.deb"]
        );
        Ok(())
    }

    #[test]
    fn direct_rollback_commands_stop_option_parsing() {
        assert_eq!(
            command_args(dpkg_command(Path::new("-evil.deb"))),
            vec!["-i", "--", "-evil.deb"]
        );
    }

    fn command_args(command: Command) -> Vec<String> {
        command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn builds_pkexec_command_for_privileged_rollback() {
        let command = pkexec_command(
            Path::new("/usr/bin/factory-update-manager"),
            Path::new("/tmp/factory.deb"),
        );
        let args: Vec<String> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"install-rollback-deb".to_string()));
        assert!(args.contains(&"--path".to_string()));
    }
}
