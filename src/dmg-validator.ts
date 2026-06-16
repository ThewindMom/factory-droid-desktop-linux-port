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

  // Check 6: Verify it's a valid DMG that 7z can list
  try {
    execSync(`7z l "${dmgPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (err) {
    return {
      valid: false,
      error: `File is not a valid DMG archive: ${dmgPath} (${String(err)})`,
    };
  }

  // Check 7: Verify it's a Factory Desktop DMG by looking for expected content
  try {
    const listing = execSync(`7z l "${dmgPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    // Factory Desktop DMGs contain "Factory.app" in their listing
    if (!listing.includes("Factory.app")) {
      return {
        valid: false,
        error: `DMG does not appear to be a Factory Desktop DMG (no Factory.app found in archive): ${dmgPath}`,
      };
    }
  } catch (err) {
    return {
      valid: false,
      error: `Failed to inspect DMG contents: ${dmgPath} (${String(err)})`,
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
