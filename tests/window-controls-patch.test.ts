/**
 * Tests for the Linux window controls compatibility patch.
 *
 * Validates VAL-WINDOW-001: The packaged Linux app must have window
 * controls (minimize, maximize, close) by injecting titleBarOverlay
 * on Linux with dark/light theme-aware colors.
 */

import {
  patchWindowControls,
  validateWindowControls,
  formatWindowControlsPatchResult,
  formatWindowControlsValidationResult,
} from "../src/window-controls-patch";

// ─── Minified code samples from real Factory Desktop 0.110.0 asar ──────────

/**
 * BrowserWindow config with titleBarStyle (0.110.0):
 * `titleBarStyle:r?"default":"hidden"` where r = process.platform === "win32"
 */
const TITLE_BAR_STYLE_0_110_0 =
  'titleBarStyle:r?"default":"hidden",trafficLightPosition:r?void 0:{x:12,y:10}';

// ─── Version-agnostic regex matching ──────────────────────────────────────

describe("window-controls-patch version-agnostic matching", () => {
  it("matches Factory 0.110.0 titleBarStyle pattern", () => {
    const pattern = /(titleBarStyle:)(\w+)\?"default":"hidden"(,)/;
    expect(TITLE_BAR_STYLE_0_110_0).toMatch(pattern);
  });

  it("extracts the variable reference from the ternary", () => {
    const pattern = /(titleBarStyle:)(\w+)\?"default":"hidden"(,)/;
    const match = TITLE_BAR_STYLE_0_110_0.match(pattern);
    expect(match?.[2]).toBe("r");
  });

  it("matches alternative variable names", () => {
    const pattern = /(titleBarStyle:)(\w+)\?"default":"hidden"(,)/;
    expect('titleBarStyle:e?"default":"hidden",').toMatch(pattern);
    expect('titleBarStyle:Cu?"default":"hidden",').toMatch(pattern);
  });
});

// ─── patchWindowControls ──────────────────────────────────────────────────

describe("patchWindowControls", () => {
  it("returns error when asar not found", async () => {
    const result = await patchWindowControls({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("returns success with tolerateMissingTarget when no bundles found", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-" + Date.now();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "placeholder.txt"), "test");
    const asarPath = path.join(tmpDir, "test.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchWindowControls({
      asarPath,
      tolerateMissingTarget: true,
    });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── validateWindowControls ───────────────────────────────────────────────

describe("validateWindowControls", () => {
  it("returns error when asar not found", () => {
    const result = validateWindowControls({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.titleBarOverlayOnLinux).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });
});

// ─── Formatting Functions ──────────────────────────────────────────────────

describe("formatWindowControlsPatchResult", () => {
  it("formats patched result", () => {
    const result = formatWindowControlsPatchResult({
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 1,
      patches: [
        {
          id: "linux-titlebar-overlay",
          description: "Test patch",
          originalSnippet: "original",
          replacementSnippet: "replacement",
        },
      ],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("Window controls patch applied");
    expect(result).toContain("1");
  });

  it("formats skipped result", () => {
    const result = formatWindowControlsPatchResult({
      success: true,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("No window controls patch was needed");
  });

  it("formats error result", () => {
    const result = formatWindowControlsPatchResult({
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

describe("formatWindowControlsValidationResult", () => {
  it("formats passing result", () => {
    const result = formatWindowControlsValidationResult({
      valid: true,
      titleBarOverlayOnLinux: true,
      errors: [],
      warnings: [],
    });

    expect(result).toContain("validation passed");
    expect(result).toContain("Yes");
  });

  it("formats failing result", () => {
    const result = formatWindowControlsValidationResult({
      valid: false,
      titleBarOverlayOnLinux: false,
      errors: ["titleBarStyle is set to hidden on Linux with no titleBarOverlay"],
      warnings: [],
    });

    expect(result).toContain("FAILED");
    expect(result).toContain("No");
  });
});
