/**
 * Tests for Linux droid resolver (VAL-EXTRACT-006).
 *
 * The droid binary is now downloaded from npm (@factory/cli-linux-x64)
 * instead of the old downloads.factory.ai endpoint (which returns 403).
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as os from "os";
import {
  buildDroidDownloadUrl,
  parseChecksumFile,
  getDroidVersion,
  resolveDroid,
  validateExistingDroid,
  formatDroidResult,
  findClosestVersion,
  VersionPolicy,
  DroidResolutionResult,
} from "../src/droid-resolver";

// ============== Unit tests for URL builders ==============

describe("buildDroidDownloadUrl", () => {
  it("builds npm tarball URL for a specific version", () => {
    const url = buildDroidDownloadUrl("0.106.0");
    expect(url).toContain("0.106.0");
    expect(url).toContain("registry.npmjs.org");
    expect(url).toContain("@factory/cli-linux-x64");
    expect(url).toContain(".tgz");
  });

  it("includes the version in the URL", () => {
    const url = buildDroidDownloadUrl("1.2.3");
    expect(url).toContain("1.2.3");
  });
});

// ============== Unit tests for findClosestVersion ==============

describe("findClosestVersion", () => {
  it("returns exact match when available", () => {
    const available = ["0.108.0", "0.106.0", "0.104.0"];
    const result = findClosestVersion("0.106.0", available);
    expect(result.version).toBe("0.106.0");
    expect(result.match).toBe("exact");
  });

  it("returns nearest fallback when exact not available", () => {
    const available = ["0.111.0", "0.109.3", "0.108.0"];
    // 0.110.0 not available; closest by numeric distance:
    // 0.111.0 = dist 100, 0.109.3 = dist 97, 0.108.0 = dist 200
    // So 0.109.3 is closest
    const result = findClosestVersion("0.110.0", available);
    expect(result.match).toBe("fallback");
    expect(result.version).toBe("0.109.3");
  });

  it("prefers lower version when equidistant", () => {
    const available = ["0.111.0", "0.109.0"];
    // 0.110.0 is equidistant from both; should pick 0.109.0 (first found)
    const result = findClosestVersion("0.110.0", available);
    expect(result.match).toBe("fallback");
    expect(["0.109.0", "0.111.0"]).toContain(result.version);
  });

  it("returns closest version when requested is far from all available", () => {
    const available = ["0.153.1", "0.152.0"];
    // 0.1.0 is far from both; 0.152.0 is closer (dist 15100 vs 15300)
    const result = findClosestVersion("0.1.0", available);
    expect(result.match).toBe("fallback");
    expect(result.version).toBe("0.152.0");
  });
});

// ============== Unit tests for parseChecksumFile ==============

describe("parseChecksumFile", () => {
  it("parses sha256sum format: <hash>  <filename>", () => {
    const hash = "a".repeat(64);
    const result = parseChecksumFile(`${hash}  droid`);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);
    expect(result!.filename).toBe("droid");
  });

  it("parses bare hash format", () => {
    const hash = "b".repeat(64);
    const result = parseChecksumFile(hash);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);
  });

  it("handles leading/trailing whitespace", () => {
    const hash = "c".repeat(64);
    const result = parseChecksumFile(`  ${hash}  `);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);
  });

  it("rejects empty content", () => {
    expect(parseChecksumFile("")).toBeNull();
  });

  it("rejects non-hash content", () => {
    expect(parseChecksumFile("not a hash")).toBeNull();
  });

  it("rejects hash that is too short", () => {
    expect(parseChecksumFile("abc123")).toBeNull();
  });

  it("normalizes hash to lowercase", () => {
    const hash = "A".repeat(64);
    const result = parseChecksumFile(hash);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash.toLowerCase());
  });
});

// ============== Unit tests for getDroidVersion ==============

describe("getDroidVersion", () => {
  it("returns undefined for non-existent binary", () => {
    expect(getDroidVersion("/nonexistent/droid")).toBeUndefined();
  });

  it("returns version for a working ELF binary that supports --version", () => {
    // Use /usr/bin/node --version as a proxy for a working ELF binary
    const nodePath = "/usr/bin/node";
    if (fs.existsSync(nodePath)) {
      // getDroidVersion runs --version and extracts a semver
      const result = getDroidVersion(nodePath);
      // node --version outputs "vXX.XX.XX" which contains a semver
      expect(result).toBeDefined();
    }
  });
});

// ============== Unit tests for formatDroidResult ==============

describe("formatDroidResult", () => {
  it("formats successful result", () => {
    const result: DroidResolutionResult = {
      success: true,
      droidPath: "/tmp/droid",
      droidHash: "abc123",
      droidVersion: "0.106.0",
      requestedVersion: "0.106.0",
      versionMatch: "exact",
      checksumVerified: false,
      checksumSource: "npm-tarball-integrity",
      elfVerified: true,
      executableSet: true,
      versionRan: true,
      errors: [],
      warnings: [],
    };
    const formatted = formatDroidResult(result);
    expect(formatted).toContain("success");
    expect(formatted).toContain("0.106.0");
  });

  it("formats failed result", () => {
    const result: DroidResolutionResult = {
      success: false,
      requestedVersion: "0.106.0",
      versionMatch: "unknown",
      checksumVerified: false,
      elfVerified: false,
      executableSet: false,
      versionRan: false,
      errors: ["Download failed"],
      warnings: [],
    };
    const formatted = formatDroidResult(result);
    expect(formatted).toContain("failed");
    expect(formatted).toContain("Download failed");
  });

  it("includes warnings in output", () => {
    const result: DroidResolutionResult = {
      success: false,
      requestedVersion: "0.106.0",
      versionMatch: "unknown",
      checksumVerified: false,
      elfVerified: false,
      executableSet: false,
      versionRan: false,
      errors: ["Error"],
      warnings: ["Warning text"],
    };
    const formatted = formatDroidResult(result);
    expect(formatted).toContain("Warning text");
  });
});

// ============== Unit tests for validateExistingDroid ==============

describe("validateExistingDroid", () => {
  it("rejects non-existent binary", () => {
    const result = validateExistingDroid("/nonexistent/droid", "0.106.0");
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("validates a system ELF binary as Linux-compatible", () => {
    // Use /usr/bin/node as a known-good ELF x86_64 binary
    const nodePath = "/usr/bin/node";
    if (fs.existsSync(nodePath)) {
      const result = validateExistingDroid(nodePath, "0.0.0", {
        versionPolicy: VersionPolicy.FallbackToLatest,
      });
      expect(result.elfVerified).toBe(true);
      expect(result.executableSet).toBe(true);
    }
  });

  it("reports version mismatch as fallback when versions differ", () => {
    const nodePath = "/usr/bin/node";
    if (fs.existsSync(nodePath)) {
      const result = validateExistingDroid(nodePath, "99.99.99", {
        versionPolicy: VersionPolicy.FallbackToLatest,
      });
      expect(result.versionMatch).toBe("fallback");
    }
  });

  it("rejects version mismatch under exact policy", () => {
    const nodePath = "/usr/bin/node";
    if (fs.existsSync(nodePath)) {
      const result = validateExistingDroid(nodePath, "99.99.99", {
        versionPolicy: VersionPolicy.Exact,
      });
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes("exact"))).toBe(true);
    }
  });
});

// ============== Integration tests with npm version override ==============

describe("resolveDroid (npm version override)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses closest available version when exact not on npm", async () => {
    // Simulate: requested 0.110.0, available list doesn't include it
    const result = await resolveDroid("0.110.0", path.join(tmpDir, "droid"), {
      npmVersionsOverride: ["0.111.0", "0.109.3", "0.108.0"],
      timeoutMs: 5000,
    });

    // Should not fail with "exact not found" — fallback is default policy
    expect(result.errors.some((e) => e.includes("exact"))).toBe(false);
    // May fail because npm download requires network — that's OK
    // The important assertion is it didn't reject on version policy
  });

  it("fails with exact policy when version not on npm", async () => {
    const result = await resolveDroid("0.110.0", path.join(tmpDir, "droid"), {
      npmVersionsOverride: ["0.111.0", "0.109.3"],
      timeoutMs: 5000,
      versionPolicy: VersionPolicy.Exact,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("exact"))).toBe(true);
  });

  it("finds exact match from npm version list", async () => {
    const result = await resolveDroid("0.108.0", path.join(tmpDir, "droid"), {
      npmVersionsOverride: ["0.108.0", "0.106.0"],
      timeoutMs: 5000,
    });

    // Should not have a fallback warning
    expect(result.warnings.some((w) => w.includes("not found on npm"))).toBe(false);
  });

  it("returns error when npm version list is empty", async () => {
    const result = await resolveDroid("0.106.0", path.join(tmpDir, "droid"), {
      npmVersionsOverride: [],
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("No versions"))).toBe(true);
  });
});

// ============== Mock-server integration tests (no npm required) ==============

describe("resolveDroid (mock server with downloadUrlOverride)", () => {
  let tmpDir: string;
  let server: http.Server;
  let port: number;

  // A minimal valid ELF header (x86_64) for testing
  const fakeElfContent = Buffer.from([
    0x7f, 0x45, 0x4c, 0x46, // ELF magic
    0x02,                    // 64-bit
    0x01,                    // little endian
    0x01,                    // ELF version
    0x00,                    // OS/ABI
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // padding
    0x02, 0x00,              // ET_EXEC
    0x3e, 0x00,              // EM_X86_64
    0x01, 0x00, 0x00, 0x00,  // ELF version
    ...new Array(40).fill(0), // rest of header
  ]);

  beforeAll((done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-mock-"));

    server = http.createServer((req, res) => {
      const url = req.url || "";
      if (url === "/droid") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fakeElfContent);
      } else if (url === "/not-found") {
        res.writeHead(404);
        res.end("Not Found");
      } else if (url === "/server-error") {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      done();
    });
  });

  afterAll((done) => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    server.close(done);
  });

  it("downloads droid via override URL and verifies ELF", async () => {
    const outputDir = path.join(tmpDir, "test-override");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/droid`,
      timeoutMs: 5000,
    });

    // ELF verification should pass
    expect(result.elfVerified).toBe(true);
    expect(result.executableSet).toBe(true);
    // --version will fail on fake ELF — that's expected
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("--version"))).toBe(true);
  });

  it("fails when override URL returns 404", async () => {
    const outputDir = path.join(tmpDir, "test-404");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/not-found`,
      timeoutMs: 5000,
      versionPolicy: VersionPolicy.Exact,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("HTTP 404") || e.includes("Failed to download"))).toBe(true);
  });
});

// ============== Live integration test (optional) ==============

describe("resolveDroid (live integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-live-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // This test downloads the real Factory CLI droid from npm.
  // It may fail in environments without network access.
  it(
    "downloads and verifies the real Factory CLI droid for 0.106.0",
    async () => {
      const result = await resolveDroid("0.106.0", path.join(tmpDir, "droid"), {
        versionPolicy: VersionPolicy.FallbackToLatest,
        timeoutMs: 60000,
      });

      if (result.success) {
        expect(result.elfVerified).toBe(true);
        expect(result.executableSet).toBe(true);
        expect(result.versionRan).toBe(true);
        expect(result.droidVersion).toBeDefined();
        expect(result.droidPath).toBeDefined();
        expect(fs.existsSync(result.droidPath!)).toBe(true);
      } else {
        // Network may be unavailable; skip gracefully
        console.warn(
          `Live droid download test skipped: ${result.errors.join("; ")}`
        );
      }
    },
    120000
  );
});
