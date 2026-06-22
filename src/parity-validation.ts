/**
 * Parity validation: compares x64 and arm64 DMG app.asar payloads to
 * verify they are identical. Validates arm64 DMG before comparing.
 *
 * Fulfills: VAL-EXTRACT-003, VAL-EXTRACT-012
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  validateArm64Dmg,
  DmgValidationResult,
} from "./dmg-validator";
import {
  extractFromDmg,
  computeFileHash,
  DMG_CONTENT_PATHS,
} from "./dmg-extraction";
import {
  readAsarPackageMetadata,
  AsarPackageMetadata,
} from "./asar-metadata";

/** Parity check result */
export interface ParityResult {
  /** Whether parity validation passed */
  valid: boolean;
  /** x64 app.asar SHA-256 hash */
  x64AsarHash?: string;
  /** arm64 app.asar SHA-256 hash */
  arm64AsarHash?: string;
  /** x64 package metadata */
  x64Metadata?: AsarPackageMetadata;
  /** arm64 package metadata */
  arm64Metadata?: AsarPackageMetadata;
  /** Arm64 DMG validation result (VAL-EXTRACT-012) */
  arm64Validation?: DmgValidationResult;
  /** Parity comparison errors */
  errors: string[];
  /** Warnings (non-fatal) */
  warnings: string[];
}

/**
 * Validate arm64 DMG before parity checking.
 *
 * VAL-EXTRACT-012: When an arm64 DMG is supplied for parity checking,
 * the builder must verify it is readable, is a Factory Desktop arm64 DMG,
 * and contains comparable app.asar metadata before hash comparison.
 * The assertion fails if invalid arm64 input is ignored or reported as
 * successful parity.
 *
 * @param arm64DmgPath - Path to the arm64 DMG
 * @returns Validation result with any errors
 */
export function validateArm64BeforeParity(
  arm64DmgPath: string
): DmgValidationResult {
  // Step 1: Validate it is a readable Factory Desktop arm64 DMG
  const arm64Result = validateArm64Dmg(arm64DmgPath);
  if (!arm64Result.valid) {
    return arm64Result;
  }

  // Step 2: Verify the DMG contains comparable app.asar
  try {
    const listing = execSync(`7z l "${arm64DmgPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    if (!listing.includes("app.asar")) {
      return {
        valid: false,
        error: `Arm64 DMG does not contain app.asar: ${arm64DmgPath}`,
      };
    }
  } catch (err) {
    // 7z may exit non-zero (code 2) with non-fatal warnings on some DMGs
    // while still producing a valid listing on stdout.
    const stdout = (err as { stdout?: string })?.stdout;
    if (stdout && stdout.includes("app.asar")) {
      // Listing is valid despite the non-zero exit — continue.
    } else {
      return {
        valid: false,
        error: `Failed to inspect arm64 DMG contents: ${arm64DmgPath} (${String(err)})`,
      };
    }
  }

  return arm64Result;
}

/**
 * Compare x64 and arm64 DMG app.asar hashes.
 *
 * VAL-EXTRACT-003: When both x64 and arm64 DMGs are supplied, the
 * builder CLI must compare their extracted application payload identity
 * and pass only when the payload hashes match. If the hashes differ,
 * the command must exit non-zero and clearly report the parity failure.
 *
 * @param x64DmgPath - Path to the x64 Factory Desktop DMG
 * @param arm64DmgPath - Path to the arm64 Factory Desktop DMG
 * @param workDir - Temporary directory for extraction
 * @param options - Additional options
 */
export function compareAsarParity(
  x64DmgPath: string,
  arm64DmgPath: string,
  workDir: string,
  options: {
    /** Whether to validate arm64 DMG before parity (default: true) */
    validateArm64?: boolean;
  } = {}
): ParityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // VAL-EXTRACT-012: Validate arm64 DMG before parity checks
  if (options.validateArm64 !== false) {
    const arm64Validation = validateArm64BeforeParity(arm64DmgPath);
    if (!arm64Validation.valid) {
      return {
        valid: false,
        arm64Validation,
        errors: [
          `Arm64 DMG validation failed before parity check: ${arm64Validation.error}`,
        ],
        warnings: [],
      };
    }
  }

  // Create extraction directories
  const x64ExtractDir = path.join(workDir, "x64_parity");
  const arm64ExtractDir = path.join(workDir, "arm64_parity");

  // Ensure clean directories
  for (const dir of [x64ExtractDir, arm64ExtractDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    // Extract app.asar from both DMGs
    const asarPath = DMG_CONTENT_PATHS.appAsar;

    extractFromDmg(x64DmgPath, x64ExtractDir, [asarPath]);
    extractFromDmg(arm64DmgPath, arm64ExtractDir, [asarPath]);

    // Compute hashes
    const x64AsarFile = path.join(x64ExtractDir, asarPath);
    const arm64AsarFile = path.join(arm64ExtractDir, asarPath);

    if (!fs.existsSync(x64AsarFile)) {
      return {
        valid: false,
        errors: [`Failed to extract app.asar from x64 DMG: ${x64DmgPath}`],
        warnings: [],
      };
    }

    if (!fs.existsSync(arm64AsarFile)) {
      return {
        valid: false,
        errors: [`Failed to extract app.asar from arm64 DMG: ${arm64DmgPath}`],
        warnings: [],
      };
    }

    const x64AsarHash = computeFileHash(x64AsarFile);
    const arm64AsarHash = computeFileHash(arm64AsarFile);

    // Read metadata from both ASARs for comparison
    const x64MetaResult = readAsarPackageMetadata(x64AsarFile);
    const arm64MetaResult = readAsarPackageMetadata(arm64AsarFile);

    const x64Metadata = x64MetaResult.success
      ? x64MetaResult.packageMetadata
      : undefined;
    const arm64Metadata = arm64MetaResult.success
      ? arm64MetaResult.packageMetadata
      : undefined;

    // Compare metadata compatibility
    if (x64Metadata && arm64Metadata) {
      if (x64Metadata.productName !== arm64Metadata.productName) {
        errors.push(
          `Product name mismatch: x64="${x64Metadata.productName}", arm64="${arm64Metadata.productName}"`
        );
      }
      if (x64Metadata.version !== arm64Metadata.version) {
        warnings.push(
          `Version mismatch: x64="${x64Metadata.version}", arm64="${arm64Metadata.version}". ` +
            `This is unusual but not a parity error.`
        );
      }
      if (x64Metadata.main !== arm64Metadata.main) {
        errors.push(
          `Main entry mismatch: x64="${x64Metadata.main}", arm64="${arm64Metadata.main}"`
        );
      }
    }

    // VAL-EXTRACT-003: Compare hashes
    if (x64AsarHash !== arm64AsarHash) {
      errors.push(
        `ASAR parity failure: x64 hash "${x64AsarHash}" does not match arm64 hash "${arm64AsarHash}". ` +
          `The application payloads differ between architectures.`
      );
    }

    return {
      valid: errors.length === 0,
      x64AsarHash,
      arm64AsarHash,
      x64Metadata,
      arm64Metadata,
      errors,
      warnings,
    };
  } catch (err) {
    return {
      valid: false,
      errors: [`Parity check failed: ${String(err)}`],
      warnings: [],
    };
  }
}

/**
 * Format parity result for display.
 */
export function formatParityResult(result: ParityResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ x64 and arm64 app.asar payloads match (parity verified).");
  } else {
    lines.push("✗ x64/arm64 app.asar parity check failed.");
  }

  if (result.x64AsarHash) {
    lines.push(`  x64 ASAR SHA-256:  ${result.x64AsarHash}`);
  }
  if (result.arm64AsarHash) {
    lines.push(`  arm64 ASAR SHA-256: ${result.arm64AsarHash}`);
  }

  if (result.x64Metadata) {
    lines.push(`  x64 product: ${result.x64Metadata.productName} v${result.x64Metadata.version}`);
  }
  if (result.arm64Metadata) {
    lines.push(`  arm64 product: ${result.arm64Metadata.productName} v${result.arm64Metadata.version}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  return lines.join("\n");
}
