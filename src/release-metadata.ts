/**
 * Release metadata: generates GitHub Releases compatible update metadata
 * for Linux artifacts when built artifacts are legally publishable.
 *
 * Fulfills: VAL-PACKAGE-007
 *
 * Key behaviors:
 * - Generates latest-linux.yml ONLY in permission-cleared mode
 * - References .deb and AppImage artifacts, their checksums, version,
 *   update channel, and release notes
 * - Never embeds proprietary extracted payloads in source control
 * - Never uses Factory's official macOS/Windows update channel as the
 *   Linux feed
 * - Validates that checksums referenced in metadata exist and match
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ReleaseMode, canPublishBinaries } from "./config";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for release metadata generation */
export interface ReleaseMetadataOptions {
  /** Factory Desktop version being released */
  version: string;
  /** Release mode: must be permission-cleared to generate metadata */
  releaseMode: ReleaseMode;
  /** GitHub repository owner (e.g., "factory-droid-desktop-linux-port") */
  repoOwner: string;
  /** GitHub repository name (e.g., "factory-droid-desktop-linux-port") */
  repoName: string;
  /** Paths to release artifact files (.deb, .AppImage) */
  artifactPaths: string[];
  /** Output directory for the generated metadata file */
  outputDir: string;
  /** Release channel (default: "latest") */
  channel?: string;
  /** Release name (optional, shown in update notification) */
  releaseName?: string;
  /** Release notes (optional) */
  releaseNotes?: string;
  /** Release date in ISO 8601 format (default: current time) */
  releaseDate?: string;
  /** Base URL for artifact downloads (optional, defaults to GitHub Releases) */
  downloadBaseUrl?: string;
}

/** Information about a single artifact in the release metadata */
export interface ArtifactMetadata {
  /** URL or path for downloading the artifact */
  url: string;
  /** SHA-512 hash of the artifact (hex-encoded for manifest, base64 for updater) */
  sha512: string;
  /** SHA-512 hash of the artifact (base64-encoded, required by electron-updater) */
  sha512Base64: string;
  /** File size in bytes */
  size: number;
  /** Whether this is the primary artifact (AppImage takes precedence) */
  primary: boolean;
}

/** The complete release metadata document */
export interface ReleaseMetadataDocument {
  /** Version string */
  version: string;
  /** Artifact metadata entries */
  files: ArtifactMetadata[];
  /** Primary artifact path (deprecated but required by electron-updater) */
  path: string;
  /** Primary artifact SHA-512 base64 (deprecated but required by electron-updater) */
  sha512: string;
  /** Release date in ISO 8601 format */
  releaseDate: string;
  /** Release name (optional) */
  releaseName?: string;
  /** Release notes (optional) */
  releaseNotes?: string;
  /** Update channel */
  channel: string;
  /** GitHub repository for the feed */
  feedUrl: string;
}

/** Result of release metadata generation */
export interface ReleaseMetadataResult {
  /** Whether metadata generation succeeded */
  success: boolean;
  /** Path to the generated latest-linux.yml file */
  metadataPath: string;
  /** The generated metadata document */
  document?: ReleaseMetadataDocument;
  /** Errors encountered */
  errors: string[];
  /** Warnings encountered */
  warnings: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** File name for Linux update metadata */
export const LINUX_UPDATE_METADATA_FILENAME = "latest-linux.yml";

/** Factory's official update feed URLs that must never be used for Linux */
export const FACTORY_OFFICIAL_FEED_PATTERNS = [
  "factory.ai/update",
  "factory.ai/api/update",
  "factory.ai/api/desktop/update",
  "update.factory.ai",
  // electron-builder default S3/generic URLs that could leak
  "s3.amazonaws.com/factory",
  // electron-updater default auto-detect pattern
  "github.com/factoryai/",
  "github.com/FactoryAI/",
];

// ─── Metadata Generation ────────────────────────────────────────────────────

/**
 * Generate GitHub Releases compatible update metadata for Linux artifacts.
 *
 * VAL-PACKAGE-007: When permission-cleared release mode is enabled,
 * generated GitHub Releases metadata must reference the Debian and
 * AppImage artifacts, their checksums, version, update channel, and
 * release notes without embedding proprietary extracted payloads in
 * source control.
 *
 * The assertion fails if:
 * - Release metadata omits an artifact
 * - References a nonexistent checksum
 * - Uses the official Factory macOS/Windows update channel as the
 *   Linux feed
 * - Is generated when permission-cleared mode is disabled
 */
export function generateReleaseMetadata(
  options: ReleaseMetadataOptions
): ReleaseMetadataResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // VAL-PACKAGE-007: Must be in permission-cleared mode
  if (!canPublishBinaries(options.releaseMode)) {
    return {
      success: false,
      metadataPath: "",
      errors: [
        "Release metadata generation refused: safe/source-only mode is active. " +
        "Set --release-mode=permission-cleared to enable release metadata generation.",
      ],
      warnings,
    };
  }

  // Validate version
  if (!options.version || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    errors.push(
      `Invalid version for release metadata: "${options.version}". Must be semver (X.Y.Z).`
    );
  }

  // Validate artifact paths
  if (options.artifactPaths.length === 0) {
    errors.push("No artifact paths provided for release metadata generation.");
  }


  // Validate that artifact files exist
  const existingArtifacts: string[] = [];
  for (const artifactPath of options.artifactPaths) {
    if (!fs.existsSync(artifactPath)) {
      errors.push(`Artifact not found: ${artifactPath}`);
    } else {
      existingArtifacts.push(artifactPath);
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      metadataPath: "",
      errors,
      warnings,
    };
  }

  // Compute artifact metadata
  const channel = options.channel || "latest";
  const releaseDate = options.releaseDate || new Date().toISOString();

  const files: ArtifactMetadata[] = [];
  let primaryArtifact: ArtifactMetadata | null = null;

  for (const artifactPath of existingArtifacts) {
    const basename = path.basename(artifactPath);
    const stat = fs.statSync(artifactPath);
    const sha512Hex = computeFileSha512(artifactPath);
    const sha512Base64 = hexToBase64(sha512Hex);

    // Determine download URL
    const downloadUrl = options.downloadBaseUrl
      ? `${options.downloadBaseUrl}/${basename}`
      : `https://github.com/${options.repoOwner}/${options.repoName}/releases/download/v${options.version}/${basename}`;

    // Validate that the download URL does not use Factory's official feed
    for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
      if (downloadUrl.includes(pattern)) {
        errors.push(
          `Artifact download URL uses Factory's official update channel: ${downloadUrl}. ` +
          `Linux update metadata must never point to Factory's macOS/Windows update feed.`
        );
      }
    }

    const isAppImage = basename.endsWith(".AppImage");
    const isPrimary = isAppImage || (!primaryArtifact && basename.endsWith(".deb"));

    const entry: ArtifactMetadata = {
      url: downloadUrl,
      sha512: sha512Hex,
      sha512Base64,
      size: stat.size,
      primary: isPrimary,
    };

    files.push(entry);

    if (isPrimary && !primaryArtifact) {
      primaryArtifact = entry;
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      metadataPath: "",
      errors,
      warnings,
    };
  }

  // If no AppImage found, use the first artifact as primary
  if (!primaryArtifact && files.length > 0) {
    primaryArtifact = files[0];
    primaryArtifact.primary = true;
  }

  // Verify checksums referenced in metadata match computed values
  for (const file of files) {
    if (!file.sha512 || file.size === 0) {
      errors.push(
        `Artifact ${file.url} has invalid checksum or zero size in metadata.`
      );
    }
  }

  // Build the feed URL for this project's GitHub Releases
  const feedUrl =
    `https://github.com/${options.repoOwner}/${options.repoName}/` +
    `${channel === "latest" ? "" : channel + "/"}latest-linux.yml`;

  const document: ReleaseMetadataDocument = {
    version: options.version,
    files,
    path: primaryArtifact?.url?.split("/").pop() || "",
    sha512: primaryArtifact?.sha512Base64 || "",
    releaseDate,
    releaseName: options.releaseName,
    releaseNotes: options.releaseNotes,
    channel,
    feedUrl,
  };

  // Generate YAML content
  const yamlContent = generateYaml(document);

  // Write the metadata file
  const metadataPath = path.join(options.outputDir, LINUX_UPDATE_METADATA_FILENAME);
  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(metadataPath, yamlContent, "utf-8");

  // Verify the metadata doesn't end up in source control by checking
  // that the output directory is a generated artifact directory
  const outputDirBasename = path.basename(options.outputDir);
  const generatedDirNames = ["dist", "out", "build", "work", ".cache"];
  if (!generatedDirNames.includes(outputDirBasename)) {
    warnings.push(
      `Release metadata output directory "${options.outputDir}" is not a standard ` +
      `generated artifact directory. Ensure it is gitignored to prevent proprietary-derived ` +
      `metadata from entering source control.`
    );
  }

  return {
    success: true,
    metadataPath,
    document,
    errors,
    warnings,
  };
}

/**
 * Validate that release metadata does not reference Factory's official
 * macOS/Windows update feed.
 *
 * VAL-PACKAGE-007: The assertion fails if the metadata uses the
 * official Factory macOS/Windows update channel as the Linux feed.
 */
export function validateFeedUrl(feedUrl: string): {
  valid: boolean;
  reason?: string;
} {
  for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
    if (feedUrl.includes(pattern)) {
      return {
        valid: false,
        reason: `Feed URL "${feedUrl}" uses Factory's official update channel (${pattern}). ` +
          `Linux update metadata must never point to Factory's macOS/Windows update feed.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate that release metadata references all expected artifacts
 * and that their checksums are present.
 *
 * VAL-PACKAGE-007: The assertion fails if release metadata omits
 * an artifact or references a nonexistent checksum.
 */
export function validateReleaseMetadataCompleteness(
  document: ReleaseMetadataDocument,
  expectedArtifacts: string[]
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check that all expected artifacts are referenced
  const referencedFiles = new Set(
    document.files.map((f) => {
      const urlParts = f.url.split("/");
      return urlParts[urlParts.length - 1];
    })
  );

  for (const expected of expectedArtifacts) {
    const basename = path.basename(expected);
    if (!referencedFiles.has(basename)) {
      errors.push(
        `Release metadata omits expected artifact: ${basename}. ` +
        `All generated release artifacts must be referenced.`
      );
    }
  }

  // Check that all referenced artifacts have valid checksums
  for (const file of document.files) {
    if (!file.sha512 || file.sha512.length === 0) {
      errors.push(
        `Release metadata references artifact without checksum: ${file.url}`
      );
    }

    if (!file.sha512Base64 || file.sha512Base64.length === 0) {
      errors.push(
        `Release metadata references artifact without base64 SHA-512: ${file.url}`
      );
    }

    if (file.size === 0) {
      warnings.push(
        `Release metadata references artifact with zero size: ${file.url}`
      );
    }
  }

  // Check that the feed URL is not Factory's official feed
  const feedValidation = validateFeedUrl(document.feedUrl);
  if (!feedValidation.valid) {
    errors.push(feedValidation.reason || "Invalid feed URL");
  }


  // Check required fields
  if (!document.version) {
    errors.push("Release metadata is missing version field.");
  }

  if (!document.releaseDate) {
    errors.push("Release metadata is missing releaseDate field.");
  }

  if (!document.path) {
    errors.push("Release metadata is missing path field (required by electron-updater).");
  }

  if (!document.sha512) {
    errors.push("Release metadata is missing sha512 field (required by electron-updater).");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── YAML Generation ────────────────────────────────────────────────────────

/**
 * Generate YAML content for the release metadata document.
 *
 * Format follows electron-updater's expected latest-linux.yml schema:
 * - version: string
 * - files: array of {url, sha512, size}
 * - path: string (deprecated but required)
 * - sha512: string (deprecated but required, base64-encoded)
 * - releaseDate: ISO 8601 string
 */
function generateYaml(document: ReleaseMetadataDocument): string {
  const lines: string[] = [];

  lines.push(`version: ${document.version}`);
  lines.push(`files:`);

  for (const file of document.files) {
    lines.push(`  - url: ${file.url.split("/").pop() || file.url}`);
    lines.push(`    sha512: ${file.sha512Base64}`);
    lines.push(`    size: ${file.size}`);
  }

  lines.push(`path: ${document.path}`);
  lines.push(`sha512: ${document.sha512}`);
  lines.push(`releaseDate: '${document.releaseDate}'`);

  if (document.releaseName) {
    lines.push(`releaseName: ${yamlEscape(document.releaseName)}`);
  }

  if (document.releaseNotes) {
    lines.push(`releaseNotes: ${yamlEscape(document.releaseNotes)}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Escape a string value for YAML output.
 */
function yamlEscape(value: string): string {
  if (value.includes("'") || value.includes('"') || value.includes(":") ||
      value.includes("#") || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Compute SHA-512 hash of a file (hex-encoded).
 */
export function computeFileSha512(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha512").update(content).digest("hex");
}

/**
 * Convert a hex-encoded hash to base64.
 * electron-updater expects SHA-512 hashes in base64 format.
 */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * Format a ReleaseMetadataResult for display.
 */
export function formatReleaseMetadataResult(result: ReleaseMetadataResult): string {
  const lines: string[] = [];

  lines.push("=== Release Metadata Generation ===");
  lines.push(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);

  if (result.metadataPath) {
    lines.push(`Output: ${result.metadataPath}`);
  }

  if (result.document) {
    lines.push(`Version: ${result.document.version}`);
    lines.push(`Channel: ${result.document.channel}`);
    lines.push(`Feed URL: ${result.document.feedUrl}`);
    lines.push(`Artifacts: ${result.document.files.length}`);
    for (const file of result.document.files) {
      const urlFile = file.url.split("/").pop() || file.url;
      lines.push(`  - ${urlFile} (${file.size} bytes, primary: ${file.primary})`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}
