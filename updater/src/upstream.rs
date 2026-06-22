//! Upstream DMG metadata and download helpers.
//!
//! Factory Desktop uses a redirect API (`https://app.factory.ai/api/desktop`)
//! that returns a 30x to a presigned S3 URL containing the version:
//!   https://s3.../releases/{version}/darwin/{arch}/Factory-{version}-{arch}.dmg
//!
//! Unlike the reference's stable DMG URL with ETag headers, Factory's
//! "fingerprint" is the resolved version + content-length. We HEAD the API,
//! follow redirects, and parse the version from the final URL.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, Client};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::{fs::File, io::AsyncWriteExt};

/// Parses the Factory Desktop version from a presigned S3 redirect URL.
///
/// Matches the path segment `releases/{version}/darwin/` by string search,
/// mirroring the TypeScript `dmg-fetcher.ts` regex `/\/releases\/(\d+\.\d+\.\d+)\//`.

#[derive(Debug, Clone, PartialEq, Eq)]
/// Selected HTTP metadata used to detect upstream DMG changes.
pub struct RemoteMetadata {
    /// Factory Desktop version parsed from the redirect URL.
    pub version: String,
    pub content_length: Option<u64>,
    /// Final (post-redirect) download URL.
    pub final_url: String,
    /// Fingerprint used to detect changes: `version={}|content_length={}`.
    pub headers_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Result of downloading the current upstream DMG snapshot.
pub struct DownloadedDmg {
    pub path: PathBuf,
    pub sha256: String,
    /// Factory Desktop version (e.g. "0.108.0").
    pub candidate_version: String,
}

/// Fetches the upstream DMG metadata used to detect candidate updates.
///
/// Sends a GET request to the Factory API URL. The endpoint returns a 302
/// redirect to a presigned S3 URL containing the version. We read the
/// Location header directly (without following the redirect) to get the
/// final URL and parse the version from it.
///
/// We use GET instead of HEAD because Factory's API (app.factory.ai) rejects
/// HEAD requests with 403 Forbidden. The response body is discarded after
/// reading the headers — we only need the redirect Location.
pub async fn fetch_remote_metadata(client: &Client, dmg_api_url: &str) -> Result<RemoteMetadata> {
    let response = client
        .get(dmg_api_url)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {dmg_api_url}"))?;

    // The Factory endpoint returns 302 with a Location header pointing to the
    // presigned S3 URL. Read the Location header directly; if there's no
    // redirect, fall back to the response URL.
    let final_url = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| response.url().to_string());

    // Accept both 2xx (no redirect, final URL is response URL) and 3xx
    // (redirect, final URL is in Location header).
    if !response.status().is_success() && !response.status().is_redirection() {
        return Err(anyhow::anyhow!(
            "GET request for {dmg_api_url} returned error status: {}",
            response.status()
        ));
    }

    let version = parse_version_from_url(&final_url)
        .ok_or_else(|| anyhow!("Could not parse Factory version from redirect URL: {final_url}"))?;

    let content_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let headers_fingerprint = format!(
        "version={}|content_length={}",
        version,
        content_length
            .map(|value| value.to_string())
            .as_deref()
            .unwrap_or("")
    );

    // Discard the response body — we only needed the headers for the redirect.
    // This prevents the connection from lingering.
    let _ = response.bytes().await;

    Ok(RemoteMetadata {
        version,
        content_length,
        final_url,
        headers_fingerprint,
    })
}

/// Downloads the upstream DMG and derives a package version from its hash.
///
/// First calls `fetch_remote_metadata` to resolve the redirect and parse the
/// version, then downloads the DMG body via GET (following redirects to the
/// presigned S3 URL).
pub async fn download_dmg(
    client: &Client,
    dmg_api_url: &str,
    destination_dir: &Path,
    _version_timestamp: DateTime<Utc>,
) -> Result<DownloadedDmg> {
    tokio::fs::create_dir_all(destination_dir)
        .await
        .with_context(|| format!("Failed to create {}", destination_dir.display()))?;

    // Resolve the redirect to get the version and final download URL.
    let metadata = fetch_remote_metadata(client, dmg_api_url).await?;
    let version = metadata.version.clone();
    let final_url = metadata.final_url.clone();

    // Derive the expected filename from the version.
    let filename = format!("Factory-{version}-x64.dmg");
    let destination = destination_dir.join(&filename);
    let mut file = File::create(&destination)
        .await
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    // Download from the final (resolved) URL, not the API URL.
    let response = client
        .get(&final_url)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {final_url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {final_url} returned an error status"))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {dmg_api_url}"))?;
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

    Ok(DownloadedDmg {
        path: destination,
        sha256,
        candidate_version: version,
    })
}

/// Parses the Factory Desktop version from a presigned S3 redirect URL.
///
/// Matches the path segment `releases/{version}/darwin/` by locating the
/// `/releases/` marker and reading digits/dots until the next `/`.
/// Mirrors the TypeScript `dmg-fetcher.ts` regex
/// `/\/releases\/(\d+\.\d+\.\d+)\//`.
pub fn parse_version_from_url(url: &str) -> Option<String> {
    let marker = "/releases/";
    let start = url.find(marker)? + marker.len();
    let rest = &url[start..];
    let end = rest.find('/')?;
    let version = &rest[..end];
    if version.bytes().all(|b| b.is_ascii_digit() || b == b'.') && version.contains('.') {
        Some(version.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use chrono::TimeZone;
    use tempfile::tempdir;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[test]
    fn parses_version_from_factory_redirect_url() {
        let url = "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/releases/0.108.0/darwin/x64/Factory-0.108.0-x64.dmg?X-Amz-Signature=abc";
        assert_eq!(parse_version_from_url(url), Some("0.108.0".to_string()));
    }

    #[test]
    fn returns_none_when_no_version_in_url() {
        let url = "https://example.com/Factory.dmg";
        assert_eq!(parse_version_from_url(url), None);
    }

    #[tokio::test]
    async fn fetches_remote_metadata_from_get() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/desktop"))
            .respond_with(ResponseTemplate::new(302).insert_header(
                "Location",
                "https://s3.example.com/releases/0.108.0/darwin/x64/Factory-0.108.0-x64.dmg",
            ))
            .mount(&server)
            .await;

        // Don't follow redirects — we read the Location header directly.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let metadata =
            fetch_remote_metadata(&client, &format!("{}/api/desktop", server.uri())).await?;
        assert_eq!(metadata.version, "0.108.0");
        assert!(metadata.headers_fingerprint.contains("version=0.108.0"));
        Ok(())
    }

    #[tokio::test]
    async fn downloads_dmg_and_hashes_contents() -> Result<()> {
        let server = MockServer::start().await;
        let body = b"factory-dmg-test-payload";

        // The final download URL is on the mock server itself.
        let final_url = format!("{}/releases/0.108.0/darwin/x64/Factory.dmg", server.uri());

        // download_dmg first does a GET to resolve the redirect, then a GET to download.
        Mock::given(method("GET"))
            .and(path("/api/desktop"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", final_url.as_str()))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/releases/0.108.0/darwin/x64/Factory.dmg"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
            .mount(&server)
            .await;

        // Don't follow redirects — we read the Location header and GET the final URL directly.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let temp = tempdir()?;
        let downloaded = download_dmg(
            &client,
            &format!("{}/api/desktop", server.uri()),
            temp.path(),
            Utc.with_ymd_and_hms(2026, 6, 21, 12, 0, 0).unwrap(),
        )
        .await?;

        assert!(downloaded.path.exists());
        assert_eq!(downloaded.candidate_version, "0.108.0".to_string());
        assert_eq!(
            downloaded.sha256,
            "3ca24ec3d63c35b608f0e4dc7bab25c954ba18a995f49cda99a962e95067b540"
        );
        Ok(())
    }
}
