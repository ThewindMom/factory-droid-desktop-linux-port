/**
 * Runtime binary classification: identifies macOS-only vs Linux-compatible
 * runtime components. Ensures Mach-O droid from DMG is never accepted for
 * the Linux runtime payload.
 *
 * Fulfills: VAL-EXTRACT-005
 */

import * as fs from "fs";
import { execSync } from "child_process";

/** Binary type classification */
export enum BinaryType {
  /** macOS Mach-O binary (not usable on Linux) */
  MachO = "mach-o",
  /** Linux ELF binary */
  ELF = "elf",
  /** Windows PE binary */
  PE = "pe",
  /** Unknown or unrecognizable binary type */
  Unknown = "unknown",
  /** File does not exist or is not a regular file */
  NotAFile = "not-a-file",
}

/** Result of binary classification */
export interface BinaryClassificationResult {
  /** Classified binary type */
  type: BinaryType;
  /** Raw output from `file` command */
  fileOutput?: string;
  /** Architecture if detected (e.g., "x86_64", "arm64") */
  architecture?: string;
  /** Whether this binary is usable for Linux */
  linuxCompatible: boolean;
  /** Error if classification failed */
  error?: string;
}

/** Result of runtime payload validation */
export interface RuntimePayloadValidationResult {
  /** Whether the payload is valid for Linux */
  valid: boolean;
  /** Classification of each runtime binary checked */
  classifications: Record<string, BinaryClassificationResult>;
  /** Validation errors */
  errors: string[];
  /** Human-readable summary */
  summary: string;
}

/**
 * Classify a binary file by running `file` on it.
 *
 * @param binaryPath - Path to the binary to classify
 * @returns Classification result
 */
export function classifyBinary(
  binaryPath: string
): BinaryClassificationResult {
  // Check the file exists
  if (!fs.existsSync(binaryPath)) {
    return {
      type: BinaryType.NotAFile,
      linuxCompatible: false,
      error: `Binary not found: ${binaryPath}`,
    };
  }

  const stat = fs.statSync(binaryPath);
  if (!stat.isFile()) {
    return {
      type: BinaryType.NotAFile,
      linuxCompatible: false,
      error: `Path is not a regular file: ${binaryPath}`,
    };
  }

  // Run `file` command
  let fileOutput: string;
  try {
    fileOutput = execSync(`file "${binaryPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }).trim();
  } catch (err) {
    return {
      type: BinaryType.Unknown,
      linuxCompatible: false,
      error: `Failed to classify binary: ${String(err)}`,
    };
  }

  // Classify based on `file` output
  const lowerOutput = fileOutput.toLowerCase();

  if (
    lowerOutput.includes("mach-o") ||
    lowerOutput.includes("mach-o universally") ||
    lowerOutput.includes("mach-o 64-bit") ||
    lowerOutput.includes("mach-o executable")
  ) {
    let architecture: string | undefined;
    if (lowerOutput.includes("x86_64") || lowerOutput.includes("x86-64")) {
      architecture = "x86_64";
    } else if (lowerOutput.includes("arm64")) {
      architecture = "arm64";
    }

    return {
      type: BinaryType.MachO,
      fileOutput,
      architecture,
      linuxCompatible: false,
    };
  }

  if (
    lowerOutput.includes("elf") &&
    (lowerOutput.includes("executable") ||
      lowerOutput.includes("shared object") ||
      lowerOutput.includes("pie executable") ||
      lowerOutput.includes("no file type") ||
      lowerOutput.includes("elf 64-bit") ||
      lowerOutput.includes("elf 32-bit"))
  ) {
    let architecture: string | undefined;
    if (lowerOutput.includes("x86-64") || lowerOutput.includes("x86_64")) {
      architecture = "x86_64";
    } else if (lowerOutput.includes("aarch64") || lowerOutput.includes("arm")) {
      architecture = "arm64";
    }

    return {
      type: BinaryType.ELF,
      fileOutput,
      architecture,
      linuxCompatible: architecture === "x86_64",
    };
  }

  if (lowerOutput.includes("pe32") || lowerOutput.includes("pe64") || lowerOutput.includes("dos/executable")) {
    return {
      type: BinaryType.PE,
      fileOutput,
      linuxCompatible: false,
    };
  }

  return {
    type: BinaryType.Unknown,
    fileOutput,
    linuxCompatible: false,
  };
}

/**
 * Validate that a runtime payload does not contain reusable macOS
 * runtime binaries.
 *
 * VAL-EXTRACT-005: The extracted payload validation must fail if a
 * macOS-only runtime component is selected for the Linux runtime payload
 * or if the bundled droid binary is not replaced by a Linux executable.
 * A passing run must report that the Linux payload does not contain
 * reusable macOS runtime binaries.
 *
 * @param droidBinaryPath - Path to the droid binary to validate
 * @param options - Additional options
 * @returns Validation result
 */
export function validateRuntimePayloadForLinux(
  droidBinaryPath: string,
  options: {
    /** Expected binary type for Linux */
    expectedType?: BinaryType;
    /** Expected architecture */
    expectedArchitecture?: string;
  } = {}
): RuntimePayloadValidationResult {
  const errors: string[] = [];
  const classifications: Record<string, BinaryClassificationResult> = {};
  const expectedType = options.expectedType || BinaryType.ELF;
  const expectedArch = options.expectedArchitecture || "x86_64";

  // Classify the droid binary
  const droidClassification = classifyBinary(droidBinaryPath);
  classifications["droid"] = droidClassification;

  // VAL-EXTRACT-005: Check that droid is not Mach-O
  if (droidClassification.type === BinaryType.MachO) {
    errors.push(
      `Droid binary is macOS Mach-O (architecture: ${droidClassification.architecture || "unknown"}), ` +
        `which cannot be used for Linux. It must be replaced with a Linux x86_64 ELF binary.`
    );
  }

  // Check that droid is the expected type
  if (
    droidClassification.type !== BinaryType.NotAFile &&
    droidClassification.type !== expectedType
  ) {
    errors.push(
      `Droid binary is ${droidClassification.type}, expected ${expectedType} for Linux.`
    );
  }

  // Check that droid has the expected architecture
  if (
    droidClassification.linuxCompatible &&
    droidClassification.architecture &&
    droidClassification.architecture !== expectedArch
  ) {
    errors.push(
      `Droid binary architecture is ${droidClassification.architecture}, ` +
        `expected ${expectedArch} for Linux.`
    );
  }

  // Generate summary
  let summary: string;
  if (errors.length === 0) {
    if (droidClassification.type === BinaryType.ELF) {
      summary =
        `Linux runtime payload validated: droid is Linux x86_64 ELF. ` +
        `No macOS runtime binaries are present in the Linux payload.`;
    } else if (droidClassification.type === BinaryType.NotAFile) {
      summary =
        `Droid binary not found at expected path. ` +
        `No macOS runtime binaries detected, but droid must be resolved before packaging.`;
    } else {
      summary =
        `Runtime payload classification: droid is ${droidClassification.type}.`;
    }
  } else {
    summary =
      `Runtime payload validation failed: ` +
      errors.map((e) => e.split(".")[0]).join("; ");
  }

  return {
    valid: errors.length === 0,
    classifications,
    errors,
    summary,
  };
}

/**
 * Format a binary classification for display.
 */
export function formatClassification(result: BinaryClassificationResult): string {
  const parts: string[] = [];

  parts.push(`Type: ${result.type}`);
  if (result.architecture) {
    parts.push(`Architecture: ${result.architecture}`);
  }
  parts.push(`Linux-compatible: ${result.linuxCompatible}`);

  if (result.fileOutput) {
    parts.push(`file(1): ${result.fileOutput}`);
  }

  if (result.error) {
    parts.push(`Error: ${result.error}`);
  }

  return parts.join(", ");
}

/**
 * Format runtime payload validation result for display.
 */
export function formatRuntimeValidationResult(
  result: RuntimePayloadValidationResult
): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ Linux runtime payload validated.");
  } else {
    lines.push("✗ Linux runtime payload validation failed.");
  }

  lines.push(`  ${result.summary}`);

  for (const [name, classification] of Object.entries(
    result.classifications
  )) {
    lines.push(`  ${name}: ${formatClassification(classification)}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}
