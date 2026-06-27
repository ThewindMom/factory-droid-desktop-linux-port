/**
 * Core patch registry for Linux builds.
 *
 * Mirrors the codex-desktop-linux patch-registry model: each Linux
 * compatibility fix is a registered patch with a stable id, description,
 * apply(), and an isolated result. Patches are discoverable, individually
 * testable, and fail loudly when their needle is missing.
 *
 * Design rule:
 * - Required for the app to launch/behave correctly on Linux for most users
 *   -> register here as a core patch.
 *
 * The registry delegates to the existing tested patch implementations; new
 * patches are added by registering a {@link Patch} without touching the
 * assembly pipeline.
 */

import type { DaemonTransportPatchResult } from "../daemon-transport-patch";
import { patchDaemonTransport } from "../daemon-transport-patch";
import { patchAutoUpdater } from "../auto-updater-patch";
import { patchWindowControls } from "../window-controls-patch";
import { patchAboutPanel } from "../about-panel-patch";

// ─── Patch contract ────────────────────────────────────────────────────────

/** Options passed to every registered patch. */
export interface PatchApplyOptions {
  /** Path to the app.asar file to patch (modified in-place). */
  asarPath: string;
  /**
   * Succeed (without patching) when the asar doesn't contain the expected
   * target structure. Useful for test/mock asars. Default: false.
   */
  tolerateMissingTarget?: boolean;
  /** Skip patching if already patched. Default: true. */
  skipIfPatched?: boolean;
}

/** Individual needle applied by a patch. */
export interface PatchNeedle {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

/** Outcome of a single registered patch. */
export interface PatchOutcome {
  /** Stable patch identifier. */
  id: string;
  /** Human-readable description of what the patch does. */
  description: string;
  /** Whether the patch applied successfully. */
  success: boolean;
  /** Whether any changes were made (false if already patched). */
  patched: boolean;
  /** SHA-256 of the asar before this patch ran. */
  originalHash: string;
  /** SHA-256 of the asar after this patch ran. */
  patchedHash: string;
  /** Individual needles applied by this patch. */
  patches: PatchNeedle[];
  /** Errors encountered by this patch. */
  errors: string[];
  /** Warnings emitted by this patch. */
  warnings: string[];
}

/** Aggregate result of applying all registered patches. */
export interface RegisteredPatchesResult {
  /** Whether every registered patch succeeded. */
  success: boolean;
  /** Whether any patch made changes. */
  patched: boolean;
  /** Per-patch outcomes, in registration order. */
  outcomes: PatchOutcome[];
  /** Asar hash before any patch ran. */
  originalHash: string;
  /** Asar hash after all patches ran (== originalHash if nothing patched). */
  finalHash: string;
  /** All errors, concatenated. */
  errors: string[];
  /** All warnings, concatenated. */
  warnings: string[];
}

/** A registered Linux compatibility patch. */
export interface Patch {
  /** Stable identifier (kebab-case). */
  id: string;
  /** What this patch fixes and why. */
  description: string;
  /** Apply the patch to the asar. */
  apply: (options: PatchApplyOptions) => Promise<GenericPatchResult>;
}

/** Fields common to all patch result types. */
interface GenericPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  errors: string[];
  warnings: string[];
}

// ─── Registered patches ─────────────────────────────────────────────────────

/**
 * The daemon transport patch forces WebSocket transport on Linux so the app
 * never emits `droid daemon --listen ipc`. While the latest droid CLI supports
 * `--listen` with choices websocket/ipc, IPC transport is unreliable on Linux.
 * Registered first because it gates daemon reachability.
 */
const daemonTransportPatch: Patch = {
  id: "daemon-transport",
  description:
    "Force WebSocket daemon transport on Linux and guard against " +
    "`--listen ipc` (IPC transport is unreliable on Linux).",
  apply: (options) =>
    patchDaemonTransport({
      asarPath: options.asarPath,
      skipIfPatched: options.skipIfPatched,
      tolerateMissingTarget: options.tolerateMissingTarget,
    }),
};
/**
 * The auto-updater patch guards Electron's built-in `autoUpdater` calls on
 * Linux so the app doesn't try to check for or install macOS/Windows updates.
 * Our Rust-based `factory-update-manager` handles Linux updates independently.
 */
const autoUpdaterPatch: Patch = {
  id: "auto-updater",
  description:
    "Guard autoUpdater.checkForUpdates() and quitAndInstall() with " +
    'process.platform!=="linux" to prevent built-in update crashes on Linux.',
  apply: (options) =>
    patchAutoUpdater({
      asarPath: options.asarPath,
      skipIfPatched: options.skipIfPatched,
      tolerateMissingTarget: options.tolerateMissingTarget,
    }),
};

/**
 * The window controls patch injects titleBarOverlay on Linux — a frameless
 * window (titleBarStyle: "hidden") with Electron-drawn min/max/close buttons
 * that are dark/light theme-aware via nativeTheme.shouldUseDarkColors.
 * This mirrors the approach used by ilysenko/codex-desktop-linux.
 */
const windowControlsPatch: Patch = {
  id: "window-controls",
  description:
    'Inject titleBarOverlay on Linux for frameless window with ' +
      "Electron-drawn min/max/close buttons (dark/light theme-aware).",
  apply: (options) =>
    patchWindowControls({
      asarPath: options.asarPath,
      skipIfPatched: options.skipIfPatched,
      tolerateMissingTarget: options.tolerateMissingTarget,
    }),
};

/**
 * The about panel patch augments the existing "About Factory" dialog on Linux
 * and injects a closeable top-right in-app status panel. Both surfaces show the
 * system droid CLI version and update state from the factory-update-manager
 * daemon (state.json); the panel can also expose a copyable manual command for
 * desktop updates or stale remote daemon restarts.
 */
const aboutPanelPatch: Patch = {
  id: "about-panel",
  description:
    "Augment About Factory and inject a closeable top-right status panel " +
      "showing Factory Desktop, system droid CLI, and update state.",
  apply: (options) =>
    patchAboutPanel({
      asarPath: options.asarPath,
      skipIfPatched: options.skipIfPatched,
      tolerateMissingTarget: options.tolerateMissingTarget,
    }),
};

/** All registered core patches, in apply order. */
export const REGISTERED_PATCHES: ReadonlyArray<Patch> = [
  daemonTransportPatch,
  autoUpdaterPatch,
  windowControlsPatch,
  aboutPanelPatch,
];

// ─── Registry entry point ───────────────────────────────────────────────────

/**
 * Apply all registered core patches to an app.asar in order.
 *
 * Each patch receives the asar path and mutates it in place; the aggregate
 * result tracks the hash across the whole chain so callers can allowlist the
 * final hash for integrity validation.
 */
export async function applyRegisteredPatches(
  options: PatchApplyOptions,
): Promise<RegisteredPatchesResult> {
  const outcomes: PatchOutcome[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let success = true;
  let patched = false;
  let originalHash = "";
  let finalHash = "";

  for (const patch of REGISTERED_PATCHES) {
    const result: GenericPatchResult = await patch.apply(options);

    const outcome: PatchOutcome = {
      id: patch.id,
      description: patch.description,
      success: result.success,
      patched: result.patched,
      originalHash: result.originalHash,
      patchedHash: result.patchedHash,
      patches: (result as DaemonTransportPatchResult).patches ?? [],
      errors: result.errors,
      warnings: result.warnings,
    };
    outcomes.push(outcome);

    if (!outcome.success) {
      success = false;
      errors.push(
        `Patch ${patch.id} failed: ${outcome.errors.join("; ")}`,
      );
    } else if (outcome.patched) {
      patched = true;
      warnings.push(
        `Patch ${patch.id} applied: ${outcome.patches
          .map((p) => p.id)
          .join(", ")}.`,
      );
    }
    warnings.push(...outcome.warnings);

    // Track the hash chain: seed with the first patch's original hash, then
    // walk forward so finalHash reflects the last patch that touched the asar.
    if (!originalHash) originalHash = outcome.originalHash;
    if (outcome.patched) finalHash = outcome.patchedHash;
    else if (!finalHash) finalHash = outcome.originalHash;
  }

  // If nothing ran (no patches registered), fall back to the input asar hash.
  if (!finalHash) finalHash = originalHash;

  return {
    success,
    patched,
    outcomes,
    originalHash,
    finalHash,
    errors,
    warnings,
  };
}

/**
 * List registered patch ids and descriptions (for `--list-patches` / docs).
 */
export function listRegisteredPatches(): Array<{ id: string; description: string }> {
  return REGISTERED_PATCHES.map((p) => ({ id: p.id, description: p.description }));
}
