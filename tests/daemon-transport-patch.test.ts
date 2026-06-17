/**
 * Tests for the Linux daemon transport compatibility patch.
 *
 * Validates VAL-DAEMON-001 and VAL-DAEMON-002: The packaged Linux app
 * must not emit `--listen ipc` for the Linux droid daemon, and the
 * daemon must reach a healthy runtime state.
 */

import {
  patchDaemonTransport,
  validateDaemonTransport,
  formatDaemonTransportPatchResult,
  formatDaemonTransportValidationResult,
  ORIGINAL_TRANSPORT_FUNCTION,
  PATCHED_TRANSPORT_FUNCTION,
  ORIGINAL_LISTEN_IPC_PUSH,
  PATCHED_LISTEN_IPC_PUSH,
} from "../src/daemon-transport-patch";

import * as fs from "fs";

// ─── Patch Constants ────────────────────────────────────────────────────────

describe("daemon-transport-patch constants", () => {
  it("ORIGINAL_TRANSPORT_FUNCTION contains nc.Ipc", () => {
    expect(ORIGINAL_TRANSPORT_FUNCTION).toContain("nc.Ipc");
    expect(ORIGINAL_TRANSPORT_FUNCTION).toContain("nc.WebSocket");
  });

  it("PATCHED_TRANSPORT_FUNCTION forces WebSocket on Linux", () => {
    expect(PATCHED_TRANSPORT_FUNCTION).toContain(
      'process.platform==="linux")return nc.WebSocket'
    );
    expect(PATCHED_TRANSPORT_FUNCTION).toContain("nc.Ipc");
  });

  it("ORIGINAL_LISTEN_IPC_PUSH contains --listen ipc", () => {
    expect(ORIGINAL_LISTEN_IPC_PUSH).toContain("--listen");
    expect(ORIGINAL_LISTEN_IPC_PUSH).toContain("ipc");
  });

  it("PATCHED_LISTEN_IPC_PUSH adds Linux guard", () => {
    expect(PATCHED_LISTEN_IPC_PUSH).toContain(
      'process.platform!=="linux"'
    );
    expect(PATCHED_LISTEN_IPC_PUSH).toContain("--listen");
  });

  it("patched function is longer than original (adds Linux guard)", () => {
    expect(PATCHED_TRANSPORT_FUNCTION.length).toBeGreaterThan(
      ORIGINAL_TRANSPORT_FUNCTION.length
    );
  });

  it("patched listen push is longer than original (adds Linux guard)", () => {
    expect(PATCHED_LISTEN_IPC_PUSH.length).toBeGreaterThan(
      ORIGINAL_LISTEN_IPC_PUSH.length
    );
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
      expect.arrayContaining([expect.stringContaining("not found")])
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

// ─── validateDaemonTransport ────────────────────────────────────────────────

describe("validateDaemonTransport", () => {
  it("returns error when asar not found", () => {
    const result = validateDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.forcesWebSocketOnLinux).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")])
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
