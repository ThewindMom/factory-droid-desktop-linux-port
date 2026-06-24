//! Port build update checking: queries GitHub Releases for new port builds
//! and downloads the `.deb` asset.
//!
//! Unlike the upstream DMG check (which downloads a DMG and rebuilds locally),
//! port updates download a pre-built `.deb` from GitHub Releases. This is
//! simpler and faster (no local rebuild), and delivers the latest patches
//! (asar patches, droid resolver, window controls, etc.) to existing installs.
//!
//! The check works by comparing the `portBuildSha` in the installed
//! `build-info.json` against the commit SHA the release tag points to.
//! We query the git ref (not `target_commitish`, which may be a branch name
//! or stale) to get the actual commit SHA.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::{fs::File, io::AsyncWriteExt};

/// Metadata for a GitHub release, fetched from the Releases API.
#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRelease {
    /// The tag name (e.g., "v0.110.0").
    pub tag_name: String,
    /// Release assets (.deb, source code, etc.).
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ReleaseAsset {
    /// Asset name (e.g., "factory-desktop_0.110.0_amd64.deb").
    pub name: String,
    /// Direct download URL for the asset.
    pub browser_download_url: String,
    /// Asset size in bytes.
    #[serde(default)]
    pub size: u64,
}

/// Git ref response from the GitHub API.
#[derive(Debug, Clone, Deserialize)]
struct GitRef {
    object: GitRefObject,
}

#[derive(Debug, Clone, Deserialize)]
struct GitRefObject {
    sha: String,
}

/// Result of checking for a port build update.
#[derive(Debug, Clone)]
pub struct PortUpdateCheck {
    /// The commit SHA the release tag points to.
    pub release_sha: String,
    /// The .deb asset download URL, if a .deb asset was found.
    pub deb_url: Option<String>,
    /// The .deb asset name.
    pub deb_name: Option<String>,
}

/// Result of downloading a port .deb.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DownloadedDeb {
    pub path: PathBuf,
    pub sha256: String,
}

/// Fetch the latest release from the GitHub Releases API.
///
/// Uses the `/repos/{owner}/{repo}/releases/latest` endpoint.
/// Returns `None` if no releases exist.
async fn fetch_latest_release(
    client: &Client,
    owner: &str,
    repo: &str,
) -> Result<Option<GitHubRelease>> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "factory-update-manager")
        .send()
        .await
        .with_context(|| format!("Failed GET request for {url}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let release = response
        .error_for_status()
        .with_context(|| format!("GitHub API request for {url} returned an error status"))?
        .json::<GitHubRelease>()
        .await
        .context("Failed to parse GitHub release JSON response")?;

    Ok(Some(release))
}

/// Fetch the commit SHA a tag points to, via the git refs API.
///
/// Uses `/repos/{owner}/{repo}/git/ref/tags/{tag}`. This reads the actual
/// git ref, not the release's `target_commitish` (which may be a branch name
/// or stale).
async fn fetch_tag_sha(client: &Client, owner: &str, repo: &str, tag: &str) -> Result<String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/ref/tags/{tag}");
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "factory-update-manager")
        .send()
        .await
        .with_context(|| format!("Failed GET request for {url}"))?;

    let git_ref = response
        .error_for_status()
        .with_context(|| format!("GitHub API request for {url} returned an error status"))?
        .json::<GitRef>()
        .await
        .context("Failed to parse GitHub git ref JSON response")?;

    Ok(git_ref.object.sha)
}

/// Check whether a port update is available by comparing the installed
/// build SHA against the commit SHA the release tag points to.
///
/// Returns `Some(PortUpdateCheck)` if a new port build is available,
/// or `None` if the installed build matches the latest release.
pub async fn check_for_port_update(
    client: &Client,
    owner: &str,
    repo: &str,
    installed_port_sha: Option<&str>,
) -> Result<Option<PortUpdateCheck>> {
    let Some(release) = fetch_latest_release(client, owner, repo).await? else {
        return Ok(None);
    };

    let release_sha = fetch_tag_sha(client, owner, repo, &release.tag_name).await?;

    // If the installed build SHA matches the release SHA, no update needed.
    if let Some(installed) = installed_port_sha {
        if installed == release_sha {
            return Ok(None);
        }
    }

    // Find the .deb asset.
    let deb_asset = release
        .assets
        .iter()
        .find(|asset| asset.name.ends_with(".deb"));

    let (deb_url, deb_name) = deb_asset
        .map(|asset| {
            (
                Some(asset.browser_download_url.clone()),
                Some(asset.name.clone()),
            )
        })
        .unwrap_or((None, None));

    Ok(Some(PortUpdateCheck {
        release_sha,
        deb_url,
        deb_name,
    }))
}

/// Download a `.deb` package from a URL and compute its SHA-256.
pub async fn download_deb(
    client: &Client,
    url: &str,
    destination_dir: &Path,
    expected_filename: &str,
) -> Result<DownloadedDeb> {
    tokio::fs::create_dir_all(destination_dir)
        .await
        .with_context(|| format!("Failed to create {}", destination_dir.display()))?;

    let destination = destination_dir.join(expected_filename);
    let mut file = File::create(&destination)
        .await
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    let response = client
        .get(url)
        .header("User-Agent", "factory-update-manager")
        .send()
        .await
        .with_context(|| format!("Failed GET request for {url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {url} returned an error status"))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {url}"))?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("Failed writing {}", destination.display()))?;
        hasher.update(&chunk);
    }

    file.flush()
        .await
        .with_context(|| format!("Failed flushing {}", destination.display()))?;

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(DownloadedDeb {
        path: destination,
        sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_github_release_json() {
        let json = r#"{
            "tag_name": "v0.110.0",
            "target_commitish": "master",
            "assets": [
                {
                    "name": "factory-desktop_0.110.0_amd64.deb",
                    "browser_download_url": "https://github.com/ThewindMom/factory-desktop-linux/releases/download/v0.110.0/factory-desktop_0.110.0_amd64.deb",
                    "size": 131072000
                },
                {
                    "name": "Source code (zip)",
                    "browser_download_url": "https://github.com/ThewindMom/factory-desktop-linux/zipball/v0.110.0",
                    "size": 0
                }
            ]
        }"#;

        let release: GitHubRelease = serde_json::from_str(json).unwrap();
        assert_eq!(release.tag_name, "v0.110.0");
        assert_eq!(release.assets.len(), 2);
        assert_eq!(release.assets[0].name, "factory-desktop_0.110.0_amd64.deb");
        assert!(release.assets[0].browser_download_url.contains(".deb"));
    }

    #[test]
    fn test_parse_release_without_assets() {
        let json = r#"{
            "tag_name": "v0.110.0",
            "assets": []
        }"#;

        let release: GitHubRelease = serde_json::from_str(json).unwrap();
        assert!(release.assets.is_empty());
    }

    #[test]
    fn test_parse_git_ref_json() {
        let json = r#"{
            "ref": "refs/tags/v0.110.0",
            "node_id": "ABC123",
            "url": "https://api.github.com/repos/ThewindMom/factory-desktop-linux/git/refs/tags/v0.110.0",
            "object": {
                "sha": "13e131b6d103af0129821b7209d08bd9cc370599",
                "type": "commit",
            "url": "https://api.github.com/repos/ThewindMom/factory-desktop-linux/git/commits/13e131b6d103af0129821b7209d08bd9cc370599"
            }
        }"#;

        let git_ref: GitRef = serde_json::from_str(json).unwrap();
        assert_eq!(
            git_ref.object.sha,
            "13e131b6d103af0129821b7209d08bd9cc370599"
        );
    }
}
