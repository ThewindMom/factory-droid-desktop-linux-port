/**
 * Tests for DMG validation (VAL-EXTRACT-001).
 *
 * VAL-EXTRACT-001: When the builder CLI is invoked with a readable macOS
 * Factory Desktop x64 DMG, it must accept the input and report the
 * discovered Factory Desktop version before producing extracted payload
 * outputs. When the path is missing, unreadable, or not a Factory Desktop
 * DMG, it must exit non-zero and produce no extracted payload outputs.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { validateDmg, validateArm64Dmg } from "../src/dmg-validator";

import { resolveFetchedDmg } from "./_helpers/fetched-dmg";

const X64_DMG = resolveFetchedDmg("x64");
const ARM64_DMG = resolveFetchedDmg("arm64");

// Whether reference DMGs are available for testing
const x64DmgAvailable = fs.existsSync(X64_DMG);
const arm64DmgAvailable = fs.existsSync(ARM64_DMG);

// Conditional describe blocks for DMG-dependent tests
const describeIfDmg = x64DmgAvailable ? describe : describe.skip;
const describeIfArm64 = arm64DmgAvailable ? describe : describe.skip;

describe("validateDmg", () => {
  describe("invalid inputs", () => {
    it("rejects empty path", () => {
      const result = validateDmg("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects whitespace-only path", () => {
      const result = validateDmg("   ");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects nonexistent file", () => {
      const result = validateDmg("/nonexistent/path/Factory-0.106.0-x64.dmg");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects directory path", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-test-"));
      try {
        const result = validateDmg(tmpDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("directory");
      } finally {
        fs.rmdirSync(tmpDir);
      }
    });

    it("rejects non-DMG file extension", () => {
      const tmpFile = path.join(os.tmpdir(), "not-a-dmg.zip");
      fs.writeFileSync(tmpFile, "fake content");
      try {
        const result = validateDmg(tmpFile);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(".dmg");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("rejects unreadable DMG file", () => {
      // Create a file and make it unreadable
      const tmpFile = path.join(os.tmpdir(), "unreadable-Factory-0.1.0-x64.dmg");
      fs.writeFileSync(tmpFile, "fake content");
      try {
        fs.chmodSync(tmpFile, 0o000);
        const result = validateDmg(tmpFile);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("not readable");
      } finally {
        fs.chmodSync(tmpFile, 0o644);
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describeIfDmg("valid Factory Desktop DMG", () => {
    it("accepts valid x64 DMG and reports version", () => {
      const result = validateDmg(X64_DMG);
      expect(result.valid).toBe(true);
      expect(result.version).toBe("0.106.0");
    });

    it("reports version extracted from filename", () => {
      const result = validateDmg(X64_DMG);
      expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describeIfArm64("arm64 DMG validation", () => {
    it("accepts valid arm64 DMG", () => {
      const result = validateArm64Dmg(ARM64_DMG);
      expect(result.valid).toBe(true);
    });

    it("rejects x64 DMG as arm64 input", () => {
      const result = validateArm64Dmg(X64_DMG);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("arm64");
    });
  });
});

describe("CLI validate command", () => {
  const cliPath = path.resolve(__dirname, "..", "src", "cli.ts");

  describeIfDmg("with valid DMG", () => {
    it("exits 0 and reports version for valid DMG", () => {
      const output = execSync(
        `npx ts-node "${cliPath}" validate --dmg "${X64_DMG}"`,
        { encoding: "utf-8", timeout: 30000 }
      );
      expect(output).toContain("Valid Factory Desktop DMG");
      expect(output).toContain("0.106.0");
    });
  });

  it("exits non-zero for missing DMG path", () => {
    expect(() => {
      execSync(
        `npx ts-node "${cliPath}" validate --dmg "/nonexistent/Factory-0.1.0-x64.dmg"`,
        { encoding: "utf-8", timeout: 30000, stdio: "pipe" }
      );
    }).toThrow();
  });

  it("exits non-zero for invalid file", () => {
    const tmpFile = path.join(os.tmpdir(), "not-a-dmg.zip");
    fs.writeFileSync(tmpFile, "fake");
    try {
      expect(() => {
        execSync(
          `npx ts-node "${cliPath}" validate --dmg "${tmpFile}"`,
          { encoding: "utf-8", timeout: 30000, stdio: "pipe" }
        );
      }).toThrow();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
