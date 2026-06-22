/**
 * Tests for the Linux auto-updater compatibility patch.
 *
 * Validates VAL-UPDATER-001: The packaged Linux app must not attempt to
 * use Electron's built-in auto-updater (which targets macOS/Windows update
 * endpoints) on Linux. The Rust-based factory-update-manager handles Linux
 * updates independently.
 *
 * Version-agnostic: tests verify the regex patterns match against real
 * Factory Desktop 0.110.0 minified code shapes.
 */

import {
  patchAutoUpdater,
  validateAutoUpdater,
  formatAutoUpdaterPatchResult,
  formatAutoUpdaterValidationResult,
} from "../src/auto-updater-patch";

// ─── Minified code samples from real Factory Desktop 0.110.0 asar ──────────

/**
 * checkForUpdates call (0.110.0):
 * `Y.autoUpdater.checkForUpdates()`
 */
const CHECK_FOR_UPDATES_0_110_0 = "Y.autoUpdater.checkForUpdates()";

/**
 * quitAndInstall call (0.110.0):
 * `Y.autoUpdater.quitAndInstall()`
 */
const QUIT_AND_INSTALL_0_110_0 = "Y.autoUpdater.quitAndInstall()";

/**
 * Error handler that calls app.quit() (0.110.0, simplified):
 * `Y.autoUpdater.once("error",async n=>{Ut("[auto-updater] Update failed",{error:n}),$t.addToCounter(Wt.DESKTOP_UPDATE_ERROR_COUNT,1),Y.app.quit()})`
 */
const ERROR_HANDLER_0_110_0 =
  'Y.autoUpdater.once("error",async n=>{Ut("[auto-updater] Update failed",{error:n}),Y.app.quit()})';

// ─── Version-agnostic regex matching ──────────────────────────────────────

describe("auto-updater-patch version-agnostic matching", () => {
  describe("checkForUpdates pattern", () => {
    it("matches Factory 0.110.0 form", () => {
      const pattern = /(\w+\.autoUpdater\.checkForUpdates\(\))/;
      expect(CHECK_FOR_UPDATES_0_110_0).toMatch(pattern);
    });

    it("matches alternative object names", () => {
      const pattern = /(\w+\.autoUpdater\.checkForUpdates\(\))/;
      expect("e.autoUpdater.checkForUpdates()").toMatch(pattern);
      expect("ce.autoUpdater.checkForUpdates()").toMatch(pattern);
    });
  });

  describe("quitAndInstall pattern", () => {
    it("matches Factory 0.110.0 form", () => {
      const pattern = /(\w+\.autoUpdater\.quitAndInstall\(\))/;
      expect(QUIT_AND_INSTALL_0_110_0).toMatch(pattern);
    });
  });

  describe("error handler pattern", () => {
    it("matches Factory 0.110.0 form", () => {
      const pattern =
        /(\w+\.autoUpdater\.once\("error",[\s\S]*?\w+\.app\.quit\(\)\})/;
      expect(ERROR_HANDLER_0_110_0).toMatch(pattern);
    });
  });
});

// ─── patchAutoUpdater ──────────────────────────────────────────────────────

describe("patchAutoUpdater", () => {
  it("returns error when asar not found", async () => {
    const result = await patchAutoUpdater({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("returns error when tolerateMissingTarget is set but file not found", async () => {
    // tolerateMissingTarget applies when the asar exists but has no Vite
    // bundles. A nonexistent file is still an error.
    const result = await patchAutoUpdater({
      asarPath: "/nonexistent/app.asar",
      tolerateMissingTarget: true,
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
  });
});

// ─── validateAutoUpdater ───────────────────────────────────────────────────

describe("validateAutoUpdater", () => {
  it("returns error when asar not found", () => {
    const result = validateAutoUpdater({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.checkForUpdatesGuarded).toBe(false);
    expect(result.quitAndInstallGuarded).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });
});

// ─── Formatting Functions ──────────────────────────────────────────────────

describe("formatAutoUpdaterPatchResult", () => {
  it("formats patched result", () => {
    const result = formatAutoUpdaterPatchResult({
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 3,
      patches: [
        {
          id: "guard-check-for-updates",
          description: "Guard checkForUpdates",
          originalSnippet: "Y.autoUpdater.checkForUpdates()",
          replacementSnippet: "process.platform!==...&&...",
        },
      ],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("Auto-updater patch applied");
    expect(result).toContain("3");
  });

  it("formats skipped result", () => {
    const result = formatAutoUpdaterPatchResult({
      success: true,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("No auto-updater patch was needed");
  });

  it("formats error result", () => {
    const result = formatAutoUpdaterPatchResult({
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      patches: [],
      errors: ["Something went wrong"],
      warnings: [],
    });

    expect(result).toContain("Something went wrong");
  });
});

describe("formatAutoUpdaterValidationResult", () => {
  it("formats passing result", () => {
    const result = formatAutoUpdaterValidationResult({
      valid: true,
      checkForUpdatesGuarded: true,
      quitAndInstallGuarded: true,
      errors: [],
      warnings: [],
    });

    expect(result).toContain("validation passed");
    expect(result).toContain("Yes");
  });

  it("formats failing result", () => {
    const result = formatAutoUpdaterValidationResult({
      valid: false,
      checkForUpdatesGuarded: false,
      quitAndInstallGuarded: false,
      errors: ["checkForUpdates is not guarded"],
      warnings: [],
    });

    expect(result).toContain("FAILED");
    expect(result).toContain("No");
  });
});
