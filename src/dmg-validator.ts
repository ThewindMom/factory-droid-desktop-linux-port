/**
 * DMG input validation: verifies a supplied DMG path is a readable,
 * valid Factory Desktop macOS DMG before any extraction proceeds.
 *
 * Fulfills: VAL-EXTRACT-001
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

/** DMG validation result */
export interface DmgValidationResult {
  valid: boolean;
  version?: string;
  error?: string;
}

/**
 * Validate that a supplied DMG path is a readable Factory Desktop DMG.
 *
 * Returns a result with:
 * - valid=true and discovered version if the DMG passes all checks
 * - valid=false and an error message if any check fails
 *
 * This function does NOT produce any extracted payload outputs on failure.
 */
export function validateDmg(dmgPath: string): DmgValidationResult {
  // Check 1: Path must be provided
  if (!dmgPath || dmgPath.trim() === "") {
    return {
      valid: false,
      error: "DMG path is required but was not provided.",
    };
  }

  // Check 2: File must exist
  if (!fs.existsSync(dmgPath)) {
    return {
      valid: false,
      error: `DMG file not found: ${dmgPath}`,
    };
  }

  // Check 3: File must be readable
  try {
    fs.accessSync(dmgPath, fs.constants.R_OK);
  } catch {
    return {
      valid: false,
      error: `DMG file is not readable: ${dmgPath}`,
    };
  }

  // Check 4: File must not be a directory
  const stat = fs.statSync(dmgPath);
  if (stat.isDirectory()) {
    return {
      valid: false,
      error: `Path is a directory, not a DMG file: ${dmgPath}`,
    };
  }

  // Check 5: File extension should be .dmg
  const ext = path.extname(dmgPath).toLowerCase();
  if (ext !== ".dmg") {
    return {
      valid: false,
      error: `File does not have .dmg extension: ${dmgPath}`,
    };
  }

  // Check 6 & 7: Verify it's a valid DMG that 7z can list AND contains Factory.app
  let listing: string;
  try {
    listing = execSync(`7z l "${dmgPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (err) {
    // 7z may exit non-zero (code 2) with warnings on some DMGs while still
    // producing a valid listing on stdout. execSync captures stdout on the
    // error object when stdio is "pipe". Check if we got usable content before
    // declaring failure.
    const stdout = (err as { stdout?: string })?.stdout;
    if (stdout && stdout.includes("Factory.app")) {
      listing = stdout;
    } else {
      return {
        valid: false,
        error: `File is not a valid DMG archive: ${dmgPath} (${String(err)})`,
      };
    }
  }

  // Factory Desktop DMGs contain "Factory.app" in their listing.
  // If 7z is too old (e.g. p7zip 16.02), it cannot decompress LZFSE-compressed
  // DMGs and will only list partition-level entries (e.g. "4.hfs") without
  // descending into the HFS+ filesystem — so "Factory.app" never appears.
  if (!listing.includes("Factory.app")) {
    const hasHfsPartition = listing.includes(".hfs");
    const lzfseHint = hasHfsPartition
      ? " 7z listed HFS partitions but no app contents — this usually means " +
        "7z is too old to decompress LZFSE (need 7-Zip >=21, not p7zip 16.02). " +
        "Install from https://www.7-zip.org/download.html"
      : "";
    return {
      valid: false,
      error: `DMG does not appear to be a Factory Desktop DMG (no Factory.app found in archive): ${dmgPath}.${lzfseHint}`,
    };
  }

  // Extract version from DMG filename (e.g., Factory-0.106.0-x64.dmg)
  const filename = path.basename(dmgPath);
  const versionMatch = filename.match(/Factory-(\d+\.\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  return {
    valid: true,
    version,
  };
}

/**
 * Validate arm64 DMG for parity checking.
 * Same checks as x64 but requires arm64 in filename.
 */
export function validateArm64Dmg(dmgPath: string): DmgValidationResult {
  const baseResult = validateDmg(dmgPath);
  if (!baseResult.valid) {
    return baseResult;
  }

  // Additional check: filename should indicate arm64
  const filename = path.basename(dmgPath).toLowerCase();
  if (!filename.includes("arm64")) {
    return {
      valid: false,
      error: `DMG does not appear to be an arm64 variant: ${dmgPath}`,
    };
  }

  return baseResult;
}
