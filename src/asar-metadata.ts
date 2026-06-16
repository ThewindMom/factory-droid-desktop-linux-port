/**
 * ASAR metadata inspection: reads package.json and other metadata from
 * an extracted app.asar file using @electron/asar.
 *
 * Fulfills: VAL-EXTRACT-004 (package metadata validation)
 */

import * as fs from "fs";
import * as crypto from "crypto";

/** ASAR package metadata extracted from app.asar/package.json */
export interface AsarPackageMetadata {
  /** Package name (e.g., "desktop") */
  name: string;
  /** Product name (e.g., "Factory") */
  productName: string;
  /** Application version (e.g., "0.106.0") */
  version: string;
  /** Main entry point (e.g., ".vite/build/main.js") */
  main: string;
  /** Description */
  description?: string;
  /** Electron version from devDependencies (e.g., "39.2.7") */
  electronVersion?: string;
}

/** Full ASAR metadata result */
export interface AsarMetadataResult {
  /** Whether inspection succeeded */
  success: boolean;
  /** Package metadata from package.json */
  packageMetadata?: AsarPackageMetadata;
  /** SHA-256 hash of the asar file */
  asarHash?: string;
  /** File size in bytes */
  asarSize?: number;
  /** Error message on failure */
  error?: string;
}

/**
 * Validate extracted ASAR package metadata for consistency with the
 * selected Factory Desktop version.
 *
 * VAL-EXTRACT-004: Validates that product name, application version,
 * main entry, and Electron compatibility metadata are present and
 * consistent with the selected Factory Desktop version.
 */
export interface MetadataValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validated product name */
  productName?: string;
  /** Validated version */
  version?: string;
  /** Validated main entry */
  main?: string;
  /** Electron version from devDependencies */
  electronVersion?: string;
  /** Validation errors (empty if valid=true) */
  errors: string[];
}

/**
 * Read the package.json from an ASAR file and extract metadata.
 *
 * Uses @electron/asar to extract the package.json content without
 * extracting the entire archive.
 */
export function readAsarPackageMetadata(
  asarPath: string
): AsarMetadataResult {
  // Validate the asar file exists
  if (!fs.existsSync(asarPath)) {
    return {
      success: false,
      error: `ASAR file not found: ${asarPath}`,
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asar = require("@electron/asar");

    // Extract package.json content
    const packageJsonBuffer = asar.extractFile(asarPath, "package.json");
    const packageJsonStr = packageJsonBuffer.toString("utf-8");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(packageJsonStr);
    } catch {
      return {
        success: false,
        error: `Failed to parse package.json from ASAR: invalid JSON.`,
      };
    }

    // Extract required metadata fields
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    const productName =
      typeof parsed.productName === "string" ? parsed.productName : undefined;
    const version =
      typeof parsed.version === "string" ? parsed.version : undefined;
    const main = typeof parsed.main === "string" ? parsed.main : undefined;
    const description =
      typeof parsed.description === "string" ? parsed.description : undefined;

    // Extract Electron version from devDependencies
    let electronVersion: string | undefined;
    if (
      parsed.devDependencies &&
      typeof parsed.devDependencies === "object" &&
      parsed.devDependencies !== null
    ) {
      const devDeps = parsed.devDependencies as Record<string, unknown>;
      if (typeof devDeps.electron === "string") {
        // Remove leading ^ or ~ if present
        electronVersion = devDeps.electron.replace(/^[\^~]/, "");
      }
    }

    if (!name || !productName || !version || !main) {
      const missing: string[] = [];
      if (!name) missing.push("name");
      if (!productName) missing.push("productName");
      if (!version) missing.push("version");
      if (!main) missing.push("main");

      return {
        success: false,
        error: `ASAR package.json is missing required fields: ${missing.join(", ")}.`,
      };
    }

    // Compute SHA-256 hash of the asar file
    const asarHash = computeFileHash(asarPath);
    const asarSize = fs.statSync(asarPath).size;

    return {
      success: true,
      packageMetadata: {
        name,
        productName,
        version,
        main,
        description,
        electronVersion,
      },
      asarHash,
      asarSize,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read ASAR metadata: ${String(err)}`,
    };
  }
}

/**
 * Validate ASAR package metadata against the selected Factory Desktop version.
 *
 * VAL-EXTRACT-004: Product name, version, main entry, and Electron
 * compatibility must be present and consistent.
 *
 * VAL-EXTRACT-011: Requested version must match DMG metadata unless
 * explicitly overridden.
 */
export function validateAsarMetadata(
  metadata: AsarPackageMetadata,
  options: {
    /** The selected (requested or discovered) Factory Desktop version */
    selectedVersion: string;
    /** Whether version mismatch is explicitly overridden */
    versionOverride?: boolean;
    /** Expected product name (default: "Factory") */
    expectedProductName?: string;
  }
): MetadataValidationResult {
  const errors: string[] = [];
  const expectedProduct = options.expectedProductName || "Factory";

  // Validate product name
  if (metadata.productName !== expectedProduct) {
    errors.push(
      `Product name mismatch: expected "${expectedProduct}", got "${metadata.productName}".`
    );
  }

  // Validate version consistency with selected version
  if (metadata.version !== options.selectedVersion) {
    if (options.versionOverride) {
      // Explicit override is allowed, but still record the mismatch
      // This is a warning-level note but not a validation error
    } else {
      errors.push(
        `Version mismatch: DMG package metadata version "${metadata.version}" ` +
          `does not match selected Factory Desktop version "${options.selectedVersion}". ` +
          `Use --version-override to proceed despite the mismatch.`
      );
    }
  }

  // Validate main entry exists (should be a non-empty string starting with .)
  if (!metadata.main || metadata.main.trim() === "") {
    errors.push("Main entry point is missing or empty in ASAR package.json.");
  }

  // Validate Electron compatibility (Electron version should be present)
  if (!metadata.electronVersion) {
    errors.push(
      "Electron version not found in ASAR devDependencies. " +
        "Cannot verify Electron compatibility."
    );
  }

  return {
    valid: errors.length === 0,
    productName: metadata.productName,
    version: metadata.version,
    main: metadata.main,
    electronVersion: metadata.electronVersion,
    errors,
  };
}

/**
 * Compute SHA-256 hash of a file.
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Format ASAR metadata for display.
 */
export function formatAsarMetadata(result: AsarMetadataResult): string {
  if (!result.success || !result.packageMetadata) {
    return `ASAR metadata error: ${result.error}`;
  }

  const meta = result.packageMetadata;
  const lines: string[] = [
    `Product: ${meta.productName}`,
    `Version: ${meta.version}`,
    `Main: ${meta.main}`,
    `Electron: ${meta.electronVersion || "unknown"}`,
    `ASAR SHA-256: ${result.asarHash}`,
    `ASAR Size: ${result.asarSize?.toLocaleString()} bytes`,
  ];

  if (meta.description) {
    lines.splice(1, 0, `Description: ${meta.description}`);
  }

  return lines.join("\n");
}

/**
 * Parse an entry from `asar.listPackage(path, { isPack: true })`.
 *
 * When `listPackage` is called with `{ isPack: true }`, the returned
 * entries are prefixed strings like "pack   : /path/to/file.js" rather
 * than bare paths. This function extracts the file path portion after
 * the colon and strips leading slashes.
 *
 * Returns null if the entry cannot be parsed (e.g., no colon found).
 */
export function parseIsPackEntry(entry: string): string | null {
  const colonIndex = entry.indexOf(":");
  if (colonIndex === -1) return null;
  const raw = entry.slice(colonIndex + 1).trim();
  return raw.replace(/^\/+/, ""); // remove leading slashes
}

/**
 * Format metadata validation result for display.
 */
export function formatValidationResult(
  validation: MetadataValidationResult,
  options: {
    selectedVersion: string;
    versionOverride?: boolean;
  }
): string {
  const lines: string[] = [];

  if (validation.valid) {
    lines.push("✓ ASAR package metadata validated successfully.");
  } else {
    lines.push("✗ ASAR package metadata validation failed:");
  }

  lines.push(`  Product: ${validation.productName || "missing"}`);
  lines.push(`  Version: ${validation.version || "missing"} (selected: ${options.selectedVersion})`);
  lines.push(`  Main: ${validation.main || "missing"}`);
  lines.push(`  Electron: ${validation.electronVersion || "unknown"}`);

  if (options.versionOverride && validation.version !== options.selectedVersion) {
    lines.push(
      `  ⚠ Version override active: metadata version "${validation.version}" ` +
        `differs from selected "${options.selectedVersion}"`
    );
  }

  for (const error of validation.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}
