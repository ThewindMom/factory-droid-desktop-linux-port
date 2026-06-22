//! Logging setup for the updater daemon.

use anyhow::{Context, Result};
use std::{fs::OpenOptions, path::Path};
use tracing_subscriber::fmt::writer::BoxMakeWriter;

/// Installs a file-backed tracing subscriber for the updater process.
pub fn init(log_file: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .with_context(|| format!("Failed to open log file {}", log_file.display()))?;

    let writer = BoxMakeWriter::new(file);
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .context("Failed to install tracing subscriber")?;
    Ok(())
}
