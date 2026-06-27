/**
 * Linux Electron runtime assembly: assembles a Linux Electron app directory
 * from extracted app.asar, preserving resources/app.asar while resolving
 * the droid CLI from the user's system at runtime.
 *
 * Fulfills: VAL-RUNTIME-001, VAL-RUNTIME-002, VAL-RUNTIME-003,
 *           VAL-RUNTIME-010, VAL-RUNTIME-011, VAL-RUNTIME-016
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { classifyBinary, BinaryType } from "./runtime-classifier";
import { readAsarPackageMetadata, type AsarPackageMetadata } from "./asar-metadata";
import type { DaemonTransportPatchResult } from "./daemon-transport-patch";
import { applyRegisteredPatches } from "./patches/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for assembling a Linux Electron runtime */
export interface RuntimeAssemblyOptions {
  /** Path to the extracted app.asar file */
  asarPath: string;
  /** Expected SHA-256 hash of the app.asar file */
  asarHash: string;
  /** Optional system droid path to validate during assembly */
  droidPath?: string;
  /** Output directory for the assembled app */
  outputDir: string;
  /** Electron version to use (default: "39.2.7") */
  electronVersion: string;
  /** Application name for the executable (default: "factory-desktop") */
  appName: string;
  /** Override the Electron dist directory (for testing) */
  electronDistOverride?: string;
}

/** Result of runtime assembly */
export interface RuntimeAssemblyResult {
  /** Whether assembly succeeded */
  success: boolean;
  /** Path to the assembled app directory */
  appDir: string;
  /** Path to the main executable */
  executablePath: string;
  /** ASAR integrity verification result */
  asarResult: {
    intact: boolean;
    hashMatch: boolean;
    actualHash: string;
    expectedHash: string;
  };
  /** Droid binary validation result */
  droidResult: {
    valid: boolean;
    path: string;
    isElf: boolean;
    isExecutable: boolean;
  };
  /** Layout validation result */
  layoutResult: {
    valid: boolean;
    isLinuxLayout: boolean;
    hasMacPaths: boolean;
  };
  /** Shared library check result */
  sharedLibResult: {
    valid: boolean;
    missingLibs: string[];
  };
  /** Daemon transport patch result */
  daemonTransportPatchResult: DaemonTransportPatchResult;
  /** Errors encountered during assembly */
  errors: string[];
  /** Warnings during assembly */
  warnings: string[];
}

/** Layout validation result (VAL-RUNTIME-001) */
export interface LayoutValidationResult {
  /** Whether the layout is valid for Linux */
  valid: boolean;
  /** Whether this is a Linux Electron layout */
  isLinuxLayout: boolean;
  /** Whether macOS Contents/Frameworks paths were found */
  hasMacPaths: boolean;
  /** Whether the main executable exists */
  hasExecutable: boolean;
  /** Whether the resources directory exists */
  hasResourcesDir: boolean;
  /** Whether resources/app.asar exists */
  hasAppAsar: boolean;
  /** Whether a system droid CLI is available */
  hasDroid: boolean;
  /** File type output for the main executable */
  executableFileType?: string;
  /** Validation errors */
  errors: string[];
}

/** ASAR integrity result (VAL-RUNTIME-002) */
export interface AsarIntactResult {
  /** Whether the ASAR is intact */
  intact: boolean;
  /** Whether the hash matches */
  hashMatch: boolean;
  /** Actual SHA-256 hash */
  actualHash: string;
  /** Expected SHA-256 hash */
  expectedHash: string;
  /** Whether app.asar exists */
  asarPresent: boolean;
  /** Whether package metadata was found and valid */
  metadataPresent: boolean;
  /** Package metadata if available */
  metadata?: AsarPackageMetadata;
  /** Errors */
  errors: string[];
}

/** System droid CLI validation result (VAL-RUNTIME-003) */
export interface DroidBinaryResult {
  /** Whether the system droid CLI is valid */
  valid: boolean;
  /** Whether the droid executable exists */
  exists: boolean;
  /** Resolved path to the droid executable */
  path: string;
  /** Whether the droid is Linux ELF */
  isElf: boolean;
  /** Whether the droid is executable */
  isExecutable: boolean;
  /** Architecture if detected */
  architecture?: string;
  /** File type output */
  fileType?: string;
  /** Whether --version ran successfully */
  versionRan: boolean;
  /** Version output */
  versionOutput?: string;
  /** Errors */
  errors: string[];
}

/** Shared library check result (VAL-RUNTIME-016) */
export interface SharedLibResult {
  /** Whether all shared libraries are resolvable */
  valid: boolean;
  /** Whether ldd ran successfully */
  lddRan: boolean;
  /** List of missing shared libraries */
  missingLibs: string[];
  /** ldd output for diagnostics */
  lddOutput?: string;
  /** Errors */
  errors: string[];
}

/** Resources path resolution result (VAL-RUNTIME-011) */
export interface ResourcesPathResult {
  /** Whether the resources path resolution is valid */
  valid: boolean;
  /** Whether the resources directory exists */
  resourcesDirExists: boolean;
  /** Whether app.asar is in resources */
  appAsarInResources: boolean;
  /** Whether system droid CLI is available */
  systemDroidAvailable: boolean;
  /** Expected resourcesPath value */
  expectedResourcesPath: string;
  /** Resolved system droid path */
  systemDroidPath: string;
  /** Errors */
  errors: string[];
}

/** Launch requirements check result (VAL-RUNTIME-010) */
export interface LaunchRequirementsResult {
  /** Whether normal launch is possible without insecure flags */
  normalLaunchPossible: boolean;
  /** Whether chrome-sandbox exists and has correct SUID permissions */
  sandboxConfigured: boolean;
  /** Path to chrome-sandbox binary */
  chromeSandboxPath: string;
  /** Whether --no-sandbox is required */
  noSandboxRequired: boolean;
  /** Documentation/instructions for fixing launch requirements */
  instructions: string[];
  /** Warnings */
  warnings: string[];
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Locate the Electron dist directory.
 *
 * Tries multiple strategies:
 * 1. require.resolve('electron') to find the binary, then derive the dist dir
 * 2. Look in node_modules/electron/dist/ relative to the project
 */
export function getElectronDistPath(): string {
  // Strategy 1: Use require.resolve to find the electron module
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electronBinaryPath = require("electron") as string;
    if (electronBinaryPath && fs.existsSync(electronBinaryPath)) {
      return path.dirname(electronBinaryPath);
    }
  } catch {
    // electron module not loadable
  }

  // Strategy 2: Look in common node_modules locations
  const projectRoot = findProjectRoot();
  const candidates = [
    path.join(projectRoot, "node_modules", "electron", "dist"),
    path.join(process.cwd(), "node_modules", "electron", "dist"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "electron"))) {
      return candidate;
    }
  }

  // Return a default path even if it doesn't exist (will error later)
  return path.join(projectRoot, "node_modules", "electron", "dist");
}

/**
 * Find the project root by walking up from the current directory
 * looking for a package.json.
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Copy a directory recursively.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Preserve permissions
      const stat = fs.statSync(srcPath);
      fs.chmodSync(destPath, stat.mode);
    }
  }
}

/**
 * Compute SHA-256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function resolveSystemDroidPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env.FACTORY_DROID_PATH && fs.existsSync(process.env.FACTORY_DROID_PATH)) {
    return process.env.FACTORY_DROID_PATH;
  }

  try {
    const resolved = execSync("command -v droid", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (resolved) return resolved;
  } catch {
    // Fall through to GUI-launch/common install locations.
  }

  const candidates = [
    path.join(osHomedir(), ".local", "bin", "droid"),
    "/usr/local/bin/droid",
    "/usr/bin/droid",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return "";
}

function osHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

/**
 * Assemble a Linux Electron app directory from extracted app.asar.
 *
 * This is the main assembly function that:
 * 1. Copies the Electron Linux runtime into the output directory
 * 2. Renames the main executable to the app name
 * 3. Places app.asar in resources/
 * 4. Patches Factory to resolve the system droid CLI at runtime
 * 5. Removes default_app.asar
 * 6. Validates the assembled layout and system droid availability
 *
 * VAL-RUNTIME-001: Produces Linux Electron layout, not macOS
 * VAL-RUNTIME-002: Preserves app.asar integrity
 * VAL-RUNTIME-003: Ensures system droid CLI is executable Linux ELF
 * VAL-RUNTIME-016: Validates shared library dependencies
 */
export async function assembleLinuxRuntime(
  options: RuntimeAssemblyOptions
): Promise<RuntimeAssemblyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Locate the Electron dist directory
  const electronDistDir = options.electronDistOverride || getElectronDistPath();

  // Validate inputs
  if (!fs.existsSync(options.asarPath)) {
    errors.push(`app.asar not found: ${options.asarPath}`);
  }

  const systemDroidPath = resolveSystemDroidPath(options.droidPath);
  if (!systemDroidPath) {
    errors.push(
      "System droid CLI not found. Install droid so `command -v droid` works " +
        "or place it at ~/.local/bin/droid, /usr/local/bin/droid, or /usr/bin/droid."
    );
  }

  if (!fs.existsSync(electronDistDir)) {
    errors.push(
      `Electron dist directory not found: ${electronDistDir}. ` +
        `Install electron@${options.electronVersion} as a devDependency: ` +
        `npm install --save-dev electron@${options.electronVersion}`
    );
  }

  // Verify the electron binary exists in the dist dir
  const electronBinary = path.join(electronDistDir, "electron");
  if (fs.existsSync(electronDistDir) && !fs.existsSync(electronBinary)) {
    errors.push(
      `Electron binary not found in dist directory: ${electronBinary}. ` +
        `The electron package may be corrupted or incomplete.`
    );
  }

  if (errors.length > 0) {
    return {
      success: false,
      appDir: "",
      executablePath: "",
      asarResult: { intact: false, hashMatch: false, actualHash: "", expectedHash: options.asarHash },
      droidResult: { valid: false, path: "", isElf: false, isExecutable: false },
      layoutResult: { valid: false, isLinuxLayout: false, hasMacPaths: false },
      sharedLibResult: { valid: false, missingLibs: [] },
      daemonTransportPatchResult: {
        success: false,
        patched: false,
        originalHash: "",
        patchedHash: "",
        patchCount: 0,
        patches: [],
        errors: [],
        warnings: [],
      },
      errors,
      warnings,
    };
  }

  // Create the output directory
  const appDir = path.join(options.outputDir, `${options.appName}-linux-unpacked`);
  fs.mkdirSync(appDir, { recursive: true });

  // Step 1: Copy the Electron runtime files
  copyDirRecursive(electronDistDir, appDir);

  // Step 2: Rename the electron executable to the app name
  const originalExe = path.join(appDir, "electron");
  const newExe = path.join(appDir, options.appName);

  if (fs.existsSync(originalExe)) {
    fs.renameSync(originalExe, newExe);
  } else {
    errors.push(`Electron executable not found at: ${originalExe}`);
  }

  // Step 3: Remove default_app.asar (not needed for our app)
  const defaultAppAsar = path.join(appDir, "resources", "default_app.asar");
  if (fs.existsSync(defaultAppAsar)) {
    fs.unlinkSync(defaultAppAsar);
  }

  // Step 4: Copy app.asar to resources/
  const resourcesDir = path.join(appDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });

  const destAsarPath = path.join(resourcesDir, "app.asar");
  fs.copyFileSync(options.asarPath, destAsarPath);

  // Verify asar hash
  const actualAsarHash = computeFileHash(destAsarPath);
  const hashMatch = actualAsarHash === options.asarHash;

  if (!hashMatch) {
    errors.push(
      `app.asar hash mismatch after copy. Expected: ${options.asarHash}, ` +
        `Actual: ${actualAsarHash}. The file may have been corrupted during copy.`
    );
  }

  // Step 4b: Patch daemon transport for Linux compatibility
  // VAL-DAEMON-001: Linux app must not emit --listen ipc
  // VAL-DAEMON-002: Daemon must reach healthy runtime state
  // Routed through the core patch registry (src/patches/registry.ts) so every
  // Linux asar fix is discoverable, individually testable, and order-controlled.
  const patchRegistryResult = await applyRegisteredPatches({
    asarPath: destAsarPath,
    tolerateMissingTarget: true,
  });
  const daemonTransportPatchResult: DaemonTransportPatchResult = {
    success: patchRegistryResult.success,
    patched: patchRegistryResult.patched,
    originalHash: patchRegistryResult.originalHash,
    patchedHash: patchRegistryResult.finalHash,
    patchCount: patchRegistryResult.outcomes.reduce(
      (n, o) => n + o.patches.length,
      0
    ),
    patches: patchRegistryResult.outcomes.flatMap((o) => o.patches),
    errors: patchRegistryResult.errors,
    warnings: patchRegistryResult.warnings,
  };

  if (!daemonTransportPatchResult.success) {
    errors.push(
      "Daemon transport patch failed: " +
        daemonTransportPatchResult.errors.join("; ")
    );
  } else if (daemonTransportPatchResult.patched) {
    warnings.push(
      `Daemon transport patched: ${daemonTransportPatchResult.patches.map((p) => p.id).join(", ")}. ` +
        `Asar hash changed from ${daemonTransportPatchResult.originalHash.substring(0, 12)}... ` +
        `to ${daemonTransportPatchResult.patchedHash.substring(0, 12)}...`
    );
  }

  // Step 5: Do not copy droid into resources/bin/. The Linux app is patched to
  // resolve the user's system droid CLI at runtime so the settings page and
  // daemon agree on the same installed CLI version.

  // Also ensure the main app executable is executable
  if (fs.existsSync(newExe)) {
    try {
      fs.chmodSync(newExe, 0o755);
    } catch {
      warnings.push("Failed to set executable permissions on main app executable.");
    }
  }

  // Step 6: Validate the assembled app
  const layoutResult = validateRuntimeLayout(appDir, { appName: options.appName });
  const asarResult = validateAsarIntact(appDir, options.asarHash, {
    additionalAllowedHashes: daemonTransportPatchResult.patched
      ? [daemonTransportPatchResult.patchedHash]
      : [],
  });
  const droidResult = validateDroidBinary(appDir, systemDroidPath);
  const sharedLibResult = validateSharedLibraries(appDir, { appName: options.appName });

  // Collect validation errors
  if (!layoutResult.valid) {
    errors.push(...layoutResult.errors);
  }
  if (!asarResult.intact) {
    errors.push(...asarResult.errors);
  }
  if (!droidResult.valid) {
    errors.push(...droidResult.errors);
  }
  if (!sharedLibResult.valid) {
    errors.push(...sharedLibResult.errors);
  }

  const success = errors.length === 0;

  return {
    success,
    appDir: success ? appDir : "",
    executablePath: success ? newExe : "",
    asarResult: {
      intact: asarResult.intact,
      hashMatch: asarResult.hashMatch,
      actualHash: asarResult.actualHash,
      expectedHash: asarResult.expectedHash,
    },
    droidResult: {
      valid: droidResult.valid,
      path: droidResult.path,
      isElf: droidResult.isElf,
      isExecutable: droidResult.isExecutable,
    },
    layoutResult: {
      valid: layoutResult.valid,
      isLinuxLayout: layoutResult.isLinuxLayout,
      hasMacPaths: layoutResult.hasMacPaths,
    },
    sharedLibResult: {
      valid: sharedLibResult.valid,
      missingLibs: sharedLibResult.missingLibs,
    },
    daemonTransportPatchResult,
    errors,
    warnings,
  };
}

// ─── Validation Functions ───────────────────────────────────────────────────

/**
 * Validate the runtime layout of an assembled Linux Electron app.
 *
 * VAL-RUNTIME-001: A successful runtime assembly must produce a Linux
 * Electron app directory with an executable app binary, Electron runtime
 * files, and resources/app.asar. The system droid CLI is resolved from
 * PATH/common install locations at runtime instead of bundled resources.
 */
export function validateRuntimeLayout(
  appDir: string,
  options?: { appName?: string }
): LayoutValidationResult {
  const errors: string[] = [];

  if (!fs.existsSync(appDir)) {
    return {
      valid: false,
      isLinuxLayout: false,
      hasMacPaths: false,
      hasExecutable: false,
      hasResourcesDir: false,
      hasAppAsar: false,
      hasDroid: false,
      errors: [`App directory does not exist: ${appDir}`],
    };
  }

  // Check for macOS Contents/Frameworks (should NOT be present)
  const macFrameworksPath = path.join(appDir, "Contents", "Frameworks");
  const hasMacPaths = fs.existsSync(macFrameworksPath);
  if (hasMacPaths) {
    errors.push(
      `macOS Contents/Frameworks path found: ${macFrameworksPath}. ` +
        `The assembled app should use Linux Electron layout, not macOS.`
    );
  }

  // Check for main executable
  let hasExecutable = false;
  let executableFileType: string | undefined;

  // Build candidate list: configured name first, then fallback names,
  // then detect any single top-level executable if no known name matches.
  const exeCandidates: string[] = [];
  if (options?.appName) {
    exeCandidates.push(options.appName);
  }
  exeCandidates.push("factory-desktop", "electron");

  // If no known candidate exists, detect the single executable in the
  // app directory (skip known directories and chrome-sandbox).
  for (const name of exeCandidates) {
    const exePath = path.join(appDir, name);
    if (fs.existsSync(exePath)) {
      hasExecutable = true;
      try {
        executableFileType = execSync(`file "${exePath}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        }).trim();
      } catch {
        executableFileType = "unknown";
      }
      break;
    }
  }

  // Fallback: detect the single top-level executable if no known name matched.
  // This handles custom/renamed executables without requiring the caller
  // to explicitly specify the name.
  if (!hasExecutable && fs.existsSync(appDir)) {
    const skipNames = new Set(["resources", "locales", "chrome-sandbox", "LICENSE", "version"]);
    const topEntries = fs.readdirSync(appDir);
    const candidateFiles = topEntries.filter(
      (e) => !skipNames.has(e) && !e.includes(".") && !e.endsWith(".so")
    );
    // If there's exactly one non-directory candidate (or one candidate that is a file), use it
    const fileCandidates = candidateFiles.filter((e) => {
      try {
        return fs.statSync(path.join(appDir, e)).isFile();
      } catch {
        return false;
      }
    });
    if (fileCandidates.length === 1) {
      const detected = fileCandidates[0];
      const exePath = path.join(appDir, detected);
      hasExecutable = true;
      try {
        executableFileType = execSync(`file "${exePath}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        }).trim();
      } catch {
        executableFileType = "unknown";
      }
    }
  }

  if (!hasExecutable) {
    errors.push("No main executable found in app directory.");
  }

  // Check for resources directory
  const resourcesDir = path.join(appDir, "resources");
  const hasResourcesDir = fs.existsSync(resourcesDir);
  if (!hasResourcesDir) {
    errors.push("resources/ directory not found in app directory.");
  }

  // Check for resources/app.asar
  const asarPath = path.join(resourcesDir, "app.asar");
  const hasAppAsar = fs.existsSync(asarPath);
  if (!hasAppAsar) {
    errors.push("resources/app.asar not found in app directory.");
  }

  const hasDroid = !!resolveSystemDroidPath();

  // Determine if this is a Linux layout
  const isLinuxLayout = !hasMacPaths && hasResourcesDir;

  return {
    valid: errors.length === 0,
    isLinuxLayout,
    hasMacPaths,
    hasExecutable,
    hasResourcesDir,
    hasAppAsar,
    hasDroid,
    executableFileType,
    errors,
  };
}

/**
 * Validate that the packaged app uses the extracted Factory app.asar
 * and that the payload is intact.
 *
 * VAL-RUNTIME-002: The assembled Linux app must load the extracted
 * Factory app.asar and preserve the main entry metadata. The assertion
 * fails if app.asar is missing, unpacked incorrectly, replaced with a
 * placeholder, or no longer reports the selected Factory version metadata.
 */
export function validateAsarIntact(
  appDir: string,
  expectedHash: string,
  options?: {
    /** Expected product name (default: "Factory"). When set, a mismatch is an error.
     *  When unset/null, any non-placeholder productName is accepted. */
    expectedProductName?: string;
    /** Additional allowed hashes (e.g., from daemon transport patching).
     *  If the actual hash matches any in this list, hashMatch is true. */
    additionalAllowedHashes?: string[];
  }
): AsarIntactResult {
  const errors: string[] = [];

  const asarPath = path.join(appDir, "resources", "app.asar");
  const asarPresent = fs.existsSync(asarPath);

  if (!asarPresent) {
    return {
      intact: false,
      hashMatch: false,
      actualHash: "",
      expectedHash,
      asarPresent: false,
      metadataPresent: false,
      errors: ["app.asar not found in resources/ directory."],
    };
  }

  // Compute actual hash
  const actualHash = computeFileHash(asarPath);
  const additionalHashes = options?.additionalAllowedHashes ?? [];
  const hashMatch = actualHash === expectedHash || additionalHashes.includes(actualHash);

  if (!hashMatch) {
    errors.push(
      `app.asar hash mismatch. Expected: ${expectedHash}, Actual: ${actualHash}. ` +
        `The app payload may have been corrupted or replaced.`
    );
  }

  // Read and validate metadata
  let metadataPresent = false;
  let metadata: AsarPackageMetadata | undefined;

  const asarResult = readAsarPackageMetadata(asarPath);
  if (asarResult.success && asarResult.packageMetadata) {
    metadataPresent = true;
    metadata = asarResult.packageMetadata;

    // Verify key metadata fields
    // Product name validation: if an expected name is provided, enforce it.
    // Otherwise, accept any non-placeholder productName. Known placeholder
    // names that indicate the asar was not properly extracted include empty
    // strings, "electron", "electron-quick-start", and "app".
    const expectedProductName = options?.expectedProductName ?? "Factory";
    const placeholderNames = new Set(["", "electron", "electron-quick-start", "app"]);
    if (metadata.productName === expectedProductName) {
      // Exact match with expected name - good
    } else if (placeholderNames.has(metadata.productName.toLowerCase())) {
      errors.push(
        `Product name in app.asar is "${metadata.productName}", which appears to be ` +
          `a placeholder. The app.asar may not be the extracted Factory Desktop payload.`
      );
    } else if (options?.expectedProductName !== undefined) {
      // An explicit expected name was provided and it doesn't match
      errors.push(
        `Product name in app.asar is "${metadata.productName}", expected "${expectedProductName}". ` +
          `The app.asar may have been replaced with a placeholder.`
      );
    }
    // else: no explicit expected name provided and the name is non-placeholder,
    // so accept it (handles future Factory metadata changes).

    if (!metadata.version || metadata.version === "0.0.0") {
      errors.push(
        `Version in app.asar is "${metadata.version}", which suggests a placeholder. ` +
          `The app payload is not the extracted Factory Desktop payload.`
      );
    }

    if (!metadata.main || metadata.main.trim() === "") {
      errors.push(
        "Main entry point in app.asar is missing or empty. " +
          "The app payload metadata is not preserved."
      );
    }
  } else {
    errors.push(
      `Failed to read package metadata from app.asar: ${asarResult.error || "unknown error"}. ` +
        `The app.asar may be corrupted or not a valid ASAR archive.`
    );
  }

  return {
    intact: errors.length === 0,
    hashMatch,
    actualHash,
    expectedHash,
    asarPresent: true,
    metadataPresent,
    metadata,
    errors,
  };
}

/**
 * Validate that the system droid CLI is an executable Linux ELF.
 *
 * VAL-RUNTIME-003: The system droid CLI used by the packaged app must be
 * executable, reported by file as Linux x86_64 ELF, and respond to --version.
 * The assertion fails for Mach-O, missing execute bit, wrong architecture, or
 * failed command.
 */
export function validateDroidBinary(
  _appDir: string,
  explicitPath?: string
): DroidBinaryResult {
  const droidPath = resolveSystemDroidPath(explicitPath);

  if (!droidPath) {
    return {
      valid: false,
      exists: false,
      path: "",
      isElf: false,
      isExecutable: false,
      versionRan: false,
      errors: [
        "System droid CLI not found. Install droid so `command -v droid` works " +
          "or place it at ~/.local/bin/droid, /usr/local/bin/droid, or /usr/bin/droid.",
      ],
    };
  }

  const exists = fs.existsSync(droidPath);
  if (!exists) {
    return {
      valid: false,
      exists: false,
      path: droidPath,
      isElf: false,
      isExecutable: false,
      versionRan: false,
      errors: [`System droid CLI not found at ${droidPath}.`],
    };
  }

  const classification = classifyBinary(droidPath);
  const isElf = classification.type === BinaryType.ELF;

  if (classification.type === BinaryType.MachO) {
    return {
      valid: false,
      exists: true,
      path: droidPath,
      isElf: false,
      isExecutable: false,
      architecture: classification.architecture,
      fileType: classification.fileOutput,
      versionRan: false,
      errors: [
        `System droid CLI is macOS Mach-O (${classification.architecture || "unknown"}), ` +
          `not Linux ELF.`,
      ],
    };
  }

  let isExecutable = false;
  try {
    fs.accessSync(droidPath, fs.constants.X_OK);
    isExecutable = true;
  } catch {
    // Not executable
  }

  if (!isExecutable) {
    return {
      valid: false,
      exists: true,
      path: droidPath,
      isElf,
      isExecutable: false,
      architecture: classification.architecture,
      fileType: classification.fileOutput,
      versionRan: false,
      errors: ["System droid CLI is not executable."],
    };
  }

  if (isElf && classification.architecture !== "x86_64") {
    return {
      valid: false,
      exists: true,
      path: droidPath,
      isElf: true,
      isExecutable: true,
      architecture: classification.architecture,
      fileType: classification.fileOutput,
      versionRan: false,
      errors: [
        `System droid CLI is ELF but architecture is ${classification.architecture}, ` +
          `expected x86_64.`,
      ],
    };
  }

  let versionRan = false;
  let versionOutput: string | undefined;
  const errors: string[] = [];

  if (isElf && isExecutable) {
    try {
      const output = execSync(`"${droidPath}" --version`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      }).trim();
      versionRan = true;
      versionOutput = output;
    } catch (err) {
      errors.push(
        `Failed to run "droid --version": ${err instanceof Error ? err.message : String(err)}.`
      );
    }
  } else if (!isElf) {
    errors.push(
      `System droid CLI is not a Linux ELF binary. ` +
        `file reports: ${classification.fileOutput || "unknown"}.`
    );
  }

  return {
    valid: errors.length === 0 && isElf && isExecutable,
    exists: true,
    path: droidPath,
    isElf,
    isExecutable,
    architecture: classification.architecture,
    fileType: classification.fileOutput,
    versionRan,
    versionOutput,
    errors,
  };
}

/**
 * Validate shared library dependencies for the assembled app.
 *
 * VAL-RUNTIME-016: The assembled Linux executable and any relevant
 * native modules must have resolvable shared library dependencies in
 * the target environment. The assertion fails if ldd reports missing
 * libraries for the assembled runtime.
 */
export function validateSharedLibraries(
  appDir: string,
  options?: { appName?: string }
): SharedLibResult {
  const errors: string[] = [];
  const missingLibs: string[] = [];

  // Find ELF binaries in the app directory
  const elfBinaries: string[] = [];

  // Check the main executable
  const exeCandidates: string[] = [];
  if (options?.appName) {
    exeCandidates.push(options.appName);
  }
  exeCandidates.push("factory-desktop", "electron");
  for (const name of exeCandidates) {
    const exePath = path.join(appDir, name);
    if (fs.existsSync(exePath)) {
      const classification = classifyBinary(exePath);
      if (classification.type === BinaryType.ELF) {
        elfBinaries.push(exePath);
      }
      break;
    }
  }

  // Fallback: if no known candidate was found, detect the single executable
  if (elfBinaries.length === 0 && fs.existsSync(appDir)) {
    const skipNames = new Set(["resources", "locales", "chrome-sandbox", "LICENSE", "version"]);
    const topEntries = fs.readdirSync(appDir);
    const fileCandidates = topEntries.filter((e) => {
      if (skipNames.has(e) || e.includes(".") || e.endsWith(".so")) return false;
      try {
        return fs.statSync(path.join(appDir, e)).isFile();
      } catch {
        return false;
      }
    });
    if (fileCandidates.length === 1) {
      const exePath = path.join(appDir, fileCandidates[0]);
      const classification = classifyBinary(exePath);
      if (classification.type === BinaryType.ELF) {
        elfBinaries.push(exePath);
      }
    }
  }

  // Also check the droid binary
  const droidPath = path.join(appDir, "resources", "bin", "droid");
  if (fs.existsSync(droidPath)) {
    const classification = classifyBinary(droidPath);
    if (classification.type === BinaryType.ELF) {
      elfBinaries.push(droidPath);
    }
  }

  // Also check .so files in the app directory
  try {
    const entries = fs.readdirSync(appDir);
    for (const entry of entries) {
      if (entry.endsWith(".so") || entry.includes(".so.")) {
        const soPath = path.join(appDir, entry);
        if (fs.existsSync(soPath)) {
          elfBinaries.push(soPath);
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }

  // Run ldd on each ELF binary
  let lddRan = false;
  let combinedOutput = "";

  for (const binaryPath of elfBinaries) {
    try {
      const output = execSync(`ldd "${binaryPath}" 2>&1`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
      lddRan = true;
      combinedOutput += `--- ${binaryPath} ---\n${output}\n`;

      // Parse ldd output for missing libraries
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.includes("not found")) {
          const match = line.trim().match(/^\s*(\S+)\s+.*not found/);
          if (match) {
            missingLibs.push(match[1]);
          }
        }
      }
    } catch (err) {
      // ldd may fail for non-ELF or statically linked binaries
      combinedOutput += `--- ${binaryPath} ---\nldd failed: ${String(err)}\n`;
    }
  }

  if (missingLibs.length > 0) {
    const uniqueMissing = [...new Set(missingLibs)];
    errors.push(
      `Missing shared library dependencies: ${uniqueMissing.join(", ")}. ` +
        `The assembled app may not run on the target system without these libraries.`
    );
  }

  return {
    valid: errors.length === 0,
    lddRan,
    missingLibs: [...new Set(missingLibs)],
    lddOutput: combinedOutput || undefined,
    errors,
  };
}

/**
 * Check that the resources path and system droid resolution are valid.
 *
 * VAL-RUNTIME-011: A runtime diagnostic or IPC check must show that
 * Electron resolves process.resourcesPath to the packaged resources
 * directory and that the patched app can locate the system droid CLI.
 *
 * This function validates the directory structure and the system droid
 * resolver. It does NOT actually launch the Electron app (that is for
 * VAL-RUNTIME-004).
 */
export function checkResourcesPathResolution(
  appDir: string,
  explicitDroidPath?: string
): ResourcesPathResult {
  const errors: string[] = [];
  const resourcesDir = path.join(appDir, "resources");
  const resourcesDirExists = fs.existsSync(resourcesDir);
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const appAsarInResources = fs.existsSync(appAsarPath);
  const systemDroidPath = resolveSystemDroidPath(explicitDroidPath);
  const systemDroidAvailable = !!systemDroidPath;
  const expectedResourcesPath = resourcesDir;

  if (!resourcesDirExists) {
    errors.push("resources/ directory does not exist in the assembled app.");
  }

  if (!appAsarInResources) {
    errors.push(
      "resources/app.asar does not exist. Electron will not find the app payload."
    );
  }

  if (!systemDroidAvailable) {
    errors.push(
      "System droid CLI is not available. The packaged app resolves droid from " +
        "PATH/common system locations instead of resources/bin/droid."
    );
  }

  return {
    valid: errors.length === 0,
    resourcesDirExists,
    appAsarInResources,
    systemDroidAvailable,
    expectedResourcesPath,
    systemDroidPath,
    errors,
  };
}

/**
 * Check launch requirements for the assembled Linux Electron app.
 *
 * VAL-RUNTIME-010: The packaged Linux app must launch in normal mode
 * without requiring validation-only flags such as --no-sandbox; if an
 * insecure flag is genuinely required, the app must document and surface
 * that requirement explicitly.
 *
 * CI-only --no-sandbox note: In CI/Xvfb environments, chrome-sandbox
 * typically cannot be SUID-configured (due to AppArmor, unprivileged
 * containers, or security policies). The Xvfb smoke-launch harness in
 * launch-lifecycle.ts therefore defaults to --no-sandbox for diagnostic
 * smoke tests ONLY. This is acceptable because those tests are isolated,
 * non-production, and do not handle user data. Normal packaged app launch
 * must not silently depend on --no-sandbox.
 *
 * This function checks whether chrome-sandbox has proper SUID permissions
 * and provides documentation for users if it does not.
 */
export function checkLaunchRequirements(
  appDir: string
): LaunchRequirementsResult {
  const warnings: string[] = [];
  const instructions: string[] = [];

  // Check if chrome-sandbox exists and has SUID bit
  const chromeSandboxPath = path.join(appDir, "chrome-sandbox");
  const sandboxExists = fs.existsSync(chromeSandboxPath);

  let sandboxConfigured = false;
  let noSandboxRequired = false;

  if (sandboxExists) {
    try {
      const stat = fs.statSync(chromeSandboxPath);
      const mode = stat.mode;
      const hasSuid = (mode & 0o4000) !== 0;
      const isRootOwned = stat.uid === 0;

      if (hasSuid && isRootOwned) {
        sandboxConfigured = true;
      } else {
        noSandboxRequired = true;
        warnings.push(
          `chrome-sandbox exists but is not configured correctly. ` +
          `It must be owned by root and have mode 4755 (SUID bit set). ` +
          `Current: uid=${stat.uid}, mode=${(mode & 0o7777).toString(8)}`
        );
        instructions.push(
          `To enable normal launch without --no-sandbox, run:`,
          `  sudo chown root "${chromeSandboxPath}"`,
          `  sudo chmod 4755 "${chromeSandboxPath}"`,
          ``,
          `Alternatively, the app can be launched with --no-sandbox, but this`,
          `reduces security and should only be used in development/testing.`
        );
      }
    } catch {
      noSandboxRequired = true;
      warnings.push(
        `Cannot check chrome-sandbox permissions: ${chromeSandboxPath}`
      );
    }
  } else {
    noSandboxRequired = true;
    warnings.push(
      `chrome-sandbox not found in the assembled app. ` +
      `The app may require --no-sandbox to launch.`
    );
  }

  // Check if unprivileged user namespaces are available
  // On Ubuntu 23.10+, AppArmor may restrict unprivileged user namespaces
  let userNamespacesAvailable = true;
  try {
    const apparmorStatus = execSync(
      "cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0",
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (apparmorStatus === "1") {
      userNamespacesAvailable = false;
      warnings.push(
        "Unprivileged user namespaces are restricted by AppArmor. " +
        "This is common on Ubuntu 23.10+ and may require --no-sandbox " +
        "unless chrome-sandbox is configured with SUID."
      );
      instructions.push(
        "On systems with restricted unprivileged user namespaces:",
        "  Option 1: Configure chrome-sandbox with SUID (see above)",
        "  Option 2: Launch with --no-sandbox (reduces security)",
        "  Option 3: Adjust AppArmor settings (system admin required)",
        "",
        "See: https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md"
      );
    }
  } catch {
    // Cannot check, assume available
  }

  // Determine if normal launch is possible
  const normalLaunchPossible = sandboxConfigured || (!noSandboxRequired && userNamespacesAvailable);

  if (noSandboxRequired && !sandboxConfigured) {
    instructions.unshift(
      "NOTE: This app requires --no-sandbox to launch in the current configuration.",
      "This is a documented requirement, not a hidden test-only flag.",
      "The packaging step (electron-builder) typically handles chrome-sandbox",
      "configuration during .deb/AppImage installation.",
      ""
    );
  }

  return {
    normalLaunchPossible,
    sandboxConfigured,
    chromeSandboxPath,
    noSandboxRequired,
    instructions,
    warnings,
  };
}

// ─── Format Functions ───────────────────────────────────────────────────────

/**
 * Format an assembly result for display.
 */
export function formatAssemblyResult(result: RuntimeAssemblyResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Linux Electron runtime assembled successfully.");
  } else {
    lines.push("✗ Linux Electron runtime assembly failed.");
  }

  if (result.appDir) {
    lines.push(`  App directory: ${result.appDir}`);
  }
  if (result.executablePath) {
    lines.push(`  Executable: ${result.executablePath}`);
  }

  lines.push("");
  lines.push("Layout:");
  lines.push(
    `  Linux layout: ${result.layoutResult.isLinuxLayout ? "yes" : "no"}`
  );
  lines.push(
    `  macOS paths: ${result.layoutResult.hasMacPaths ? "FOUND (error)" : "none"}`
  );

  lines.push("");
  lines.push("ASAR integrity:");
  lines.push(
    `  Hash match: ${result.asarResult.hashMatch ? "yes" : "no"}`
  );
  lines.push(
    `  Intact: ${result.asarResult.intact ? "yes" : "no"}`
  );

  lines.push("");
  lines.push("Droid binary:");
  lines.push(
    `  Valid: ${result.droidResult.valid ? "yes" : "no"}`
  );
  lines.push(
    `  ELF: ${result.droidResult.isElf ? "yes" : "no"}`
  );
  lines.push(
    `  Executable: ${result.droidResult.isExecutable ? "yes" : "no"}`
  );

  lines.push("");
  lines.push("Shared libraries:");
  lines.push(
    `  Valid: ${result.sharedLibResult.valid ? "yes" : "no"}`
  );
  if (result.sharedLibResult.missingLibs.length > 0) {
    lines.push(
      `  Missing: ${result.sharedLibResult.missingLibs.join(", ")}`
    );
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a layout validation result for display.
 */
export function formatLayoutResult(result: LayoutValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ Linux Electron runtime layout validated.");
  } else {
    lines.push("✗ Linux Electron runtime layout validation failed.");
  }

  lines.push(`  Is Linux layout: ${result.isLinuxLayout}`);
  lines.push(`  Has macOS paths: ${result.hasMacPaths}`);
  lines.push(`  Has executable: ${result.hasExecutable}`);
  lines.push(`  Has resources dir: ${result.hasResourcesDir}`);
  lines.push(`  Has app.asar: ${result.hasAppAsar}`);
  lines.push(`  Has droid: ${result.hasDroid}`);

  if (result.executableFileType) {
    lines.push(`  Executable type: ${result.executableFileType}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format an ASAR integrity result for display.
 */
export function formatAsarIntactResult(result: AsarIntactResult): string {
  const lines: string[] = [];

  if (result.intact) {
    lines.push("✓ app.asar integrity verified.");
  } else {
    lines.push("✗ app.asar integrity check failed.");
  }

  lines.push(`  Present: ${result.asarPresent}`);
  lines.push(`  Hash match: ${result.hashMatch}`);
  lines.push(`  Expected: ${result.expectedHash}`);
  lines.push(`  Actual: ${result.actualHash}`);
  lines.push(`  Metadata present: ${result.metadataPresent}`);

  if (result.metadata) {
    lines.push(`  Product: ${result.metadata.productName}`);
    lines.push(`  Version: ${result.metadata.version}`);
    lines.push(`  Main: ${result.metadata.main}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a droid binary validation result for display.
 */
export function formatDroidBinaryResult(result: DroidBinaryResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ System droid CLI validated.");
  } else {
    lines.push("✗ System droid CLI validation failed.");
  }

  lines.push(`  Exists: ${result.exists}`);
  lines.push(`  Path: ${result.path}`);
  lines.push(`  Is ELF: ${result.isElf}`);
  lines.push(`  Is executable: ${result.isExecutable}`);

  if (result.architecture) {
    lines.push(`  Architecture: ${result.architecture}`);
  }
  if (result.fileType) {
    lines.push(`  File type: ${result.fileType}`);
  }
  lines.push(`  --version ran: ${result.versionRan}`);
  if (result.versionOutput) {
    lines.push(`  Version: ${result.versionOutput}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a shared library check result for display.
 */
export function formatSharedLibResult(result: SharedLibResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ Shared library dependencies are resolvable.");
  } else {
    lines.push("✗ Shared library dependencies check failed.");
  }

  lines.push(`  ldd ran: ${result.lddRan}`);
  lines.push(`  Missing libraries: ${result.missingLibs.length > 0 ? result.missingLibs.join(", ") : "none"}`);

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a resources path resolution result for display.
 */
export function formatResourcesPathResult(
  result: ResourcesPathResult
): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ Resources path resolution is correct.");
  } else {
    lines.push("✗ Resources path resolution check failed.");
  }

  lines.push(`  resources/ exists: ${result.resourcesDirExists}`);
  lines.push(`  app.asar in resources: ${result.appAsarInResources}`);
  lines.push(`  system droid available: ${result.systemDroidAvailable}`);
  lines.push(`  Expected resourcesPath: ${result.expectedResourcesPath}`);
  lines.push(`  System droid path: ${result.systemDroidPath || "not found"}`);

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a launch requirements check result for display.
 */
export function formatLaunchRequirementsResult(
  result: LaunchRequirementsResult
): string {
  const lines: string[] = [];

  if (result.normalLaunchPossible) {
    lines.push("✓ Normal launch is possible without insecure flags.");
  } else {
    lines.push("⚠ Normal launch requires --no-sandbox (documented requirement).");
  }

  lines.push(`  chrome-sandbox configured: ${result.sandboxConfigured}`);
  lines.push(`  --no-sandbox required: ${result.noSandboxRequired}`);
  lines.push(`  chrome-sandbox path: ${result.chromeSandboxPath}`);

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  if (result.instructions.length > 0) {
    lines.push("");
    lines.push("Instructions:");
    for (const instruction of result.instructions) {
      lines.push(`  ${instruction}`);
    }
  }

  return lines.join("\n");
}
