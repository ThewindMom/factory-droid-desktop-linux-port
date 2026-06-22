/**
 * Official Factory Desktop DMG fetcher.
 *
 * Pulls the official macOS Factory Desktop DMG directly from Factory's own
 * desktop endpoint and stages it under the generated work directory. This
 * removes the need for the user to manually supply `--dmg`.
 *
 * Endpoint:
 *   https://app.factory.ai/api/desktop?platform=darwin&architecture={arm64|x64}
 *
 * The endpoint responds with a 30x redirect to a short-lived presigned S3 URL:
 *   https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/
 *     releases/{version}/darwin/{arch}/Factory-{version}-{arch}.dmg?...
 *
 * The version is parsed from the redirect URL so downstream steps can pin the
 * matching Linux `droid` binary without a separate discovery call.
 *
 * The download streams to disk and computes SHA-256 in a single pass so a
 * 170 MB DMG is only read once. The downloader is injectable for tests.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Factory Desktop download API base. */
export const FACTORY_DESKTOP_API = "https://app.factory.ai/api/desktop";

/** Supported Darwin architectures for the desktop endpoint. */
export type DarwinArch = "arm64" | "x64";

/** Default download timeout (5 minutes — DMGs are ~170 MB). */
export const DEFAULT_DMG_DOWNLOAD_TIMEOUT = 5 * 60 * 1000;

// ─── Types ─────────────────────────────────────────────────────────────────

/** Options for fetching an official Factory Desktop DMG. */
export interface DmgFetchOptions {
  /** Architecture to fetch. */
  arch: DarwinArch;
  /** Destination directory (the work dir). Created if missing. */
  destDir: string;
  /** Download timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional explicit version to assert against the discovered one. */
  expectedVersion?: string;
  /** Injectable downloader (for tests). Defaults to the streaming downloader. */
  downloader?: DmgDownloader;
}

/** Result of fetching a DMG. */
export interface DmgFetchResult {
  /** Whether the fetch succeeded. */
  success: boolean;
  /** Local path to the downloaded DMG. */
  dmgPath: string;
  /** Architecture that was fetched. */
  arch: DarwinArch;
  /** Factory Desktop version parsed from the redirect URL. */
  version: string;
  /** SHA-256 of the downloaded DMG. */
  sha256: string;
  /** Final (post-redirect) download URL. */
  downloadUrl: string;
  /** Bytes downloaded. */
  bytes: number;
  /** Errors encountered. */
  errors: string[];
  /** Warnings. */
  warnings: string[];
}

/**
 * Injectable downloader contract. Resolves the final (post-redirect) URL and
 * streams the body to `destPath`, returning the final URL and byte count.
 */
export type DmgDownloader = (
  apiUrl: string,
  destPath: string,
  timeoutMs: number
) => Promise<{ finalUrl: string; bytes: number }>;

// ─── URL + version parsing ─────────────────────────────────────────────────

/**
 * Build the Factory Desktop API URL for a given architecture.
 */
export function buildDesktopApiUrl(arch: DarwinArch): string {
  return `${FACTORY_DESKTOP_API}?platform=darwin&architecture=${arch}`;
}

/**
 * Parse the Factory Desktop version from a presigned S3 redirect URL.
 *
 * Matches the path segment `releases/{version}/darwin/...`.
 */
export function parseVersionFromRedirectUrl(url: string): string | null {
  const match = url.match(/\/releases\/(\d+\.\d+\.\d+)\//);
  return match ? match[1] : null;
}

/**
 * Validate that a string is a supported Darwin architecture.
 */
export function isValidDarwinArch(arch: string): arch is DarwinArch {
  return arch === "arm64" || arch === "x64";
}

/**
 * Build the expected local filename for a fetched DMG.
 */
export function buildDmgFilename(version: string, arch: DarwinArch): string {
  return `Factory-${version}-${arch}.dmg`;
}

// ─── Streaming downloader ───────────────────────────────────────────────────

/**
 * Default streaming downloader: follows redirects and streams the response
 * body to `destPath`. Returns the final URL (after redirects) and byte count.
 */
export function streamDownload(
  apiUrl: string,
  destPath: string,
  timeoutMs: number
): Promise<{ finalUrl: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(destPath);
    fs.mkdirSync(parentDir, { recursive: true });

    let finalUrl = apiUrl;
    let bytes = 0;

    const doRequest = (url: string): void => {
      const protocol = url.startsWith("https") ? https : http;
      const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
        // Follow redirects (3xx with Location).
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          finalUrl = res.headers.location;
          res.resume();
          doRequest(res.headers.location);
          return;
        }

        if (
          !res.statusCode ||
          res.statusCode < 200 ||
          res.statusCode >= 300
        ) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve({ finalUrl, bytes });
        });
        file.on("error", (err) => {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          reject(err);
        });
      });

      req.on("error", (err) => {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
      req.on("timeout", () => {
        req.destroy();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(new Error(`Download timed out after ${timeoutMs}ms`));
      });
    };

    doRequest(apiUrl);
  });
}

// ─── SHA-256 ───────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 of a file by streaming it.
 */
export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Fetch an official Factory Desktop DMG for the given architecture.
 *
 * Downloads from Factory's desktop endpoint, parses the version from the
 * redirect URL, and computes the SHA-256 of the staged file.
 */
export async function fetchDesktopDmg(
  options: DmgFetchOptions
): Promise<DmgFetchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_DMG_DOWNLOAD_TIMEOUT;
  const downloader = options.downloader ?? streamDownload;

  const apiUrl = buildDesktopApiUrl(options.arch);

  let parsedVersion = "";
  let downloadUrl = "";
  let bytes = 0;

  // Resolve destination path lazily: we need the version for the filename,
  // which we only know after following the redirect. Download to a temp name,
  // then rename once we know the version.
  const tempPath = path.join(options.destDir, `.factory-dmg-${options.arch}.partial`);
  const result: DmgFetchResult = {
    success: false,
    dmgPath: "",
    arch: options.arch,
    version: "",
    sha256: "",
    downloadUrl: "",
    bytes: 0,
    errors,
    warnings,
  };

  try {
    fs.mkdirSync(options.destDir, { recursive: true });
    const outcome = await downloader(apiUrl, tempPath, timeoutMs);
    downloadUrl = outcome.finalUrl;
    bytes = outcome.bytes;

    parsedVersion = parseVersionFromRedirectUrl(downloadUrl) ?? "";
    if (!parsedVersion) {
      warnings.push(
        "Could not parse Factory version from redirect URL; " +
          "downstream version resolution may need --factory-version."
      );
    }

    if (
      options.expectedVersion &&
      parsedVersion &&
      options.expectedVersion !== parsedVersion
    ) {
      warnings.push(
        `Version mismatch: endpoint served ${parsedVersion}, ` +
          `expected ${options.expectedVersion}.`
      );
    }

    // Rename to the final, versioned filename.
    const filename = buildDmgFilename(parsedVersion || "unknown", options.arch);
    const finalPath = path.join(options.destDir, filename);
    fs.renameSync(tempPath, finalPath);

    const sha256 = sha256File(finalPath);

    result.success = true;
    result.dmgPath = finalPath;
    result.version = parsedVersion;
    result.sha256 = sha256;
    result.downloadUrl = downloadUrl;
    result.bytes = bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`DMG fetch failed: ${message}`);
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  return result;
}

/**
 * Human-readable formatter for a DMG fetch result.
 */
export function formatDmgFetchResult(result: DmgFetchResult): string {
  const lines: string[] = [];
  lines.push(`DMG fetch ${result.success ? "succeeded" : "failed"}`);
  if (result.success) {
    lines.push(`  Path:     ${result.dmgPath}`);
    lines.push(`  Arch:     ${result.arch}`);
    lines.push(`  Version:  ${result.version || "(unknown)"}`);
    lines.push(`  SHA-256:  ${result.sha256.substring(0, 16)}...`);
    lines.push(`  Bytes:    ${result.bytes}`);
    lines.push(`  URL:      ${result.downloadUrl.split("?")[0]}`);
  }
  for (const w of result.warnings) lines.push(`  Warning:  ${w}`);
  for (const e of result.errors) lines.push(`  Error:    ${e}`);
  return lines.join("\n");
}
