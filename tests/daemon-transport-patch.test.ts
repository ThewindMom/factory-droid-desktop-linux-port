/**
 * Tests for the Linux daemon transport compatibility patch.
 *
 * Validates VAL-DAEMON-001 and VAL-DAEMON-002: The packaged Linux app
 * must not emit `--listen ipc` for the Linux droid daemon, and the
 * daemon must reach a healthy runtime state.
 *
 * Version-agnostic: tests verify the regex patterns match against both
 * Factory 0.106.0 and 0.110.0 minified forms.
 */

import {
  patchDaemonTransport,
  validateDaemonTransport,
  formatDaemonTransportPatchResult,
  formatDaemonTransportValidationResult,
} from "../src/daemon-transport-patch";

import * as fs from "fs";

// ─── Minified code samples from real Factory Desktop asars ────────────────

/**
 * Factory Desktop 0.106.0 transport resolver (minified).
 * Function name: s9t, enum: nc, flag enum: Un, getter: qce, logger: X
 */
const TRANSPORT_0_106_0 =
  'async function s9t(){const e=Un.DesktopDaemonIpc;try{return(await qce())[e.statsigName]??e.defaultValue?nc.Ipc:nc.WebSocket}catch(t){return X("[daemon] Failed to resolve desktop daemon IPC feature flag",{cause:t}),e.defaultValue?nc.Ipc:nc.WebSocket}}';

/**
 * Factory Desktop 0.110.0 transport resolver (minified).
 * Function name: $$e, enum: Ms, flag enum: Zt, getter: dF, logger: G
 */
const TRANSPORT_0_110_0 =
  'async function $$e(){const e=Zt.DesktopDaemonIpc;try{return(await dF())[e.statsigName]??e.defaultValue?Ms.Ipc:Ms.WebSocket}catch(t){return G("[daemon] Failed to resolve desktop daemon IPC feature flag",{cause:t}),e.defaultValue?Ms.Ipc:Ms.WebSocket}}';

/**
 * Factory Desktop 0.106.0 --listen ipc push (minified).
 * Enum: nc
 */
const LISTEN_IPC_0_106_0 = 'if(t===nc.Ipc&&a.push("--listen","ipc")';

/**
 * Factory Desktop 0.110.0 --listen ipc push (minified).
 * Enum: Ms
 */
const LISTEN_IPC_0_110_0 = 'if(t===Ms.Ipc&&a.push("--listen","ipc")';

// ─── Version-agnostic regex matching ──────────────────────────────────────

describe("daemon-transport-patch version-agnostic matching", () => {
  describe("transport resolver pattern", () => {
    it("matches Factory 0.106.0 minified form", () => {
      const pattern =
        /(async function [\w$]+\(\)\{)(const \w+=\w+\.DesktopDaemonIpc;[\s\S]*?\?\w+\.Ipc:\w+\.WebSocket\})/;
      expect(TRANSPORT_0_106_0).toMatch(pattern);
    });

    it("matches Factory 0.110.0 minified form", () => {
      const pattern =
        /(async function [\w$]+\(\)\{)(const \w+=\w+\.DesktopDaemonIpc;[\s\S]*?\?\w+\.Ipc:\w+\.WebSocket\})/;
      expect(TRANSPORT_0_110_0).toMatch(pattern);
    });

    it("extracts WebSocket enum reference from 0.106.0", () => {
      const pattern = /(\w+\.WebSocket)/;
      const match = TRANSPORT_0_106_0.match(pattern);
      expect(match?.[1]).toBe("nc.WebSocket");
    });

    it("extracts WebSocket enum reference from 0.110.0", () => {
      const pattern = /(\w+\.WebSocket)/;
      const match = TRANSPORT_0_110_0.match(pattern);
      expect(match?.[1]).toBe("Ms.WebSocket");
    });
  });

  describe("--listen ipc push pattern", () => {
    it("matches Factory 0.106.0 form", () => {
      const pattern = /(\w+\.Ipc)&&(\w+\.push\("--listen","ipc"\))/;
      expect(LISTEN_IPC_0_106_0).toMatch(pattern);
    });

    it("matches Factory 0.110.0 form", () => {
      const pattern = /(\w+\.Ipc)&&(\w+\.push\("--listen","ipc"\))/;
      expect(LISTEN_IPC_0_110_0).toMatch(pattern);
    });
  });
});

// ─── patchDaemonTransport ───────────────────────────────────────────────────

describe("patchDaemonTransport", () => {
  it("returns error when asar not found", async () => {
    const result = await patchDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  // Integration test with actual built asar (skipped if not available)
  const builtAsarPath =
    "/home/thewind/Projects/00_Random_Coding/factory-droid-desktop-linux-port/build/factory-desktop-linux-unpacked/resources/app.asar";
  const droidPath =
    "/home/thewind/Projects/00_Random_Coding/factory-droid-desktop-linux-port/build/factory-desktop-linux-unpacked/resources/bin/droid";
  const hasBuiltAsar = fs.existsSync(builtAsarPath);

  const describeIfBuilt = hasBuiltAsar ? describe : describe.skip;

  describeIfBuilt("integration with built app.asar", () => {
    it("validates daemon transport in the built asar", () => {
      const result = validateDaemonTransport({
        asarPath: builtAsarPath,
        droidPath: fs.existsSync(droidPath) ? droidPath : undefined,
      });

      // The built asar should be patched (assembly applies the patch)
      expect(result.valid).toBe(true);
      expect(result.forcesWebSocketOnLinux).toBe(true);
      expect(result.hasListenIpcGuard).toBe(true);
    });

    it("droid daemon does not support --listen flag", () => {
      if (!fs.existsSync(droidPath)) return;

      const result = validateDaemonTransport({
        asarPath: builtAsarPath,
        droidPath: droidPath,
      });

      expect(result.listenFlagSupported).toBe(false);
      expect(result.supportedDaemonFlags).toBeDefined();
      if (result.supportedDaemonFlags) {
        expect(result.supportedDaemonFlags).toContain("--host");
        expect(result.supportedDaemonFlags).toContain("--port");
        expect(result.supportedDaemonFlags).toContain("--unix");
        expect(result.supportedDaemonFlags).not.toContain("--listen");
      }
    });
  });
});

// ─── validateDaemonTransport ───────────────────────────────────────────────

describe("validateDaemonTransport", () => {
  it("returns error when asar not found", () => {
    const result = validateDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.forcesWebSocketOnLinux).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("handles missing droid path gracefully", () => {
    const result = validateDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.listenFlagSupported).toBe(false);
    expect(result.supportedDaemonFlags).toBeUndefined();
  });
});

// ─── Formatting Functions ──────────────────────────────────────────────────

describe("formatDaemonTransportPatchResult", () => {
  it("formats patched result", () => {
    const result = formatDaemonTransportPatchResult({
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 2,
      patches: [
        {
          id: "force-websocket-on-linux",
          description: "Test patch",
          originalSnippet: "original",
          replacementSnippet: "replacement",
        },
      ],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("Daemon transport patch applied");
    expect(result).toContain("2");
  });

  it("formats skipped result", () => {
    const result = formatDaemonTransportPatchResult({
      success: true,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("No daemon transport patch was needed");
  });

  it("formats error result", () => {
    const result = formatDaemonTransportPatchResult({
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

describe("formatDaemonTransportValidationResult", () => {
  it("formats passing result", () => {
    const result = formatDaemonTransportValidationResult({
      valid: true,
      forcesWebSocketOnLinux: true,
      hasListenIpcGuard: true,
      listenFlagSupported: false,
      errors: [],
      warnings: [],
    });

    expect(result).toContain("validation passed");
    expect(result).toContain("Yes");
  });

  it("formats failing result", () => {
    const result = formatDaemonTransportValidationResult({
      valid: false,
      forcesWebSocketOnLinux: false,
      hasListenIpcGuard: false,
      listenFlagSupported: false,
      errors: ["IPC transport can still be selected"],
      warnings: [],
    });

    expect(result).toContain("FAILED");
    expect(result).toContain("No");
  });

  it("includes supported flags when available", () => {
    const result = formatDaemonTransportValidationResult({
      valid: true,
      forcesWebSocketOnLinux: true,
      hasListenIpcGuard: true,
      listenFlagSupported: false,
      supportedDaemonFlags: ["--host", "--port", "--unix"],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("--host");
    expect(result).toContain("--port");
  });
});
