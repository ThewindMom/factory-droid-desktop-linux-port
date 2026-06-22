/**
 * Window controls compatibility patch for Linux builds.
 *
 * Problem: Factory Desktop sets `titleBarStyle: "hidden"` when not on
 * Windows. On macOS, `"hidden"` is fine because the OS draws traffic
 * light buttons. On Linux, `"hidden"` means no title bar at all — no
 * minimize, maximize, or close buttons.
 *
 * Fix: On Linux, keep `titleBarStyle: "hidden"` but add `titleBarOverlay`
 * with static dark colors (`#1e1e1e` background, `#cccccc` symbols).
 * This gives a frameless window with Electron-drawn min/max/close buttons
 * (like Windows). Static colors are used because `nativeTheme` may not
 * be initialized at BrowserWindow construction time, causing the window
 * to silently fail to appear.
 *
 * Version-agnostic design: The regex matches the ternary pattern
 * `titleBarStyle:<var>?"default":"hidden"` regardless of the minified
 * variable name. The replacement injects `titleBarOverlay` as a sibling
 * property in the BrowserWindow options object.
 *
 * Fulfills: VAL-WINDOW-001
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

export interface WindowControlsPatchOptions {
  asarPath: string;
  skipIfPatched?: boolean;
  tolerateMissingTarget?: boolean;
}

export interface WindowControlsPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: WindowControlsPatch[];
  errors: string[];
  warnings: string[];
}

export interface WindowControlsPatch {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

export interface ValidateWindowControlsOptions {
  asarPath: string;
}

export interface ValidateWindowControlsResult {
  valid: boolean;
  titleBarOverlayOnLinux: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

const PATCH_MARKER = "/* linux-titlebar-overlay-patch */";

/**
 * Regex matching the titleBarStyle ternary.
 *
 * The minified pattern is:
 * ```js
 * titleBarStyle:<var>?"default":"hidden"
 * ```
 * where `<var>` is typically `process.platform === "win32"`.
 *
 * We capture:
 * - Group 1: the `titleBarStyle:` prefix
 * - Group 2: the variable name (e.g., `r`)
 * - Group 3: the trailing comma (to inject a sibling property)
 *
 * The replacement produces:
 * ```js
 * titleBarStyle:process.platform==="linux"?"hidden":(<var>?"default":"hidden"),
 * titleBarOverlay:process.platform==="linux"?{color:"#1e1e1e",symbolColor:"#cccccc",height:30}:void 0,
 * ```
 *
 * Static dark colors are used because `nativeTheme` may not be
 * initialized at BrowserWindow construction time, causing the window
 * to silently fail to appear. The `titleBarOverlay` property is only
 * set on Linux; on other platforms it's `void 0` (undefined),
 * preserving original behavior.
 */
const TITLE_BAR_STYLE_REGEX =
  /(titleBarStyle:)(\w+)\?"default":"hidden"(,)/;

/**
 * Find the Electron module alias by looking for `<alias>.BrowserWindow`
 * near the titleBarStyle match site. Returns the alias string (e.g., "Y").
 */
function findElectronAlias(content: string, matchPos: number): string | null {
  // Search backwards from the match position for <alias>.BrowserWindow
  const searchStart = Math.max(0, matchPos - 5000);
  const searchRegion = content.substring(searchStart, matchPos + 200);
  const match = searchRegion.match(
    /([A-Za-z_$][\w$]*)\.BrowserWindow\b/,
  );
  return match ? match[1] : null;
}

// ─── Core Patching Functions ────────────────────────────────────────────────

export async function patchWindowControls(
  options: WindowControlsPatchOptions,
): Promise<WindowControlsPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: WindowControlsPatch[] = [];
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

    // Also skip if the old "default" patch marker is present
    if (skipIfPatched && content.includes("/* linux-window-controls-patch */")) {
      alreadyPatched = true;
      warnings.push(
        `Bundle ${bundleFile} has the old "default" titlebar patch. ` +
          `Rebuilding from a fresh DMG is required to apply the overlay patch.`,
      );
      continue;
    }

    if (!content.includes("titleBarStyle")) continue;

    // Find the match position to locate the Electron alias
    const match = content.match(TITLE_BAR_STYLE_REGEX);
    if (!match || match.index === undefined) continue;

    const electronAlias = findElectronAlias(content, match.index);
    if (!electronAlias) {
      errors.push(
        `Could not find Electron module alias (e.g., Y.BrowserWindow) ` +
          `near titleBarStyle in ${bundleFile}. Skipping patch.`,
      );
      continue;
    }

    let patchedContent = content;

    const simpleResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      TITLE_BAR_STYLE_REGEX,
      (_match, _prefix, varRef, _comma) => {
        const overlayConfig = `{color:"#1e1e1e",symbolColor:"#cccccc",height:30}`;
        return (
          `titleBarStyle:process.platform==="linux"?"hidden":(${varRef}?"default":"hidden"),` +
          `${PATCH_MARKER}titleBarOverlay:process.platform==="linux"?${overlayConfig}:void 0,`
        );
      },
    );

    if (simpleResult.matched) {
      patchedContent = simpleResult.content;

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

      totalPatchCount++;
      patches.push({
        id: "linux-titlebar-overlay",
        description:
          "Inject titleBarOverlay on Linux with static dark colors " +
            "for frameless window with Electron-drawn buttons",
        originalSnippet: simpleResult.match,
        replacementSnippet:
          `titleBarStyle:process.platform==="linux"?"hidden":(VAR?"default":"hidden"),` +
          `${PATCH_MARKER}titleBarOverlay:process.platform==="linux"?{color,symbolColor,height}:void 0,`,
      });
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
      "No window controls patches were applied. The asar may already be " +
        "patched, or no titleBarStyle references were found.",
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

export function validateWindowControls(
  options: ValidateWindowControlsOptions,
): ValidateWindowControlsResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      titleBarOverlayOnLinux: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  let titleBarOverlayOnLinux = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (!content.includes("titleBarStyle")) continue;

    // Check for the new overlay patch marker
    if (content.includes(PATCH_MARKER)) {
      titleBarOverlayOnLinux = true;
      continue;
    }

    // Check for the old "default" patch marker (still valid, just different approach)
    if (content.includes("/* linux-window-controls-patch */")) {
      titleBarOverlayOnLinux = true;
      continue;
    }

    // Check for unpatched titleBarStyle:hidden on Linux
    const match = content.match(TITLE_BAR_STYLE_REGEX);
    if (match) {
      errors.push(
        'titleBarStyle is set to "hidden" on Linux with no titleBarOverlay. ' +
          "The window will have no title bar or min/max/close buttons.",
      );
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    titleBarOverlayOnLinux,
    errors,
    warnings,
  };
}

// ─── Formatting Functions ───────────────────────────────────────────────────

export function formatWindowControlsPatchResult(
  result: WindowControlsPatchResult,
): string {
  const lines: string[] = [];

  if (result.patched) {
    lines.push("✓ Window controls patch applied successfully.");
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
      "ℹ No window controls patch was needed (already patched or no titleBarStyle references).",
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

export function formatWindowControlsValidationResult(
  result: ValidateWindowControlsResult,
): string {
  const lines: string[] = [];

  lines.push(
    result.valid
      ? "✓ Window controls validation passed."
      : "✗ Window controls validation FAILED.",
  );

  lines.push(
    `  titleBarOverlay on Linux: ${result.titleBarOverlayOnLinux ? "✓ Yes" : "✗ No"}`,
  );

  for (const err of result.errors) {
    lines.push(`  ✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  ⚠ ${warn}`);
  }

  return lines.join("\n");
}
