/**
 * Linux droid resolver: downloads the Linux x86_64 Factory CLI `droid`
 * binary, verifies its checksum, checks ELF format, executable permissions,
 * and runs --version. Supports version policy with explicit fallback.
 *
 * Fulfills: VAL-EXTRACT-006, VAL-EXTRACT-009
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { classifyBinary, BinaryType } from "./runtime-classifier";

/** Factory CLI Linux x64 download URL template */
export const DROID_DOWNLOAD_URL_TEMPLATE =
  "https://downloads.factory.ai/factory-cli/releases/{version}/linux/x64/droid";

/** Factory CLI Linux x64 SHA-256 download URL template */
export const DROID_SHA256_URL_TEMPLATE =
  "https://downloads.factory.ai/factory-cli/releases/{version}/linux/x64/droid.sha256";

/** Default download timeout in milliseconds */
export const DEFAULT_DOWNLOAD_TIMEOUT = 120000;

/** Version policy for droid resolution */
export enum VersionPolicy {
  /** Require exact version match; fail if unavailable */
  Exact = "exact",
  /** Prefer exact match, allow latest-compatible fallback with explicit recording */
  FallbackToLatest = "fallback-to-latest",
}

/** Droid resolution result */
export interface DroidResolutionResult {
  /** Whether resolution succeeded */
  success: boolean;
  /** Path to the downloaded droid binary */
  droidPath?: string;
  /** SHA-256 hash of the downloaded binary */
  droidHash?: string;
  /** Resolved droid version (from --version output) */
  droidVersion?: string;
  /** Requested Factory Desktop version */
  requestedVersion?: string;
  /** Whether the version is an exact match or fallback */
  versionMatch: "exact" | "fallback" | "unknown";
  /** Checksum verification result */
  checksumVerified: boolean;
  /** Checksum source URL or "none" */
  checksumSource?: string;
  /** ELF classification verified */
  elfVerified: boolean;
  /** Executable permission set */
  executableSet: boolean;
  /** --version ran successfully */
  versionRan: boolean;
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/**
 * Download a file from a URL with timeout.
 */
function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    // Ensure parent directory exists
    const parentDir = path.dirname(destPath);
    fs.mkdirSync(parentDir, { recursive: true });

    const file = fs.createWriteStream(destPath);

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      // Handle redirects
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        downloadFile(res.headers.location, destPath, timeoutMs)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        file.close();
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      res.pipe(file);

      file.on("finish", () => {
        file.close();
        resolve();
      });

      file.on("error", (err) => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(err);
      });
    });

    req.on("error", (err) => {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(new Error(`Download timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Fetch text content from a URL.
 */
function fetchTextUrl(
  url: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Compute SHA-256 hash of a file.
 */
function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Build the download URL for a specific Factory CLI version.
 */
export function buildDroidDownloadUrl(version: string): string {
  return DROID_DOWNLOAD_URL_TEMPLATE.replace("{version}", version);
}

/**
 * Build the SHA-256 checksum URL for a specific Factory CLI version.
 */
export function buildDroidSha256Url(version: string): string {
  return DROID_SHA256_URL_TEMPLATE.replace("{version}", version);
}

/**
 * Parse a SHA-256 checksum file content.
 *
 * Expected formats:
 * - `<hash>  <filename>` (sha256sum output format)
 * - `<hash>` (bare hash)
 */
export function parseChecksumFile(content: string): {
  hash: string;
  filename?: string;
} | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Try sha256sum format: <hash>  <filename>
  const parts = trimmed.split(/\s+/);
  const hashPart = parts[0];

  // Validate it looks like a SHA-256 hash
  if (/^[a-f0-9]{64}$/i.test(hashPart)) {
    return {
      hash: hashPart.toLowerCase(),
      filename: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
    };
  }

  return null;
}

/**
 * Verify droid --version output.
 *
 * @param droidPath - Path to the droid binary
 * @returns Version string or undefined on failure
 */
export function getDroidVersion(droidPath: string): string | undefined {
  try {
    const output = execSync(`"${droidPath}" --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    }).trim();

    // Extract version from output (could be "0.106.0" or "droid 0.106.0" etc.)
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    return versionMatch ? versionMatch[1] : output;
  } catch {
    return undefined;
  }
}

/**
 * Resolve and download the Linux x86_64 droid binary.
 *
 * VAL-EXTRACT-006: For the selected Factory version, the builder CLI
 * must resolve a Linux x86_64 droid binary according to the configured
 * version policy and verify that it runs successfully. The command
 * passes only if the reported droid version is matching or explicitly
 * recorded as an allowed fallback; otherwise it exits non-zero.
 *
 * VAL-EXTRACT-009: When a Linux droid binary is downloaded and a
 * matching .sha256 endpoint is available, the builder must verify the
 * downloaded file against that checksum before using it.
 *
 * @param requestedVersion - The Factory Desktop version to match
 * @param outputDir - Directory to save the droid binary
 * @param options - Additional options
 */
export async function resolveDroid(
  requestedVersion: string,
  outputDir: string,
  options: {
    /** Version policy (default: FallbackToLatest) */
    versionPolicy?: VersionPolicy;
    /** Download timeout in ms */
    timeoutMs?: number;
    /** Override download URL (for testing) */
    downloadUrlOverride?: string;
    /** Override checksum URL (for testing) */
    checksumUrlOverride?: string;
    /** Override latest version URL to try for fallback (for testing) */
    fallbackLatestUrl?: string;
  } = {}
): Promise<DroidResolutionResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const timeoutMs = options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT;
  const versionPolicy =
    options.versionPolicy || VersionPolicy.FallbackToLatest;

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const droidDestPath = path.join(outputDir, "droid");

  // Step 1: Try to download the exact version
  const exactUrl =
    options.downloadUrlOverride || buildDroidDownloadUrl(requestedVersion);
  let downloadVersion = requestedVersion;
  let versionMatch: "exact" | "fallback" | "unknown" = "exact";

  try {
    await downloadFile(exactUrl, droidDestPath, timeoutMs);
  } catch (exactErr) {
    const exactMessage =
      exactErr instanceof Error ? exactErr.message : String(exactErr);

    // Exact version download failed
    if (versionPolicy === VersionPolicy.Exact) {
      return {
        success: false,
        requestedVersion,
        versionMatch: "unknown",
        checksumVerified: false,
        elfVerified: false,
        executableSet: false,
        versionRan: false,
        errors: [
          `Failed to download droid for version ${requestedVersion}: ${exactMessage}. ` +
            `Version policy is set to "exact" and no fallback is allowed.`,
        ],
        warnings: [],
      };
    }

    // Fallback: try latest
    warnings.push(
      `Exact version droid download failed (${exactMessage}). ` +
        `Attempting fallback to latest-compatible version per policy.`
    );

    // Try to discover the latest available version
    const latestUrl =
      options.fallbackLatestUrl ||
      buildDroidDownloadUrl("latest");

    try {
      // Clean up failed download
      if (fs.existsSync(droidDestPath)) {
        fs.unlinkSync(droidDestPath);
      }
      await downloadFile(latestUrl, droidDestPath, timeoutMs);
      downloadVersion = "latest";
      versionMatch = "fallback";
    } catch (fallbackErr) {
      const fallbackMessage =
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr);

      return {
        success: false,
        requestedVersion,
        versionMatch: "unknown",
        checksumVerified: false,
        elfVerified: false,
        executableSet: false,
        versionRan: false,
        errors: [
          `Failed to download droid for version ${requestedVersion}: ${exactMessage}.`,
          `Fallback to latest also failed: ${fallbackMessage}.`,
        ],
        warnings,
      };
    }
  }

  // Step 2: Verify checksum (VAL-EXTRACT-009)
  let checksumVerified = false;
  let checksumSource: string | undefined;

  const checksumUrl =
    options.checksumUrlOverride || buildDroidSha256Url(downloadVersion);

  try {
    const checksumContent = await fetchTextUrl(checksumUrl, timeoutMs);
    const parsed = parseChecksumFile(checksumContent);

    if (parsed) {
      const actualHash = computeSha256(droidDestPath);
      checksumSource = checksumUrl;

      if (actualHash === parsed.hash) {
        checksumVerified = true;
      } else {
        // Checksum mismatch - this is a fatal error
        if (fs.existsSync(droidDestPath)) {
          fs.unlinkSync(droidDestPath);
        }
        return {
          success: false,
          droidHash: actualHash,
          requestedVersion,
          versionMatch,
          checksumVerified: false,
          checksumSource,
          elfVerified: false,
          executableSet: false,
          versionRan: false,
          errors: [
            `Checksum verification failed for droid binary. ` +
              `Expected: ${parsed.hash}, Actual: ${actualHash}. ` +
              `The downloaded binary has been removed. ` +
              `Checksum source: ${checksumSource}`,
          ],
          warnings,
        };
      }
    } else {
      // Could not parse checksum file
      warnings.push(
        `Checksum file available at ${checksumUrl} but could not be parsed. ` +
          `Skipping checksum verification.`
      );
      checksumSource = checksumUrl;
    }
  } catch (checksumErr) {
    // Checksum endpoint not available or failed
    warnings.push(
      `Checksum verification could not be performed: ` +
        `${checksumErr instanceof Error ? checksumErr.message : String(checksumErr)}. ` +
        `Proceeding without checksum verification.`
    );
    checksumSource = "none";
  }

  // Step 3: Verify ELF classification
  const classification = classifyBinary(droidDestPath);
  const elfVerified =
    classification.type === BinaryType.ELF &&
    classification.architecture === "x86_64";

  if (classification.type !== BinaryType.ELF) {
    errors.push(
      `Downloaded droid is not a Linux ELF binary: ${classification.type} ` +
        `(file output: ${classification.fileOutput || "N/A"}). ` +
        `Cannot use this binary for Linux packaging.`
    );
  } else if (classification.architecture !== "x86_64") {
    errors.push(
      `Downloaded droid is ELF but architecture is ${classification.architecture}, ` +
        `expected x86_64.`
    );
  }

  // Step 4: Set executable permissions
  let executableSet = false;
  try {
    fs.chmodSync(droidDestPath, 0o755);
    executableSet = true;
  } catch {
    errors.push("Failed to set executable permissions on droid binary.");
  }

  // Step 5: Run --version
  let droidVersion: string | undefined;
  if (elfVerified && executableSet) {
    const version = getDroidVersion(droidDestPath);
    if (version) {
      droidVersion = version;
    } else {
      errors.push(
        `Failed to run "droid --version". The binary may be corrupted or incompatible.`
      );
    }
  }

  const effectiveVersionRan = droidVersion !== undefined;

  // Step 6: Validate version policy (VAL-EXTRACT-006)
  if (droidVersion && versionMatch === "exact") {
    // For exact match, verify the droid version matches
    if (droidVersion !== requestedVersion) {
      if (versionPolicy === VersionPolicy.Exact) {
        errors.push(
          `Droid version "${droidVersion}" does not match requested version "${requestedVersion}". ` +
            `Version policy is set to "exact" and fallback is not allowed.`
        );
      } else {
        warnings.push(
          `Droid version "${droidVersion}" does not match requested version "${requestedVersion}". ` +
            `This is recorded as an allowed fallback per policy.`
        );
        versionMatch = "fallback";
      }
    }
  }

  const droidHash = fs.existsSync(droidDestPath)
    ? computeSha256(droidDestPath)
    : undefined;

  const success =
    errors.length === 0 &&
    (checksumVerified || checksumSource === "none") &&
    elfVerified &&
    executableSet &&
    effectiveVersionRan;

  return {
    success,
    droidPath: success ? droidDestPath : undefined,
    droidHash,
    droidVersion,
    requestedVersion,
    versionMatch,
    checksumVerified,
    checksumSource,
    elfVerified,
    executableSet,
    versionRan: effectiveVersionRan,
    errors,
    warnings,
  };
}

/**
 * Validate an existing droid binary without downloading.
 *
 * Checks ELF format, executable permissions, and --version.
 *
 * @param droidPath - Path to the droid binary
 * @param requestedVersion - Expected version
 * @param options - Additional options
 */
export function validateExistingDroid(
  droidPath: string,
  requestedVersion: string,
  options: {
    /** Version policy */
    versionPolicy?: VersionPolicy;
  } = {}
): DroidResolutionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const versionPolicy =
    options.versionPolicy || VersionPolicy.FallbackToLatest;

  // Check file exists
  if (!fs.existsSync(droidPath)) {
    return {
      success: false,
      requestedVersion,
      versionMatch: "unknown",
      checksumVerified: false,
      elfVerified: false,
      executableSet: false,
      versionRan: false,
      errors: [`Droid binary not found: ${droidPath}`],
      warnings: [],
    };
  }

  // Compute hash
  const droidHash = computeSha256(droidPath);

  // Classify
  const classification = classifyBinary(droidPath);
  const elfVerified =
    classification.type === BinaryType.ELF &&
    classification.architecture === "x86_64";

  if (classification.type === BinaryType.MachO) {
    errors.push(
      `Droid binary is macOS Mach-O (architecture: ${classification.architecture || "unknown"}), ` +
        `not Linux ELF. This binary cannot be used for Linux packaging.`
    );
  } else if (classification.type !== BinaryType.ELF) {
    errors.push(
      `Droid binary is ${classification.type}, expected Linux ELF.`
    );
  } else if (classification.architecture !== "x86_64") {
    errors.push(
      `Droid binary is ELF but architecture is ${classification.architecture}, expected x86_64.`
    );
  }

  // Check executable permission
  let executableSet = false;
  try {
    fs.accessSync(droidPath, fs.constants.X_OK);
    executableSet = true;
  } catch {
    // Try to set executable
    try {
      fs.chmodSync(droidPath, 0o755);
      executableSet = true;
    } catch {
      errors.push("Droid binary is not executable and permissions could not be set.");
    }
  }

  // Run --version
  let droidVersion: string | undefined;
  let versionRan = false;
  if (elfVerified) {
    const version = getDroidVersion(droidPath);
    if (version) {
      droidVersion = version;
      versionRan = true;
    } else {
      errors.push('Failed to run "droid --version".');
    }
  }

  // Check version match
  let versionMatch: "exact" | "fallback" | "unknown" = "unknown";
  if (droidVersion) {
    if (droidVersion === requestedVersion) {
      versionMatch = "exact";
    } else {
      versionMatch = "fallback";
      if (versionPolicy === VersionPolicy.Exact) {
        errors.push(
          `Droid version "${droidVersion}" does not match requested version "${requestedVersion}". ` +
            `Version policy is "exact" and fallback is not allowed.`
        );
      } else {
        warnings.push(
          `Droid version "${droidVersion}" does not match requested version "${requestedVersion}". ` +
            `Recorded as allowed fallback per policy.`
        );
      }
    }
  }

  const success =
    errors.length === 0 && elfVerified && executableSet && versionRan;

  return {
    success,
    droidPath: success ? droidPath : undefined,
    droidHash,
    droidVersion,
    requestedVersion,
    versionMatch,
    checksumVerified: false,
    checksumSource: "none (existing binary)",
    elfVerified,
    executableSet,
    versionRan,
    errors,
    warnings,
  };
}

/**
 * Format a droid resolution result for display.
 */
export function formatDroidResult(result: DroidResolutionResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Linux droid binary resolved successfully.");
  } else {
    lines.push("✗ Linux droid binary resolution failed.");
  }

  if (result.droidPath) {
    lines.push(`  Binary path: ${result.droidPath}`);
  }
  if (result.droidHash) {
    lines.push(`  SHA-256: ${result.droidHash}`);
  }
  if (result.droidVersion) {
    lines.push(`  Droid version: ${result.droidVersion}`);
  }
  if (result.requestedVersion) {
    lines.push(`  Requested version: ${result.requestedVersion}`);
  }

  lines.push(`  Version match: ${result.versionMatch}`);
  lines.push(
    `  Checksum verified: ${result.checksumVerified}` +
      (result.checksumSource ? ` (source: ${result.checksumSource})` : "")
  );
  lines.push(`  ELF verified: ${result.elfVerified}`);
  lines.push(`  Executable: ${result.executableSet}`);
  lines.push(`  --version ran: ${result.versionRan}`);

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}
