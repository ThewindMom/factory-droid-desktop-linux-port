/**
 * Auto-updater compatibility patch for Linux builds.
 *
 * Problem: Factory Desktop's app.asar uses Electron's built-in `autoUpdater`
 * to check for updates and install them. On Linux, the feed URL format and
 * `serverType` may not work (Factory's S3 may not serve a `/linux/x64`
 * update endpoint), and `autoUpdater.quitAndInstall()` would attempt to
 * install a macOS/Windows update package. The `error` event handler calls
 * `app.quit()` — a potential crash-on-launch.
 *
 * Fix: Guard all `autoUpdater.checkForUpdates()` and
 * `autoUpdater.quitAndInstall()` calls with `process.platform !== "linux"`
 * so the built-in auto-updater is a no-op on Linux. Our Rust-based
 * `factory-update-manager` handles Linux updates independently.
 *
 * Version-agnostic design: Uses regex patterns that match the structural
 * shape of the code (the `autoUpdater` property access + method call),
 * not exact minified strings.
 *
 * Fulfills: VAL-UPDATER-001
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

/** Options for patching the auto-updater */
export interface AutoUpdaterPatchOptions {
  /** Path to the app.asar file to patch (modified in-place) */
  asarPath: string;
  /** Skip patching if already patched (default: true) */
  skipIfPatched?: boolean;
  /**
   * Succeed (without patching) when the asar doesn't contain the expected
   * Vite bundle structure. Default: false.
   */
  tolerateMissingTarget?: boolean;
}

/** Result of auto-updater patching */
export interface AutoUpdaterPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: AutoUpdaterPatch[];
  errors: string[];
  warnings: string[];
}

/** Description of a single patch applied */
export interface AutoUpdaterPatch {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

/** Options for validating the auto-updater patch */
export interface ValidateAutoUpdaterOptions {
  asarPath: string;
}

/** Result of auto-updater validation */
export interface ValidateAutoUpdaterResult {
  valid: boolean;
  /** Whether checkForUpdates is guarded on Linux */
  checkForUpdatesGuarded: boolean;
  /** Whether quitAndInstall is guarded on Linux */
  quitAndInstallGuarded: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

const PATCH_MARKER = "/* linux-auto-updater-patch */";

/**
 * Regex matching `autoUpdater.checkForUpdates()`.
 *
 * Matches patterns like:
 * - `Y.autoUpdater.checkForUpdates()`
 * - `e.autoUpdater.checkForUpdates()`
 * - `ce.autoUpdater.checkForUpdates()`
 *
 * Captures:
 * - $1: the object reference (e.g. `Y`, `e`, `ce`)
 * - $2: the `()` or `()` with possible whitespace
 *
 * We inject `process.platform!=="linux"&&` before the call so it becomes
 * a no-op on Linux. The `void 0` fallback ensures the expression evaluates
 * to `undefined` (falsy) on Linux when used in a boolean context.
 */
const CHECK_FOR_UPDATES_REGEX =
  /(\w+\.autoUpdater\.checkForUpdates\(\))/g;

/**
 * Regex matching `autoUpdater.quitAndInstall()`.
 *
 * Same capture pattern as above. We guard with
 * `process.platform!=="linux"&&` to prevent install on Linux.
 */
const QUIT_AND_INSTALL_REGEX =
  /(\w+\.autoUpdater\.quitAndInstall\(\))/g;

/**
 * Regex matching the auto-updater error handler that calls `app.quit()`.
 *
 * The pattern is:
 * ```js
 * autoUpdater.once("error",async <arrow-or-name>=>{...app.quit()...})
 * ```
 *
 * We guard the `app.quit()` inside the error handler so a failed auto-update
 * check doesn't crash the app on Linux.
 */
const ERROR_HANDLER_QUIT_REGEX =
  /(\w+\.autoUpdater\.once\("error",[\s\S]*?\w+\.app\.quit\(\)\})/;

// ─── Core Patching Functions ────────────────────────────────────────────────

/**
 * Apply the Linux auto-updater compatibility patch to an app.asar.
 *
 * Patches:
 * 1. Guard `autoUpdater.checkForUpdates()` with `process.platform!=="linux"`
 * 2. Guard `autoUpdater.quitAndInstall()` with `process.platform!=="linux"`
 * 3. Guard `app.quit()` in the auto-updater error handler
 *
 * All patches use regex patterns matching structural code shape, not exact
 * minified strings, so they survive upstream version bumps.
 */
export async function patchAutoUpdater(
  options: AutoUpdaterPatchOptions,
): Promise<AutoUpdaterPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: AutoUpdaterPatch[] = [];
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
      "Could not find the main Vite bundle file (.vite/build/index-*.js) in the asar.";

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

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let totalPatchCount = 0;
  let alreadyPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (skipIfPatched && content.includes(PATCH_MARKER)) {
      alreadyPatched = true;
      warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      continue;
    }

    // Only patch files that actually contain autoUpdater references
    if (!content.includes("autoUpdater")) continue;

    let patchedContent = content;
    let filePatchCount = 0;

    // Only inject the patch marker once (on the first patch in this file)
    let markerInjected = false;

    // Patch 1: Guard checkForUpdates()
    const checkResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      CHECK_FOR_UPDATES_REGEX,
      (_match, call) => {
        const marker = markerInjected ? "" : PATCH_MARKER;
        markerInjected = true;
        return `${marker}process.platform!=="linux"&&${call}`;
      },
    );

    if (checkResult.matched) {
      patchedContent = checkResult.content;
      filePatchCount++;
      patches.push({
        id: "guard-check-for-updates",
        description:
          'Guard autoUpdater.checkForUpdates() with process.platform!=="linux"',
        originalSnippet: checkResult.match,
        replacementSnippet: "...guard with Linux check...",
      });
    }

    // Patch 2: Guard quitAndInstall()
    const quitResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      QUIT_AND_INSTALL_REGEX,
      (_match, call) =>
        `process.platform!=="linux"&&${call}`,
    );

    if (quitResult.matched) {
      patchedContent = quitResult.content;
      filePatchCount++;
      patches.push({
        id: "guard-quit-and-install",
        description:
          'Guard autoUpdater.quitAndInstall() with process.platform!=="linux"',
        originalSnippet: quitResult.match,
        replacementSnippet: "...guard with Linux check...",
      });
    }

    // Patch 3: Guard app.quit() in auto-updater error handler
    const errorResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      ERROR_HANDLER_QUIT_REGEX,
      (_match, handler) => {
        // Replace app.quit() inside the handler with a guarded version
        const guarded = handler.replace(
          /(\w+)\.app\.quit\(\)/,
          'process.platform!=="linux"&&$1.app.quit()',
        );
        return guarded;
      },
    );

    if (errorResult.matched) {
      patchedContent = errorResult.content;
      filePatchCount++;
      patches.push({
        id: "guard-error-handler-quit",
        description:
          "Guard app.quit() in auto-updater error handler on Linux",
        originalSnippet: errorResult.match.substring(0, 80) + "...",
        replacementSnippet: "...guard quit on Linux...",
      });
    }

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
    } else if (content.includes("autoUpdater")) {
      // autoUpdater is present but no patterns matched — could be already
      // patched or the code shape changed.
      warnings.push(
        `Bundle ${bundleFile} contains autoUpdater references but no ` +
          `patch patterns matched. The code shape may have changed or ` +
          `the patch may already be applied.`,
      );
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
      "No auto-updater patches were applied. The asar may already be " +
        "patched, or no autoUpdater references were found.",
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
 * Validate that the auto-updater patch has been correctly applied.
 */
export function validateAutoUpdater(
  options: ValidateAutoUpdaterOptions,
): ValidateAutoUpdaterResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      checkForUpdatesGuarded: false,
      quitAndInstallGuarded: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  let checkForUpdatesGuarded = false;
  let quitAndInstallGuarded = false;
  let hasAutoUpdater = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (!content.includes("autoUpdater")) continue;
    hasAutoUpdater = true;

    // Check if all checkForUpdates calls are guarded
    const checkMatches = content.match(CHECK_FOR_UPDATES_REGEX);
    if (checkMatches) {
      for (const matchStr of checkMatches) {
        const pos = content.indexOf(matchStr);
        const before = content.substring(
          Math.max(0, pos - 60),
          pos,
        );
        if (
          before.includes('process.platform!=="linux"') ||
          before.includes(PATCH_MARKER)
        ) {
          checkForUpdatesGuarded = true;
        } else {
          errors.push(
            "autoUpdater.checkForUpdates() is not guarded on Linux. " +
              "The built-in auto-updater may attempt to check for updates " +
              "on Linux, which could fail and crash the app.",
          );
        }
      }
    }

    // Check if all quitAndInstall calls are guarded
    const quitMatches = content.match(QUIT_AND_INSTALL_REGEX);
    if (quitMatches) {
      for (const matchStr of quitMatches) {
        const pos = content.indexOf(matchStr);
        const before = content.substring(
          Math.max(0, pos - 60),
          pos,
        );
        if (before.includes('process.platform!=="linux"')) {
          quitAndInstallGuarded = true;
        } else {
          errors.push(
            "autoUpdater.quitAndInstall() is not guarded on Linux. " +
              "The app may attempt to install a macOS/Windows update on Linux.",
          );
        }
      }
    }
  }

  if (!hasAutoUpdater) {
    warnings.push(
      "No autoUpdater references found in the asar. The app may not use " +
        "Electron's built-in auto-updater.",
    );
  }

  const valid = errors.length === 0;

  return {
    valid,
    checkForUpdatesGuarded,
    quitAndInstallGuarded,
    errors,
    warnings,
  };
}

// ─── Formatting Functions ───────────────────────────────────────────────────

/**
 * Format the auto-updater patch result for display.
 */
export function formatAutoUpdaterPatchResult(
  result: AutoUpdaterPatchResult,
): string {
  const lines: string[] = [];

  if (result.patched) {
    lines.push("✓ Auto-updater patch applied successfully.");
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
      "ℹ No auto-updater patch was needed (already patched or no autoUpdater references).",
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
 * Format the auto-updater validation result for display.
 */
export function formatAutoUpdaterValidationResult(
  result: ValidateAutoUpdaterResult,
): string {
  const lines: string[] = [];

  lines.push(
    result.valid
      ? "✓ Auto-updater validation passed."
      : "✗ Auto-updater validation FAILED.",
  );

  lines.push(
    `  checkForUpdates guarded: ${result.checkForUpdatesGuarded ? "✓ Yes" : "✗ No"}`,
  );
  lines.push(
    `  quitAndInstall guarded: ${result.quitAndInstallGuarded ? "✓ Yes" : "✗ No"}`,
  );

  for (const err of result.errors) {
    lines.push(`  ✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  ⚠ ${warn}`);
  }

  return lines.join("\n");
}
