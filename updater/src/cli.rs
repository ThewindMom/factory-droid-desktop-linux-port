//! Command-line interface definition for the updater binary.

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "factory-update-manager")]
#[command(about = "Local update manager for Factory Desktop on Linux")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
/// Top-level commands supported by the updater binary.
pub enum Commands {
    /// Run the resident daemon that checks for and applies updates.
    Daemon,
    /// Check for an upstream update now.
    CheckNow {
        #[arg(long, default_value_t = false)]
        if_stale: bool,
    },
    /// Show the current updater state.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Install the already rebuilt update package, if one is ready.
    InstallReady,
    /// Roll back to the last retained known-good package.
    Rollback,
    /// Install a Debian package (.deb) with elevated privileges.
    InstallDeb {
        #[arg(long)]
        path: PathBuf,
        /// Path to write a result sentinel file ("success\n" or "failure\n<msg>")
        /// after the install completes. Used by the daemon to detect completion
        /// of installs launched via systemd-run transient units.
        #[arg(long)]
        result_file: Option<PathBuf>,
    },
    /// Install a Debian package as an explicit rollback with elevated privileges.
    InstallRollbackDeb {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        result_file: Option<PathBuf>,
    },
}
