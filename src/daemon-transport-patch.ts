/**
 * Daemon transport compatibility patch for Linux builds.
 *
 * Problem: Factory Desktop's app.asar contains a daemon transport selection
 * function that can select IPC transport based on a Statsig feature flag
 * (`DesktopDaemonIpc`). When IPC is selected, the app emits
 * `droid daemon --listen ipc`. Older Linux droid CLIs did not support
 * `--listen` at all; the latest droid CLI supports it with choices
 * `websocket`/`ipc` (default: `websocket`), but IPC transport is still
 * unreliable on Linux (no proper IPC channel setup).
 *
 * Fix: Patch the app.asar to force WebSocket transport on Linux by:
 * 1. Modifying the transport selection function to return WebSocket on Linux
 * 2. Adding a defense-in-depth guard to prevent `--listen ipc` on Linux
 *
 * Version-agnostic design: Instead of matching exact minified strings (which
 * change between Factory Desktop versions), this patch uses regex patterns
 * that match the structural shape of the code:
 * - The transport resolver matches `DesktopDaemonIpc` + `.Ipc` / `.WebSocket`
 *   enum references, regardless of the minified variable names.
 * - The `--listen ipc` push matches the `push("--listen","ipc")` call
 *   regardless of the surrounding variable names.
 *
 * Fulfills: VAL-DAEMON-001, VAL-DAEMON-002
 */

import * as fs from "fs";
import {
  applyAsarContentPatch,
  applyRegexPatch,
  computeFileHash,
  findMainBundleFiles,
  type RegexPatchResult,
} from "./patches/asar-patcher";

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
  /** Whether packaged Linux resolves droid from the system CLI */
  hasSystemDroidPathPatch: boolean;
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
const SYSTEM_DROID_MARKER = "/* linux-system-droid-cli-patch */";

/**
 * Regex matching the transport selection function.
 *
 * The function shape (de-minified) is:
 * ```ts
 * async function <name>() {
 *   const e = <FlagEnum>.DesktopDaemonIpc;
 *   try {
 *     return (await <getFlag>())[e.statsigName] ?? e.defaultValue
 *       ? <TransportEnum>.Ipc : <TransportEnum>.WebSocket;
 *   } catch(t) {
 *     ... e.defaultValue ? <TransportEnum>.Ipc : <TransportEnum>.WebSocket;
 *   }
 * }
 * ```
 *
 * The regex captures:
 * - $1: everything before the function body's first statement
 * - $2: the rest of the function (from `const e=` to the end)
 *
 * We inject `if(process.platform==="linux")return <ws-enum>.WebSocket;`
 * between the function opening and the original body.
 *
 * The pattern matches any minified names because it anchors on:
 * - `DesktopDaemonIpc` (stable property name)
 * - `return` + ternary with `.Ipc` and `.WebSocket`
 */
const TRANSPORT_RESOLVER_REGEX =
  /(async function [\w$]+\(\)\{)(const [\w$]+=[\w$]+\.DesktopDaemonIpc;[\s\S]*?\?[\w$]+\.Ipc:[\w$]+\.WebSocket\})/;

/**
 * Build the replacement for the transport resolver.
 *
 * Extracts the WebSocket enum reference from the matched function so the
 * injected guard uses the same minified name as the original code.
 */
function buildTransportResolverReplacement(
  match: string,
  prefix: string,
  body: string,
): string {
  // Extract the WebSocket enum reference (e.g. "nc.WebSocket", "Ms.WebSocket", or "$s.WebSocket")
  const wsMatch = body.match(/([\w$]+\.WebSocket)/);
  const wsRef = wsMatch ? wsMatch[1] : '"".WebSocket'; // fallback should never hit
  return (
    prefix +
    `if(process.platform==="linux")return ${wsRef};` +
    body +
    match.substring(prefix.length + body.length)
  );
}

/**
 * Regex matching the `--listen ipc` arg push.
 *
 * The minified pattern is:
 * ```js
 * if(t===<enum>.Ipc&&a.push("--listen","ipc"))
 * ```
 *
 * We capture the enum reference and the push call, then inject
 * `process.platform!=="linux"&&` before the push.
 */
const LISTEN_IPC_PUSH_REGEX =
  /([\w$]+\.Ipc)&&([\w$]+\.push\("--listen","ipc"\))/;

/**
 * Build the replacement for the --listen ipc push.
 */
function buildListenIpcReplacement(
  enumRef: string,
  pushCall: string,
): string {
  return `${enumRef}&&process.platform!=="linux"&&${pushCall}`;
}

const PACKAGED_DROID_PATH_REGEX =
  /(\w+)\.app\.isPackaged\)r=(\w+)\.join\(process\.resourcesPath,"bin",process\.platform==="win32"\?"droid\.exe":"droid"\)/;

function buildSystemDroidPathReplacement(appAlias: string, pathAlias: string): string {
  return (
    `${appAlias}.app.isPackaged)r=process.platform==="linux"?(()=>{${SYSTEM_DROID_MARKER}` +
    `try{const f=require("fs"),p=require("path"),cp=require("child_process"),os=require("os");` +
    `if(process.env.FACTORY_DROID_PATH&&f.existsSync(process.env.FACTORY_DROID_PATH))return process.env.FACTORY_DROID_PATH;` +
    `try{const v=cp.execFileSync("sh",["-lc","command -v droid"],{encoding:"utf-8",timeout:2000}).trim();if(v)return v}catch(e){}` +
    `const c=[p.join(os.homedir(),".local","bin","droid"),"/usr/local/bin/droid","/usr/bin/droid"];for(const x of c)if(f.existsSync(x))return x;return c[0]` +
    `}catch(e){return require("path").join(require("os").homedir(),".local","bin","droid")}})():${pathAlias}.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid")`
  );
}

// ─── Core Patching Functions ────────────────────────────────────────────────

/**
 * Apply the Linux daemon transport compatibility patch to an app.asar.
 *
 * This patches the bundled Vite JS inside the asar to:
 * 1. Force WebSocket transport on Linux (preventing `--listen ipc`)
 * 2. Add a defense-in-depth guard against `--listen ipc` on Linux
 *
 * Both patches use regex patterns that match the structural shape of the
 * code, not exact minified strings, so they survive upstream version bumps.
 *
 * VAL-DAEMON-001: The app must not emit `--listen ipc` for Linux droid.
 * VAL-DAEMON-002: The daemon must reach healthy runtime state.
 */
export async function patchDaemonTransport(
  options: DaemonTransportPatchOptions,
): Promise<DaemonTransportPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: DaemonPatch[] = [];
  const skipIfPatched = options.skipIfPatched ?? true;

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
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

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
        `Patching all of them: ${mainBundleFiles.join(", ")}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let totalPatchCount = 0;
  let alreadyPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (
      skipIfPatched &&
      content.includes(PATCH_MARKER) &&
      content.includes(SYSTEM_DROID_MARKER)
    ) {
      alreadyPatched = true;
      warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      continue;
    }

    let patchedContent = content;
    let filePatchCount = 0;

    // Patch 1: Force WebSocket transport on Linux
    const transportResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      TRANSPORT_RESOLVER_REGEX,
      (match, prefix, body) =>
        PATCH_MARKER + buildTransportResolverReplacement(match, prefix, body),
    );

    if (transportResult.matched) {
      patchedContent = transportResult.content;
      filePatchCount++;
      patches.push({
        id: "force-websocket-on-linux",
        description:
          "Inject process.platform===\"linux\" guard into transport " +
          "resolver to force WebSocket on Linux",
        originalSnippet: transportResult.match.substring(0, 80) + "...",
        replacementSnippet: "...force WebSocket on Linux...",
      });
    } else {
      // Check if the function exists at all
      if (content.includes("DesktopDaemonIpc")) {
        if (
          content.includes("process.platform") &&
          content.includes("DesktopDaemonIpc")
        ) {
          warnings.push(
            `Transport resolver in ${bundleFile} may already have a Linux guard. ` +
              `Skipping patch 1.`,
          );
        } else {
          errors.push(
            `Found DesktopDaemonIpc in ${bundleFile} but transport resolver regex did not match. ` +
              `The function shape may have changed. Manual inspection required.`,
          );
        }
      }
      // If DesktopDaemonIpc is not in this file, it's just a different bundle — not an error.
    }

    // Patch 2: Defense-in-depth: prevent --listen ipc on Linux
    const listenResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      LISTEN_IPC_PUSH_REGEX,
      (_match, enumRef, pushCall) =>
        buildListenIpcReplacement(enumRef, pushCall),
    );

    if (listenResult.matched) {
      patchedContent = listenResult.content;
      filePatchCount++;
      patches.push({
        id: "prevent-listen-ipc-on-linux",
        description:
          "Add process.platform!==\"linux\" guard to --listen ipc arg push " +
            "as a defense-in-depth measure",
        originalSnippet: listenResult.match,
        replacementSnippet: "...add Linux guard...",
      });
    }

    // Patch 3: packaged Linux app must use the system droid CLI, not a
    // resources/bin/droid copy that can drift from the user's remote daemon.
    const systemDroidResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      PACKAGED_DROID_PATH_REGEX,
      (_match, appAlias, pathAlias) => buildSystemDroidPathReplacement(appAlias, pathAlias),
    );

    if (systemDroidResult.matched) {
      patchedContent = systemDroidResult.content;
      filePatchCount++;
      patches.push({
        id: "use-system-droid-cli",
        description:
          "Resolve packaged Linux daemon binary from the system droid CLI " +
          "instead of resources/bin/droid",
        originalSnippet: systemDroidResult.match,
        replacementSnippet: "...resolve system droid CLI...",
      });
    } else if (
      content.includes("process.resourcesPath") &&
      content.includes("droid-path") &&
      !content.includes(SYSTEM_DROID_MARKER)
    ) {
      errors.push(
        `Found packaged droid path logic in ${bundleFile} but system droid ` +
          `regex did not match. Manual inspection required.`,
      );
    }
    // If --listen ipc push isn't found, it may have already been patched or
    // the code structure changed. Not an error — the transport resolver
    // patch is the primary fix.

    if (filePatchCount > 0) {
      try {
        await applyAsarContentPatch(
          options.asarPath,
          bundleFile,
          patchedContent,
        );
      } catch (err) {
        errors.push(
          `Failed to apply patch to ${bundleFile} in asar: ${String(err)}`,
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
        "target code patterns may have changed.",
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

// ─── Validation Functions ───────────────────────────────────────────────────

/**
 * Validate that the daemon transport patch has been correctly applied
 * to an app.asar.
 *
 * VAL-DAEMON-001: Linux app uses droid-supported daemon transport.
 * VAL-DAEMON-002: Linux droid daemon reaches healthy runtime state.
 */
export function validateDaemonTransport(
  options: ValidateDaemonTransportOptions,
): ValidateDaemonTransportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      forcesWebSocketOnLinux: false,
      hasListenIpcGuard: false,
      hasSystemDroidPathPatch: false,
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

      const flagPattern = /--[\w-]+/g;
      supportedDaemonFlags = [
        ...new Set<string>(helpOutput.match(flagPattern) || []),
      ];
      listenFlagSupported = supportedDaemonFlags.includes("--listen");

      if (listenFlagSupported) {
        warnings.push(
          "The system droid daemon supports --listen (choices: websocket/ipc). " +
            "The transport patch still forces WebSocket as defense-in-depth. " +
            `Supported flags: ${supportedDaemonFlags.join(", ")}`,
        );
      }
    } catch (err) {
      warnings.push(
        `Could not run droid daemon --help: ${String(err)}. ` +
          "Skipping supported flags check.",
      );
    }
  }

  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  let forcesWebSocketOnLinux = false;
  let hasListenIpcGuard = false;
  let hasSystemDroidPathPatch = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    // Check for the WebSocket transport guard on Linux.
    // Version-agnostic: look for process.platform==="linux" near
    // .WebSocket in the context of DesktopDaemonIpc.
    if (content.includes("DesktopDaemonIpc")) {
      // Find the transport resolver function using the same regex
      const match = content.match(TRANSPORT_RESOLVER_REGEX);
      if (match) {
        const funcText = match[0];
        if (
          funcText.includes('process.platform==="linux"') &&
          funcText.includes(".WebSocket")
        ) {
          forcesWebSocketOnLinux = true;
        } else if (!funcText.includes("process.platform")) {
          errors.push(
            "Transport resolver can still select IPC transport on Linux. " +
              "The daemon may emit `--listen ipc` which is unreliable " +
              "on Linux (IPC channel setup issues).",
          );
        }
      } else {
        // DesktopDaemonIpc is present but the regex didn't match —
        // the function shape changed.
        if (content.includes(PATCH_MARKER)) {
          forcesWebSocketOnLinux = true;
        } else {
          warnings.push(
            `Found DesktopDaemonIpc in ${bundleFile} but could not parse transport resolver. ` +
              "The function shape may have changed.",
          );
        }
      }
    }

    // Check for the --listen ipc guard (version-agnostic)
    const listenMatch = content.match(LISTEN_IPC_PUSH_REGEX);
    if (listenMatch) {
      // Check if the matched call already has a Linux guard
      const context = content.substring(
        Math.max(
          0,
          content.indexOf(listenMatch[0]) - 100,
        ),
        Math.min(
          content.length,
          content.indexOf(listenMatch[0]) + listenMatch[0].length + 100,
        ),
      );
      if (
        context.includes("process.platform") &&
        context.includes("linux")
      ) {
        hasListenIpcGuard = true;
      } else {
        errors.push(
          "The daemon args construction can still push `--listen ipc` on Linux. " +
            "IPC transport is unreliable on Linux (no proper IPC channel setup).",
        );
      }
    } else if (content.includes("--listen")) {
      // --listen exists but not in the expected push pattern
      hasListenIpcGuard = true; // Already patched or different structure
    }

    if (content.includes(SYSTEM_DROID_MARKER)) {
      hasSystemDroidPathPatch = true;
    } else if (
      content.includes("process.resourcesPath") &&
      content.includes("droid-path")
    ) {
      errors.push(
        "Packaged Linux daemon still resolves droid from process.resourcesPath/bin/droid.",
      );
    }
  }

  const valid = errors.length === 0 && forcesWebSocketOnLinux && hasSystemDroidPathPatch;

  return {
    valid,
    forcesWebSocketOnLinux,
    hasListenIpcGuard,
    hasSystemDroidPathPatch,
    supportedDaemonFlags,
    listenFlagSupported,
    errors,
    warnings,
  };
}

// ─── Formatting Functions ───────────────────────────────────────────────────

/**
 * Format the daemon transport patch result for display.
 */
export function formatDaemonTransportPatchResult(
  result: DaemonTransportPatchResult,
): string {
  const lines: string[] = [];

  if (result.patched) {
    lines.push("✓ Daemon transport patch applied successfully.");
    lines.push(`  Patches applied: ${result.patchCount}`);
    for (const patch of result.patches) {
      lines.push(`  - [${patch.id}] ${patch.description}`);
    }
    lines.push(
      `  Original asar hash: ${result.originalHash.substring(0, 16)}...`,
    );
    lines.push(
      `  Patched asar hash:  ${result.patchedHash.substring(0, 16)}...`,
    );
  } else if (result.success) {
    lines.push(
      "ℹ No daemon transport patch was needed (already patched or no matching patterns).",
    );
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
  result: ValidateDaemonTransportResult,
): string {
  const lines: string[] = [];

  lines.push(
    result.valid
      ? "✓ Daemon transport validation passed."
      : "✗ Daemon transport validation FAILED.",
  );

  lines.push(
    `  Forces WebSocket on Linux: ${result.forcesWebSocketOnLinux ? "✓ Yes" : "✗ No"}`,
  );
  lines.push(
    `  --listen ipc guard: ${result.hasListenIpcGuard ? "✓ Present" : "✗ Missing"}`,
  );
  lines.push(
    `  System droid CLI resolver: ${result.hasSystemDroidPathPatch ? "✓ Present" : "✗ Missing"}`,
  );
  lines.push(
    `  --listen flag supported by droid: ${result.listenFlagSupported ? "Yes" : "No (as expected)"}`,
  );

  if (result.supportedDaemonFlags) {
    lines.push(
      `  Supported daemon flags: ${result.supportedDaemonFlags.join(", ")}`,
    );
  }

  for (const err of result.errors) {
    lines.push(`  ✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  ⚠ ${warn}`);
  }

  return lines.join("\n");
}
