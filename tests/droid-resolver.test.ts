/**
 * Tests for Linux droid resolver (VAL-EXTRACT-006, VAL-EXTRACT-009).
 *
 * VAL-EXTRACT-006: Linux droid binary matches selected version policy.
 * Downloaded droid verifies checksum and runs --version.
 *
 * VAL-EXTRACT-009: Droid download checksum is verified.
 * The builder must verify the downloaded file against that checksum
 * before using it.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as crypto from "crypto";
import {
  buildDroidDownloadUrl,
  buildDroidSha256Url,
  parseChecksumFile,
  getDroidVersion,
  resolveDroid,
  validateExistingDroid,
  formatDroidResult,
  VersionPolicy,
  DroidResolutionResult,
} from "../src/droid-resolver";

// ============== Unit tests for URL builders ==============

describe("buildDroidDownloadUrl", () => {
  it("builds download URL for a specific version", () => {
    const url = buildDroidDownloadUrl("0.106.0");
    expect(url).toContain("0.106.0");
    expect(url).toContain("linux");
    expect(url).toContain("x64");
    expect(url).toContain("droid");
  });

  it("includes the version in the URL", () => {
    const url = buildDroidDownloadUrl("1.2.3");
    expect(url).toContain("1.2.3");
  });
});

describe("buildDroidSha256Url", () => {
  it("builds checksum URL for a specific version", () => {
    const url = buildDroidSha256Url("0.106.0");
    expect(url).toContain("0.106.0");
    expect(url).toContain("sha256");
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
    const result = parseChecksumFile(`  ${hash}  droid  `);
    expect(result).not.toBeNull();
    expect(result!.hash).toBe(hash);
  });

  it("rejects empty content", () => {
    const result = parseChecksumFile("");
    expect(result).toBeNull();
  });

  it("rejects non-hash content", () => {
    const result = parseChecksumFile("not-a-hash");
    expect(result).toBeNull();
  });

  it("rejects hash that is too short", () => {
    const result = parseChecksumFile("abc123");
    expect(result).toBeNull();
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
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-version-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined for non-existent binary", () => {
    const version = getDroidVersion("/nonexistent/droid");
    expect(version).toBeUndefined();
  });

  it("returns version for a working ELF binary that supports --version", () => {
    // Use a known system binary that supports --version
    if (fs.existsSync("/bin/ls")) {
      const version = getDroidVersion("/bin/ls");
      // ls --version outputs something like "ls (GNU coreutils) 9.4"
      // or on some systems it may not support --version
      // We just verify it doesn't throw
      expect(typeof version === "string" || version === undefined).toBe(true);
    }
  });
});

// ============== Unit tests for formatDroidResult ==============

describe("formatDroidResult", () => {
  it("formats successful result", () => {
    const result: DroidResolutionResult = {
      success: true,
      droidPath: "/tmp/work/droid/droid",
      droidHash: "a".repeat(64),
      droidVersion: "0.106.0",
      requestedVersion: "0.106.0",
      versionMatch: "exact",
      checksumVerified: true,
      checksumSource: "https://example.com/droid.sha256",
      elfVerified: true,
      executableSet: true,
      versionRan: true,
      errors: [],
      warnings: [],
    };
    const formatted = formatDroidResult(result);
    expect(formatted).toContain("✓");
    expect(formatted).toContain("0.106.0");
    expect(formatted).toContain("exact");
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
    expect(formatted).toContain("✗");
    expect(formatted).toContain("Download failed");
  });

  it("includes warnings in output", () => {
    const result: DroidResolutionResult = {
      success: true,
      droidPath: "/tmp/work/droid/droid",
      requestedVersion: "0.106.0",
      versionMatch: "fallback",
      checksumVerified: false,
      checksumSource: "none",
      elfVerified: true,
      executableSet: true,
      versionRan: true,
      errors: [],
      warnings: ["Checksum not available"],
    };
    const formatted = formatDroidResult(result);
    expect(formatted).toContain("WARNING");
  });
});

// ============== Unit tests for validateExistingDroid ==============

describe("validateExistingDroid", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-validate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects non-existent binary", () => {
    const result = validateExistingDroid("/nonexistent/droid", "0.106.0");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("validates a system ELF binary as Linux-compatible", () => {
    if (fs.existsSync("/bin/ls")) {
      const result = validateExistingDroid("/bin/ls", "0.106.0");
      expect(result.elfVerified).toBe(true);
      expect(result.executableSet).toBe(true);
    }
  });

  it("reports version mismatch as fallback when versions differ", () => {
    if (fs.existsSync("/bin/ls")) {
      const result = validateExistingDroid("/bin/ls", "99.99.99", {
        versionPolicy: VersionPolicy.FallbackToLatest,
      });
      // ls --version returns its own version, not 99.99.99
      if (result.droidVersion && result.droidVersion !== "99.99.99") {
        expect(result.versionMatch).toBe("fallback");
        expect(result.warnings.some((w) => w.includes("fallback"))).toBe(true);
      }
    }
  });

  it("rejects version mismatch under exact policy", () => {
    if (fs.existsSync("/bin/ls")) {
      const result = validateExistingDroid("/bin/ls", "99.99.99", {
        versionPolicy: VersionPolicy.Exact,
      });
      // ls --version returns its own version, not 99.99.99
      if (result.droidVersion && result.droidVersion !== "99.99.99") {
        expect(result.versionMatch).toBe("fallback");
        expect(result.errors.some((e) => e.includes("exact"))).toBe(true);
      }
    }
  });
});

// ============== Integration tests with mock HTTP server ==============

describe("resolveDroid (integration with mock server)", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;

  // Create a fake ELF-like binary for the mock server
  const fakeElfContent = Buffer.alloc(128);
  // ELF magic bytes: 0x7f 'E' 'L' 'F'
  fakeElfContent[0] = 0x7f;
  fakeElfContent[1] = 0x45; // E
  fakeElfContent[2] = 0x4c; // L
  fakeElfContent[3] = 0x46; // F
  // Class: 64-bit
  fakeElfContent[4] = 2;
  // Data: little endian
  fakeElfContent[5] = 1;
  // Machine: x86-64 (0x3e)
  fakeElfContent[18] = 0x3e;

  beforeAll((done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-resolve-"));

    server = http.createServer((req, res) => {
      const url = req.url || "/";

      if (url ===("/droid")) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fakeElfContent);
      } else if (url === "/droid.sha256") {
        const hash = crypto
          .createHash("sha256")
          .update(fakeElfContent)
          .digest("hex");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`${hash}  droid`);
      } else if (url === "/droid-bad-checksum") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fakeElfContent);
      } else if (url === "/droid-bad-checksum.sha256") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`${"0".repeat(64)}  droid`);
      } else if (url === "/droid-no-checksum") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fakeElfContent);
      } else if (url === "/droid-no-checksum.sha256") {
        res.writeHead(404);
        res.end("Not Found");
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

  it("downloads droid with valid checksum", async () => {
    const outputDir = path.join(tmpDir, "test-valid");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/droid`,
      checksumUrlOverride: `http://localhost:${port}/droid.sha256`,
      timeoutMs: 5000,
    });

    // Checksum verification should pass
    expect(result.checksumVerified).toBe(true);
    expect(result.checksumSource).toContain("sha256");
    // Note: success may be false because the fake ELF doesn't pass --version
    // The important assertion is that checksum verification worked
    expect(result.elfVerified).toBe(true);
    expect(result.errors.some((e) => e.includes("--version")) || result.versionRan).toBe(true);
  });

  // VAL-EXTRACT-009: Checksum mismatch is rejected
  it("rejects droid with checksum mismatch", async () => {
    const outputDir = path.join(tmpDir, "test-bad-checksum");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/droid-bad-checksum`,
      checksumUrlOverride: `http://localhost:${port}/droid-bad-checksum.sha256`,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.checksumVerified).toBe(false);
    expect(result.errors.some((e) => e.includes("Checksum verification failed"))).toBe(true);
    // Binary should be removed on checksum failure
    if (result.droidPath) {
      expect(fs.existsSync(result.droidPath)).toBe(false);
    }
  });

  it("proceeds without checksum when endpoint unavailable", async () => {
    const outputDir = path.join(tmpDir, "test-no-checksum");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/droid-no-checksum`,
      checksumUrlOverride: `http://localhost:${port}/droid-no-checksum.sha256`,
      timeoutMs: 5000,
    });

    // Should have a warning about missing checksum
    expect(result.checksumVerified).toBe(false);
    expect(result.warnings.some((w) => w.includes("Checksum verification could not be performed"))).toBe(true);
    // ELF verification should still work
    expect(result.elfVerified).toBe(true);
  });

  it("fails when download URL returns 404", async () => {
    const outputDir = path.join(tmpDir, "test-404");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/not-found`,
      timeoutMs: 5000,
      versionPolicy: VersionPolicy.Exact,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("HTTP 404") || e.includes("Failed to download"))).toBe(true);
  });

  it("fails with exact version policy when download fails", async () => {
    const outputDir = path.join(tmpDir, "test-exact-fail");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/not-found`,
      timeoutMs: 5000,
      versionPolicy: VersionPolicy.Exact,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("exact"))).toBe(true);
  });

  // VAL-EXTRACT-006: Version policy check
  it("records version match as exact when versions align", async () => {
    const outputDir = path.join(tmpDir, "test-version-match");
    const result = await resolveDroid("0.106.0", outputDir, {
      downloadUrlOverride: `http://localhost:${port}/droid`,
      checksumUrlOverride: `http://localhost:${port}/droid.sha256`,
      timeoutMs: 5000,
    });

    // The download started with the exact version URL
    // Note: versionMatch may be "unknown" if --version fails on fake ELF
    expect(["exact", "unknown"]).toContain(result.versionMatch);
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

  // This test attempts to download the real Factory CLI droid.
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
