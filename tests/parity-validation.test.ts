/**
 * Tests for parity validation (VAL-EXTRACT-003, VAL-EXTRACT-012).
 *
 * VAL-EXTRACT-003: x64 and arm64 app.asar hashes are compared when both
 * DMGs are supplied. The command passes only when payload hashes match.
 *
 * VAL-EXTRACT-012: Optional arm64 DMG is validated before parity checks.
 * Invalid arm64 input must fail before parity comparison.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  validateArm64BeforeParity,
  compareAsarParity,
  formatParityResult,
  ParityResult,
} from "../src/parity-validation";

import { resolveFetchedDmg } from "./_helpers/fetched-dmg";

const X64_DMG = resolveFetchedDmg("x64");
const ARM64_DMG = resolveFetchedDmg("arm64");
const x64DmgAvailable = fs.existsSync(X64_DMG);
const arm64DmgAvailable = fs.existsSync(ARM64_DMG);
const bothDmgsAvailable = x64DmgAvailable && arm64DmgAvailable;

const describeIfBothDmgs = bothDmgsAvailable ? describe : describe.skip;
const describeIfArm64Dmg = arm64DmgAvailable ? describe : describe.skip;

// ============== Unit tests for validateArm64BeforeParity ==============

describe("validateArm64BeforeParity", () => {
  // VAL-EXTRACT-012: Invalid arm64 DMG fails before parity
  it("rejects non-existent arm64 DMG path", () => {
    const result = validateArm64BeforeParity("/nonexistent.dmg");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects empty arm64 DMG path", () => {
    const result = validateArm64BeforeParity("");
    expect(result.valid).toBe(false);
  });

  it("rejects non-arm64 DMG (x64 DMG passed as arm64)", () => {
    if (!x64DmgAvailable) return;
    // Passing the x64 DMG as arm64 should fail because filename doesn't contain arm64
    const result = validateArm64BeforeParity(X64_DMG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("arm64");
  });
});

// ============== Unit tests for formatParityResult ==============

describe("formatParityResult", () => {
  it("formats successful parity result", () => {
    const result: ParityResult = {
      valid: true,
      x64AsarHash: "abc123",
      arm64AsarHash: "abc123",
      errors: [],
      warnings: [],
    };
    const formatted = formatParityResult(result);
    expect(formatted).toContain("✓");
    expect(formatted).toContain("parity verified");
    expect(formatted).toContain("abc123");
  });

  it("formats failed parity result", () => {
    const result: ParityResult = {
      valid: false,
      x64AsarHash: "hash1",
      arm64AsarHash: "hash2",
      errors: ["ASAR parity failure: hash mismatch"],
      warnings: [],
    };
    const formatted = formatParityResult(result);
    expect(formatted).toContain("✗");
    expect(formatted).toContain("parity check failed");
    expect(formatted).toContain("hash1");
    expect(formatted).toContain("hash2");
  });

  it("includes warnings in output", () => {
    const result: ParityResult = {
      valid: true,
      x64AsarHash: "abc",
      arm64AsarHash: "abc",
      errors: [],
      warnings: ["Version mismatch warning"],
    };
    const formatted = formatParityResult(result);
    expect(formatted).toContain("WARNING");
    expect(formatted).toContain("Version mismatch warning");
  });
});

// ============== Integration tests with real DMGs ==============

describeIfBothDmgs("compareAsarParity (integration)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // VAL-EXTRACT-003: x64 and arm64 app.asar hashes match
  it("reports matching ASAR hashes for x64 and arm64 DMGs", () => {
    const result = compareAsarParity(X64_DMG, ARM64_DMG, workDir);

    expect(result.valid).toBe(true);
    expect(result.x64AsarHash).toBeDefined();
    expect(result.arm64AsarHash).toBeDefined();
    expect(result.x64AsarHash).toBe(result.arm64AsarHash);
  });

  it("reports package metadata from both architectures", () => {
    const result = compareAsarParity(X64_DMG, ARM64_DMG, workDir);

    expect(result.x64Metadata).toBeDefined();
    expect(result.arm64Metadata).toBeDefined();
    expect(result.x64Metadata!.productName).toBe("Factory");
    expect(result.arm64Metadata!.productName).toBe("Factory");
  });

  // VAL-EXTRACT-012: Arm64 DMG is validated before parity
  it("validates arm64 DMG before parity comparison", () => {
    const result = compareAsarParity(X64_DMG, ARM64_DMG, workDir);

    expect(result.arm64Validation).toBeUndefined(); // validation passed, not stored
    expect(result.valid).toBe(true);
  });
});

describeIfArm64Dmg("validateArm64BeforeParity (integration)", () => {
  // VAL-EXTRACT-012: Valid arm64 DMG passes validation
  it("accepts valid arm64 DMG", () => {
    const result = validateArm64BeforeParity(ARM64_DMG);
    expect(result.valid).toBe(true);
  });
});

// ============== CLI integration tests ==============

describeIfBothDmgs("CLI extract with arm64 parity (integration)", () => {
  const cliPath = path.resolve(__dirname, "..", "src", "cli.ts");

  // VAL-EXTRACT-003: Parity check when both DMGs are supplied
  it("verifies parity when --arm64-dmg is provided", () => {
    const output = execSync(
      `npx ts-node "${cliPath}" extract --dmg "${X64_DMG}" --arm64-dmg "${ARM64_DMG}"`,
      { encoding: "utf-8", timeout: 120000 }
    );
    expect(output).toContain("parity");
    expect(output).toContain("✓");
  });

  // VAL-EXTRACT-012: Invalid arm64 DMG fails before parity
  it("rejects non-arm64 DMG passed as --arm64-dmg", () => {
    expect(() => {
      execSync(
        `npx ts-node "${cliPath}" extract --dmg "${X64_DMG}" --arm64-dmg "${X64_DMG}"`,
        { encoding: "utf-8", timeout: 120000, stdio: "pipe" }
      );
    }).toThrow();
  });
});

import { execSync } from "child_process";
