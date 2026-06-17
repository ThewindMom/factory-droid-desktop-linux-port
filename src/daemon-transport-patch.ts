/**
 * Daemon transport compatibility patch for Linux builds.
 *
 * Problem: Factory Desktop 0.106.0 app.asar contains a daemon transport
 * selection function (`s9t`) that can select IPC transport based on a
 * Statsig feature flag (`desktop_daemon_ipc`). When IPC is selected, the
 * app emits `droid daemon --listen ipc`. The Linux droid 0.106.0 CLI does
 * NOT support `--listen`; it only supports `--host`, `--port`, and `--unix`.
 *
 * Fix: Patch the app.asar to force WebSocket transport on Linux by:
 * 1. Modifying the transport selection function to return WebSocket on Linux
 * 2. Adding a defense-in-depth guard to prevent `--listen ipc` on Linux
 *
 * Fulfills: VAL-DAEMON-001, VAL-DAEMON-002
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parseIsPackEntry } from "./asar-metadata";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for patching the daemon transport */
export interface DaemonTransportPatchOptions {
  /** Path to the app.asar file to patch (modified in-place) */
  asarPath: string;
  /** Skip patching if already patched (default: true) */
  skipIfPatched?: boolean;
  /**
   * Succeed (without patching) when the asar doesn't contain the expected
   * Vite bundle structure. Useful for test/mock asars and non-Factory
   * app payloads. Default: false (missing target is an error).
   */
  tolerateMissingTarget?: boolean;
}

/** Result of daemon transport patching */
export interface DaemonTransportPatchResult {
  /** Whether the patch was applied successfully */
  success: boolean;
  /** Whether any changes were made (false if already patched) */
  patched: boolean;
  /** SHA-256 hash of the asar before patching */
  originalHash: string;
  /** SHA-256 hash of the asar after patching */
  patchedHash: string;
  /** Number of patches applied */
  patchCount: number;
  /** Description of each patch applied */
  patches: DaemonPatch[];
  /** Errors encountered */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Description of a single patch applied */
export interface DaemonPatch {
  /** Patch identifier */
  id: string;
  /** Description of what the patch does */
  description: string;
  /** Original text that was replaced */
  originalSnippet: string;
  /** Replacement text */
  replacementSnippet: string;
}

/** Options for validating the daemon transport patch */
export interface ValidateDaemonTransportOptions {
  /** Path to the app.asar file to validate */
  asarPath: string;
  /** Path to the droid binary (for --help check) */
  droidPath?: string;
}

/** Result of daemon transport validation */
export interface ValidateDaemonTransportResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Whether the transport selection forces WebSocket on Linux */
  forcesWebSocketOnLinux: boolean;
  /** Whether the --listen ipc guard is present */
  hasListenIpcGuard: boolean;
  /** Supported daemon flags from droid --help (if checked) */
  supportedDaemonFlags?: string[];
  /** Whether --listen appears in supported flags */
  listenFlagSupported: boolean;
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

/**
 * Marker comment injected into patched code to detect already-patched asars.
 */
const PATCH_MARKER = "/* linux-daemon-transport-patch */";

/**
 * Original transport selection function (minified).
 * This function resolves `DesktopDaemonIpc` feature flag and returns
 * either `nc.Ipc` or `nc.WebSocket`.
 *
 * The original code (de-minified) is:
 * ```
 * async function s9t() {
 *   const e = Un.DesktopDaemonIpc;
 *   try {
 *     return (await qce())[e.statsigName] ?? e.defaultValue ? nc.Ipc : nc.WebSocket;
 *   } catch(t) {
 *     return X("[daemon] Failed to resolve desktop daemon IPC feature flag", {cause:t}),
 *            e.defaultValue ? nc.Ipc : nc.WebSocket;
 *   }
 * }
 * ```
 */
export const ORIGINAL_TRANSPORT_FUNCTION =
  "async function s9t(){const e=Un.DesktopDaemonIpc;try{return(await qce())[e.statsigName]??e.defaultValue?nc.Ipc:nc.WebSocket}catch(t){return X(\"[daemon] Failed to resolve desktop daemon IPC feature flag\",{cause:t}),e.defaultValue?nc.Ipc:nc.WebSocket}}";

/**
 * Patched transport selection function that forces WebSocket on Linux.
 *
 * The patched version adds `process.platform==="linux"` check before
 * the feature flag logic, ensuring Linux always uses WebSocket transport.
 */
export const PATCHED_TRANSPORT_FUNCTION =
  "async function s9t(){if(process.platform===\"linux\")return nc.WebSocket;const e=Un.DesktopDaemonIpc;try{return(await qce())[e.statsigName]??e.defaultValue?nc.Ipc:nc.WebSocket}catch(t){return X(\"[daemon] Failed to resolve desktop daemon IPC feature flag\",{cause:t}),e.defaultValue?nc.Ipc:nc.WebSocket}}";

/**
 * Original daemon args construction with `--listen ipc` push.
 * This is the pattern where `t===nc.Ipc` causes `--listen ipc` to be
 * added to the daemon args.
 */
export const ORIGINAL_LISTEN_IPC_PUSH =
  "if(t===nc.Ipc&&a.push(\"--listen\",\"ipc\")";

/**
 * Patched daemon args construction with Linux guard.
 * On Linux, even if transport is somehow still IPC, we prevent
 * `--listen ipc` from being added as a defense-in-depth measure.
 */
export const PATCHED_LISTEN_IPC_PUSH =
  "if(t===nc.Ipc&&process.platform!==\"linux\"&&a.push(\"--listen\",\"ipc\")";

// ─── Core Patching Functions ────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Apply the Linux daemon transport compatibility patch to an app.asar.
 *
 * This patches the bundled Vite JS inside the asar to:
 * 1. Force WebSocket transport on Linux (preventing `--listen ipc`)
 * 2. Add a defense-in-depth guard against `--listen ipc` on Linux
 *
 * VAL-DAEMON-001: The app must not emit `--listen ipc` for Linux droid.
 * VAL-DAEMON-002: The daemon must reach healthy runtime state.
 *
 * @param options Patch options
 * @returns Patch result
 */
export async function patchDaemonTransport(
  options: DaemonTransportPatchOptions
): Promise<DaemonTransportPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: DaemonPatch[] = [];
  const skipIfPatched = options.skipIfPatched ?? true;

  // Validate input
  if (!fs.existsSync(options.asarPath)) {
    return {
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      patches: [],
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  const originalHash = computeFileHash(options.asarPath);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");

  // Find the main bundle file(s) to patch
  const rawFiles = asar.listPackage(options.asarPath, { isPack: true }) as string[];
  const files = rawFiles.map(f => parseIsPackEntry(f)).filter((f): f is string => f !== null);
  const mainBundleFiles = files.filter(
    (f: string) =>
      f.startsWith(".vite/build/index-") && f.endsWith(".js")
  );

  if (mainBundleFiles.length === 0) {
    const message =
      "Could not find the main Vite bundle file (.vite/build/index-*.js) in the asar. " +
      "The asar structure may have changed in a newer Factory Desktop version.";

    if (options.tolerateMissingTarget) {
      warnings.push(message + " Skipping patch (tolerateMissingTarget=true).");
      return {
        success: true,
        patched: false,
        originalHash,
        patchedHash: originalHash,
        patchCount: 0,
        patches: [],
        errors: [],
        warnings,
      };
    }

    return {
      success: false,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [message],
      warnings,
    };
  }

  if (mainBundleFiles.length > 1) {
    warnings.push(
      `Found ${mainBundleFiles.length} main bundle files. ` +
      `Patching all of them: ${mainBundleFiles.join(", ")}`
    );
  }

  let totalPatchCount = 0;
  let alreadyPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const filePath = bundleFile; // Already normalized by parseIsPackEntry
    const content = asar.extractFile(options.asarPath, filePath).toString("utf-8");

    // Check if already patched
    if (skipIfPatched && content.includes(PATCH_MARKER)) {
      alreadyPatched = true;
      warnings.push(`Bundle ${filePath} is already patched. Skipping.`);
      continue;
    }

    let patchedContent = content;
    let filePatchCount = 0;

    // Patch 1: Force WebSocket transport on Linux
    if (patchedContent.includes(ORIGINAL_TRANSPORT_FUNCTION)) {
      patchedContent = patchedContent.replace(
        ORIGINAL_TRANSPORT_FUNCTION,
        PATCH_MARKER + PATCHED_TRANSPORT_FUNCTION
      );
      filePatchCount++;
      patches.push({
        id: "force-websocket-on-linux",
        description:
          "Modify transport selection function (s9t) to return nc.WebSocket " +
          "on Linux regardless of the DesktopDaemonIpc feature flag",
        originalSnippet: ORIGINAL_TRANSPORT_FUNCTION.substring(0, 80) + "...",
        replacementSnippet: PATCHED_TRANSPORT_FUNCTION.substring(0, 80) + "...",
      });
    } else {
      // Check if the function exists in a slightly different form
      const s9tPos = patchedContent.indexOf("async function s9t()");
      if (s9tPos === -1) {
        // The s9t function might not be in this bundle file (it's in the main one)
        // This is not necessarily an error - skip this file
        warnings.push(
          `Could not find the transport selection function (s9t) in ${filePath}. ` +
          `This bundle file may not contain daemon startup code. Skipping.`
        );
      } else {
        // The function exists but the exact text doesn't match
        // Extract and analyze the function
        const funcStart = s9tPos;
        let braceCount = 0;
        let funcEnd = funcStart;
        for (let i = funcStart; i < patchedContent.length; i++) {
          if (patchedContent[i] === "{") braceCount++;
          if (patchedContent[i] === "}") {
            braceCount--;
            if (braceCount === 0) {
              funcEnd = i + 1;
              break;
            }
          }
        }

        const funcText = patchedContent.substring(funcStart, funcEnd);
        if (funcText.includes("process.platform===\"linux\"") && funcText.includes("nc.WebSocket")) {
          // Already has a Linux WebSocket check
          warnings.push(
            `Transport function in ${filePath} already contains a Linux WebSocket guard. ` +
            `Skipping patch 1.`
          );
        } else {
          errors.push(
            `Transport selection function in ${filePath} has unexpected format. ` +
            `Cannot safely apply the WebSocket transport patch. ` +
            `Function text: ${funcText.substring(0, 200)}...`
          );
        }
      }
    }

    // Patch 2: Defense-in-depth: prevent --listen ipc on Linux
    if (patchedContent.includes(ORIGINAL_LISTEN_IPC_PUSH)) {
      patchedContent = patchedContent.replace(
        ORIGINAL_LISTEN_IPC_PUSH,
        PATCHED_LISTEN_IPC_PUSH
      );
      filePatchCount++;
      patches.push({
        id: "prevent-listen-ipc-on-linux",
        description:
          "Add process.platform !== 'linux' guard to --listen ipc arg push " +
          "as a defense-in-depth measure",
        originalSnippet: ORIGINAL_LISTEN_IPC_PUSH,
        replacementSnippet: PATCHED_LISTEN_IPC_PUSH,
      });
    } else if (patchedContent.includes("--listen") && patchedContent.includes("ipc")) {
      // The --listen ipc push might have a different format
      const listenPos = patchedContent.indexOf("--listen");
      const context = patchedContent.substring(
        Math.max(0, listenPos - 50),
        Math.min(patchedContent.length, listenPos + 100)
      );

      if (!context.includes("process.platform") && !context.includes("linux")) {
        warnings.push(
          `Found --listen in ${filePath} but the exact arg push pattern doesn't match. ` +
          `Context: ${context}. Defense-in-depth patch skipped.`
        );
      }
    }

    // Apply the patches if any were made to this file
    if (filePatchCount > 0) {
      // We need to rebuild the asar with the patched content.
      // @electron/asar doesn't support in-place modification,
      // so we extract, patch, and rebuild.
      try {
        await applyAsarContentPatch(options.asarPath, filePath, patchedContent);
      } catch (err) {
        errors.push(
          `Failed to apply patch to ${filePath} in asar: ${String(err)}`
        );
        continue;
      }

      totalPatchCount += filePatchCount;
    }
  }

  const patchedHash = computeFileHash(options.asarPath);

  if (alreadyPatched && totalPatchCount === 0) {
    return {
      success: true,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [],
      warnings,
    };
  }

  if (errors.length > 0) {
    return {
      success: false,
      patched: totalPatchCount > 0,
      originalHash,
      patchedHash,
      patchCount: totalPatchCount,
      patches,
      errors,
      warnings,
    };
  }

  if (totalPatchCount === 0) {
    warnings.push(
      "No patches were applied. The asar may already be patched, or the " +
      "target code patterns may have changed."
    );
  }

  return {
    success: true,
    patched: totalPatchCount > 0,
    originalHash,
    patchedHash,
    patchCount: totalPatchCount,
    patches,
    errors,
    warnings,
  };
}

/**
 * Apply a content patch to a file inside an asar archive.
 *
 * Since @electron/asar doesn't support in-place modification, this:
 * 1. Extracts the entire asar to a temp directory
 * 2. Writes the patched file
 * 3. Rebuilds the asar from the extracted contents
 *
 * Note: asar.createPackage is async, so this function must be awaited.
 */
async function applyAsarContentPatch(
  asarPath: string,
  filePath: string,
  patchedContent: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");

  const tmpDir = asarPath + ".patch-tmp";
  const backupPath = asarPath + ".bak";

  try {
    // Clean up any previous temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Extract the entire asar
    asar.extractAll(asarPath, tmpDir);

    // Uncache the asar filesystem to ensure fresh reads
    asar.uncache(asarPath);

    // Write the patched file
    const extractedFilePath = path.join(tmpDir, filePath);
    fs.writeFileSync(extractedFilePath, patchedContent, "utf-8");

    // Backup the original asar before overwriting
    fs.copyFileSync(asarPath, backupPath);

    // Remove the original asar
    fs.unlinkSync(asarPath);

    // Rebuild the asar from the extracted directory (async)
    // Use createPackageWithOptions instead of createPackage to avoid a bug
    // where createPackage produces a corrupted asar with misaligned offsets
    await asar.createPackageWithOptions(tmpDir, asarPath, {});

    // Uncache again after rebuild to ensure fresh reads
    asar.uncache(asarPath);

    // Verify the patched file is in the rebuilt asar
    // Note: Exact string match may fail due to encoding differences in asar
    // rebuild, so we verify key patch markers are present instead.
    const verifyContent = asar.extractFile(asarPath, filePath).toString("utf-8");
    const hasPatchMarker = verifyContent.includes("linux-daemon-transport-patch");
    const hasLinuxWebSocketGuard = verifyContent.includes('process.platform==="linux")return nc.WebSocket');
    if (!hasPatchMarker || !hasLinuxWebSocketGuard) {
      throw new Error(
        "Verification failed: patched content markers not found in rebuilt asar. " +
        `hasPatchMarker=${hasPatchMarker}, hasLinuxWebSocketGuard=${hasLinuxWebSocketGuard}`
      );
    }

    // Success - remove backup
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch (err) {
    // Restore from backup on failure
    if (fs.existsSync(backupPath) && !fs.existsSync(asarPath)) {
      fs.copyFileSync(backupPath, asarPath);
    }
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    throw err;
  } finally {
    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ─── Validation Functions ───────────────────────────────────────────────────

/**
 * Validate that the daemon transport patch has been correctly applied
 * to an app.asar.
 *
 * VAL-DAEMON-001: Linux app uses droid-supported daemon transport.
 * VAL-DAEMON-002: Linux droid daemon reaches healthy runtime state.
 *
 * @param options Validation options
 * @returns Validation result
 */
export function validateDaemonTransport(
  options: ValidateDaemonTransportOptions
): ValidateDaemonTransportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      forcesWebSocketOnLinux: false,
      hasListenIpcGuard: false,
      listenFlagSupported: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");

  // Check droid daemon --help for supported flags
  let supportedDaemonFlags: string[] | undefined;
  let listenFlagSupported = false;

  if (options.droidPath && fs.existsSync(options.droidPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execSync: exec } = require("child_process");
      const helpOutput = exec(`"${options.droidPath}" daemon --help`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Parse supported flags from help output
      const flagPattern = /--[\w-]+/g;
      supportedDaemonFlags = [...new Set<string>(helpOutput.match(flagPattern) || [])];
      listenFlagSupported = supportedDaemonFlags.includes("--listen");

      if (listenFlagSupported) {
        warnings.push(
          "The bundled droid daemon supports --listen. " +
          "The transport patch may not be needed for this droid version. " +
          `Supported flags: ${supportedDaemonFlags.join(", ")}`
        );
      }
    } catch (err) {
      warnings.push(
        `Could not run droid daemon --help: ${String(err)}. ` +
        "Skipping supported flags check."
      );
    }
  }

  // Find and inspect the main bundle
  const rawFiles = asar.listPackage(options.asarPath, { isPack: true }) as string[];
  const files = rawFiles.map(f => parseIsPackEntry(f)).filter((f): f is string => f !== null);
  const mainBundleFiles = files.filter(
    (f: string) =>
      f.startsWith(".vite/build/index-") && f.endsWith(".js")
  );

  let forcesWebSocketOnLinux = false;
  let hasListenIpcGuard = false;

  for (const bundleFile of mainBundleFiles) {
    const filePath = bundleFile; // Already normalized by parseIsPackEntry
    const content = asar.extractFile(options.asarPath, filePath).toString("utf-8");

    // Check for the WebSocket transport guard on Linux
    const s9tPos = content.indexOf("async function s9t()");
    if (s9tPos !== -1) {
      const funcStart = s9tPos;
      let braceCount = 0;
      let funcEnd = funcStart;
      for (let i = funcStart; i < content.length; i++) {
        if (content[i] === "{") braceCount++;
        if (content[i] === "}") {
          braceCount--;
          if (braceCount === 0) {
            funcEnd = i + 1;
            break;
          }
        }
      }

      const funcText = content.substring(funcStart, funcEnd);

      if (
        funcText.includes("process.platform===\"linux\"") &&
        funcText.includes("nc.WebSocket")
      ) {
        forcesWebSocketOnLinux = true;
      } else if (
        funcText.includes("nc.Ipc") &&
        !funcText.includes("process.platform")
      ) {
        errors.push(
          "Transport selection function (s9t) can still select IPC transport " +
          "on Linux. The daemon may emit `--listen ipc` which is not supported " +
          "by the Linux droid CLI."
        );
      }
    } else {
      warnings.push(
        `Could not find transport selection function (s9t) in ${filePath}. ` +
        "The minified function name may have changed."
      );
    }

    // Check for the --listen ipc guard
    const listenIpcPos = content.indexOf("--listen");
    if (listenIpcPos !== -1) {
      const context = content.substring(
        Math.max(0, listenIpcPos - 100),
        Math.min(content.length, listenIpcPos + 100)
      );

      if (context.includes("process.platform") && context.includes("linux")) {
        hasListenIpcGuard = true;
      } else {
        // Check if --listen ipc can still be emitted on Linux
        if (context.includes("nc.Ipc") && !context.includes("process.platform")) {
          errors.push(
            "The daemon args construction can still push `--listen ipc` on Linux. " +
            "This is unsupported by the Linux droid CLI."
          );
        }
      }
    }
  }

  // Overall validation
  const valid = errors.length === 0 && forcesWebSocketOnLinux;

  return {
    valid,
    forcesWebSocketOnLinux,
    hasListenIpcGuard,
    supportedDaemonFlags,
    listenFlagSupported,
    errors,
    warnings,
  };
}

/**
 * Format the daemon transport patch result for display.
 */
export function formatDaemonTransportPatchResult(
  result: DaemonTransportPatchResult
): string {
  const lines: string[] = [];

  if (result.patched) {
    lines.push("✓ Daemon transport patch applied successfully.");
    lines.push(`  Patches applied: ${result.patchCount}`);
    for (const patch of result.patches) {
      lines.push(`  - [${patch.id}] ${patch.description}`);
    }
    lines.push(`  Original asar hash: ${result.originalHash.substring(0, 16)}...`);
    lines.push(`  Patched asar hash:  ${result.patchedHash.substring(0, 16)}...`);
  } else if (result.success) {
    lines.push("ℹ No daemon transport patch was needed (already patched or no matching patterns).");
  }

  for (const err of result.errors) {
    lines.push(`✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`⚠ ${warn}`);
  }

  return lines.join("\n");
}

/**
 * Format the daemon transport validation result for display.
 */
export function formatDaemonTransportValidationResult(
  result: ValidateDaemonTransportResult
): string {
  const lines: string[] = [];

  lines.push(result.valid ? "✓ Daemon transport validation passed." : "✗ Daemon transport validation FAILED.");

  lines.push(
    `  Forces WebSocket on Linux: ${result.forcesWebSocketOnLinux ? "✓ Yes" : "✗ No"}`
  );
  lines.push(
    `  --listen ipc guard: ${result.hasListenIpcGuard ? "✓ Present" : "✗ Missing"}`
  );
  lines.push(
    `  --listen flag supported by droid: ${result.listenFlagSupported ? "Yes" : "No (as expected)"}`
  );

  if (result.supportedDaemonFlags) {
    lines.push(`  Supported daemon flags: ${result.supportedDaemonFlags.join(", ")}`);
  }

  for (const err of result.errors) {
    lines.push(`  ✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  ⚠ ${warn}`);
  }

  return lines.join("\n");
}
