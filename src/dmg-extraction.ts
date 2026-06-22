/**
 * DMG extraction: extracts app.asar, Info.plist, and icon resources from
 * a validated Factory Desktop DMG. Computes deterministic checksums and
 * validates package metadata.
 *
 * Fulfills: VAL-EXTRACT-004, VAL-EXTRACT-008, VAL-EXTRACT-011
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import {
  readAsarPackageMetadata,
  validateAsarMetadata,
  formatAsarMetadata,
  formatValidationResult,
  AsarPackageMetadata,
  MetadataValidationResult,
} from "./asar-metadata";

/** Known paths inside a Factory Desktop DMG */
export const DMG_CONTENT_PATHS = {
  appAsar: "Factory/Factory.app/Contents/Resources/app.asar",
  infoPlist: "Factory/Factory.app/Contents/Info.plist",
  electronIcns: "Factory/Factory.app/Contents/Resources/electron.icns",
  electronFrameworkPlist:
    "Factory/Factory.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist",
  droidBinary: "Factory/Factory.app/Contents/Resources/bin/droid",
} as const;

/** Extraction result */
export interface ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Extracted Factory Desktop version from DMG metadata */
  dmgVersion?: string;
  /** Extracted Electron version */
  electronVersion?: string;
  /** Path to extracted app.asar */
  asarPath?: string;
  /** SHA-256 hash of extracted app.asar */
  asarHash?: string;
  /** ASAR package metadata */
  packageMetadata?: AsarPackageMetadata;
  /** ASAR metadata validation result */
  metadataValidation?: MetadataValidationResult;
  /** All extracted file hashes for determinism verification */
  fileHashes?: Record<string, string>;
  /** Warnings from extraction (e.g., optional icon extraction failure) */
  warnings: string[];
  /** Error on failure */
  error?: string;
}

/** Determinism check result */
export interface DeterminismResult {
  /** Whether the two runs produced identical results */
  deterministic: boolean;
  /** Hash comparison from run 1 */
  run1Hashes?: Record<string, string>;
  /** Hash comparison from run 2 */
  run2Hashes?: Record<string, string>;
  /** Metadata from run 1 */
  run1Metadata?: AsarPackageMetadata;
  /** Metadata from run 2 */
  run2Metadata?: AsarPackageMetadata;
  /** Version from run 1 */
  run1Version?: string;
  /** Version from run 2 */
  run2Version?: string;
  /** Differences found (empty if deterministic=true) */
  differences: string[];
}

/**
 * Extract specific files from a DMG using 7z.
 *
 * @param dmgPath - Path to the DMG file
 * @param outputDir - Directory to extract into
 * @param dmgPaths - Paths inside the DMG to extract
 * @returns Array of paths that failed extraction (with warnings), empty if all succeeded
 */
export function extractFromDmg(
  dmgPath: string,
  outputDir: string,
  dmgPaths: string[]
): string[] {
  const failedPaths: string[] = [];

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  for (const dmgPath_entry of dmgPaths) {
    try {
      execSync(`7z x -y -o"${outputDir}" "${dmgPath}" "${dmgPath_entry}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      });
    } catch (err) {
      // 7z may exit non-zero (code 2) with non-fatal "Headers Error" warnings
      // on some DMGs while still extracting the file successfully. Check if the
      // file exists on disk before treating the error as fatal.
      const extractedPath = path.join(outputDir, dmgPath_entry);
      if (fs.existsSync(extractedPath)) {
        // File was extracted despite the non-zero exit — continue.
        continue;
      }
      // Required paths: app.asar and the app's own Info.plist must exist.
      // The Electron Framework Info.plist is optional — some DMGs may not
      // include it, and we can fall back to ASAR devDependencies for the
      // Electron version. Icons and droid binary are also optional here.
      const isAppInfoPlist =
        dmgPath_entry === DMG_CONTENT_PATHS.infoPlist;
      if (
        dmgPath_entry.includes("app.asar") ||
        isAppInfoPlist
      ) {
        throw new Error(
          `Failed to extract required path "${dmgPath_entry}" from DMG: ${String(err)}`
        );
      }
      // Optional paths (Electron Framework plist, icons, etc.) fail
      // gracefully with a warning and are reported in the returned list.
      failedPaths.push(dmgPath_entry);
    }
  }

  return failedPaths;
}

/**
 * Compute SHA-256 hash of a file.
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Parse the Electron version from the Electron Framework's Info.plist.
 * Simple plist parsing: looks for CFBundleVersion string following a
 * pattern match.
 */
export function parseElectronVersionFromPlist(
  plistContent: string
): string | undefined {
  // Find the CFBundleVersion key and extract the following <string> value
  const regex =
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/;
  const match = plistContent.match(regex);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse the Factory version from the app's Info.plist.
 */
export function parseFactoryVersionFromPlist(
  plistContent: string
): string | undefined {
  // CFBundleShortVersionString contains the marketing version
  const regex =
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;
  const match = plistContent.match(regex);
  return match ? match[1].trim() : undefined;
}

/**
 * Compute hashes of all extracted files for determinism verification.
 */
export function computeExtractionHashes(
  outputDir: string
): Record<string, string> {
  const hashes: Record<string, string> = {};

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(outputDir, fullPath);
        hashes[relativePath] = computeFileHash(fullPath);
      }
    }
  }

  walk(outputDir);
  return hashes;
}

/**
 * Extract app.asar and metadata from a validated Factory Desktop DMG.
 *
 * This is the main extraction function that:
 * 1. Extracts app.asar, Info.plist, and icon from DMG
 * 2. Reads ASAR package metadata
 * 3. Validates metadata against the selected version
 * 4. Computes deterministic checksums
 *
 * VAL-EXTRACT-004: Package metadata is verified (product name, version,
 * main entry, Electron compatibility).
 *
 * VAL-EXTRACT-011: Requested version must match DMG metadata unless
 * explicitly overridden.
 */
export function extractDmgPayload(
  dmgPath: string,
  outputDir: string,
  options: {
    /** Selected Factory Desktop version */
    selectedVersion: string;
    /** Whether version mismatch is explicitly overridden */
    versionOverride?: boolean;
    /** Whether to extract icons */
    extractIcons?: boolean;
  }
): ExtractionResult {
  const warnings: string[] = [];

  try {
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Determine which paths to extract
    const pathsToExtract: string[] = [
      DMG_CONTENT_PATHS.appAsar,
      DMG_CONTENT_PATHS.infoPlist,
    ];

    if (options.extractIcons !== false) {
      pathsToExtract.push(DMG_CONTENT_PATHS.electronIcns);
    }

    // Also extract the Electron Framework Info.plist for Electron version fallback
    pathsToExtract.push(DMG_CONTENT_PATHS.electronFrameworkPlist);

    // Extract from DMG (returns failed optional paths)
    const failedPaths = extractFromDmg(dmgPath, outputDir, pathsToExtract);

    // Surface warnings for optional paths that failed extraction
    for (const failedPath of failedPaths) {
      if (failedPath.includes("electron.icns")) {
        warnings.push(
          `Optional icon extraction failed: "${failedPath}" not found in DMG. ` +
          `Desktop icon generation will need an alternative icon source.`
        );
      } else if (failedPath.includes("Electron Framework")) {
        warnings.push(
          `Optional Electron Framework Info.plist extraction failed: "${failedPath}" not found in DMG. ` +
          `Electron version will be inferred from ASAR devDependencies instead.`
        );
      } else {
        warnings.push(
          `Optional path extraction failed: "${failedPath}" not found in DMG.`
        );
      }
    }

    // Locate extracted files
    const asarPath = path.join(outputDir, DMG_CONTENT_PATHS.appAsar);
    const infoPlistPath = path.join(outputDir, DMG_CONTENT_PATHS.infoPlist);

    // Verify app.asar was extracted
    if (!fs.existsSync(asarPath)) {
      return {
        success: false,
        error: `app.asar was not extracted from DMG. Expected at: ${asarPath}`,
        warnings,
      };
    }

    // Read ASAR package metadata
    const asarResult = readAsarPackageMetadata(asarPath);
    if (!asarResult.success || !asarResult.packageMetadata) {
      return {
        success: false,
        error: `Failed to read ASAR metadata: ${asarResult.error}`,
        warnings,
      };
    }

    // Parse version from Info.plist
    let dmgVersion: string | undefined;
    let electronVersion: string | undefined;

    if (fs.existsSync(infoPlistPath)) {
      const plistContent = fs.readFileSync(infoPlistPath, "utf-8");
      dmgVersion = parseFactoryVersionFromPlist(plistContent);

      // Also try to get Electron version from the framework plist if extracted
      const electronPlistPath = path.join(
        outputDir,
        DMG_CONTENT_PATHS.electronFrameworkPlist
      );
      if (fs.existsSync(electronPlistPath)) {
        const electronPlistContent = fs.readFileSync(
          electronPlistPath,
          "utf-8"
        );
        electronVersion = parseElectronVersionFromPlist(
          electronPlistContent
        );
      }
    }

    // Use ASAR metadata version if plist version is unavailable
    const effectiveDmgVersion =
      dmgVersion || asarResult.packageMetadata.version;

    // Validate ASAR metadata against selected version
    const metadataValidation = validateAsarMetadata(
      asarResult.packageMetadata,
      {
        selectedVersion: options.selectedVersion,
        versionOverride: options.versionOverride,
      }
    );

    // Compute deterministic hashes of all extracted files
    const fileHashes = computeExtractionHashes(outputDir);

    return {
      success: true,
      dmgVersion: effectiveDmgVersion,
      electronVersion:
        electronVersion || asarResult.packageMetadata.electronVersion,
      asarPath,
      asarHash: asarResult.asarHash,
      packageMetadata: asarResult.packageMetadata,
      metadataValidation,
      fileHashes,
      warnings,
    };
  } catch (err) {
    return {
      success: false,
      error: `DMG extraction failed: ${String(err)}`,
      warnings,
    };
  }
}

/**
 * Verify that two extraction runs produced identical results.
 *
 * VAL-EXTRACT-008: Running the same extraction command twice with
 * identical inputs and an empty generated output directory must produce
 * the same reported payload hashes, package metadata, and version
 * selections.
 *
 * @param dmgPath - Path to the Factory Desktop DMG
 * @param workDir - Base work directory (will create run1/ and run2/ subdirs)
 * @param selectedVersion - The selected Factory Desktop version
 */
export function verifyDeterministicExtraction(
  dmgPath: string,
  workDir: string,
  selectedVersion: string
): DeterminismResult {
  const differences: string[] = [];
  const run1Dir = path.join(workDir, "run1");
  const run2Dir = path.join(workDir, "run2");

  // Run 1
  const result1 = extractDmgPayload(dmgPath, run1Dir, {
    selectedVersion,
  });

  // Clean and run 2
  if (fs.existsSync(run2Dir)) {
    fs.rmSync(run2Dir, { recursive: true, force: true });
  }

  const result2 = extractDmgPayload(dmgPath, run2Dir, {
    selectedVersion,
  });

  // Compare results
  if (!result1.success || !result2.success) {
    return {
      deterministic: false,
      differences: [
        `Extraction failed: run1=${result1.success}, run2=${result2.success}`,
        result1.error || "",
        result2.error || "",
      ].filter(Boolean),
    };
  }

  // Compare version selections
  if (result1.dmgVersion !== result2.dmgVersion) {
    differences.push(
      `Version mismatch: run1="${result1.dmgVersion}", run2="${result2.dmgVersion}"`
    );
  }

  // Compare ASAR hashes
  if (result1.asarHash !== result2.asarHash) {
    differences.push(
      `ASAR hash mismatch: run1="${result1.asarHash}", run2="${result2.asarHash}"`
    );
  }

  // Compare package metadata
  if (
    result1.packageMetadata &&
    result2.packageMetadata
  ) {
    const meta1 = result1.packageMetadata;
    const meta2 = result2.packageMetadata;

    if (meta1.productName !== meta2.productName) {
      differences.push(
        `Product name mismatch: run1="${meta1.productName}", run2="${meta2.productName}"`
      );
    }
    if (meta1.version !== meta2.version) {
      differences.push(
        `Package version mismatch: run1="${meta1.version}", run2="${meta2.version}"`
      );
    }
    if (meta1.main !== meta2.main) {
      differences.push(
        `Main entry mismatch: run1="${meta1.main}", run2="${meta2.main}"`
      );
    }
    if (meta1.electronVersion !== meta2.electronVersion) {
      differences.push(
        `Electron version mismatch: run1="${meta1.electronVersion}", run2="${meta2.electronVersion}"`
      );
    }
  }

  // Compare file hashes
  if (result1.fileHashes && result2.fileHashes) {
    const allKeys = new Set([
      ...Object.keys(result1.fileHashes),
      ...Object.keys(result2.fileHashes),
    ]);

    for (const key of allKeys) {
      const hash1 = result1.fileHashes[key];
      const hash2 = result2.fileHashes[key];
      if (!hash1) {
        differences.push(`File "${key}" present in run2 but not in run1`);
      } else if (!hash2) {
        differences.push(`File "${key}" present in run1 but not in run2`);
      } else if (hash1 !== hash2) {
        differences.push(`File "${key}" hash mismatch: "${hash1}" vs "${hash2}"`);
      }
    }
  }

  return {
    deterministic: differences.length === 0,
    run1Hashes: result1.fileHashes,
    run2Hashes: result2.fileHashes,
    run1Metadata: result1.packageMetadata,
    run2Metadata: result2.packageMetadata,
    run1Version: result1.dmgVersion,
    run2Version: result2.dmgVersion,
    differences,
  };
}

/**
 * Format extraction result for display.
 */
export function formatExtractionResult(result: ExtractionResult): string {
  if (!result.success) {
    return `Extraction failed: ${result.error}`;
  }

  const lines: string[] = [
    "✓ DMG extraction completed successfully.",
    `  Factory version: ${result.dmgVersion || "unknown"}`,
    `  Electron version: ${result.electronVersion || "unknown"}`,
    `  ASAR path: ${result.asarPath}`,
    `  ASAR SHA-256: ${result.asarHash}`,
  ];

  if (result.packageMetadata) {
    lines.push("");
    lines.push("Package metadata:");
    lines.push(formatAsarMetadata({
      success: true,
      packageMetadata: result.packageMetadata,
      asarHash: result.asarHash,
      asarSize: undefined,
    }));
  }

  if (result.metadataValidation) {
    lines.push("");
    lines.push(
      formatValidationResult(result.metadataValidation, {
        selectedVersion: result.dmgVersion || "unknown",
      })
    );
  }

  return lines.join("\n");
}

/**
 * Format determinism check result for display.
 */
export function formatDeterminismResult(result: DeterminismResult): string {
  if (result.deterministic) {
    // Use the known app.asar key for the determinism summary instead of
    // Object.values which has nondeterministic key order
    const asarKey = Object.keys(result.run1Hashes || {}).find(
      (k) => k.includes("app.asar")
    );
    const asarHash = asarKey && result.run1Hashes ? result.run1Hashes[asarKey] : "N/A";

    return [
      "✓ Deterministic extraction verified: both runs produced identical results.",
      `  Version: ${result.run1Version}`,
      `  ASAR hash: ${asarHash}`,
    ].join("\n");
  }

  const lines: string[] = [
    "✗ Deterministic extraction check failed: differences found.",
    "",
    "Differences:",
  ];

  for (const diff of result.differences) {
    lines.push(`  - ${diff}`);
  }

  return lines.join("\n");
}
