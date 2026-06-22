/**
 * Tests for DMG extraction (VAL-EXTRACT-004, VAL-EXTRACT-008, VAL-EXTRACT-011).
 *
 * VAL-EXTRACT-004: Package metadata is verified after extraction.
 * VAL-EXTRACT-008: Repeated extraction is deterministic and clean.
 * VAL-EXTRACT-011: Requested version must match DMG metadata unless overridden.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  parseElectronVersionFromPlist,
  parseFactoryVersionFromPlist,
  computeExtractionHashes,
  extractFromDmg,
  extractDmgPayload,
  verifyDeterministicExtraction,
  formatExtractionResult,
  formatDeterminismResult,
  DMG_CONTENT_PATHS,
} from "../src/dmg-extraction";

import { resolveFetchedDmg } from "./_helpers/fetched-dmg";

const X64_DMG = resolveFetchedDmg("x64");
const x64DmgAvailable = fs.existsSync(X64_DMG);

const describeIfDmg = x64DmgAvailable ? describe : describe.skip;

// ============== Unit tests for plist parsing ==============

describe("parseFactoryVersionFromPlist", () => {
  it("extracts Factory version from Info.plist content", () => {
    const plist = `
      <key>CFBundleShortVersionString</key>
      <string>0.106.0</string>
    `;
    const version = parseFactoryVersionFromPlist(plist);
    expect(version).toBe("0.106.0");
  });

  it("returns undefined for missing key", () => {
    const plist = `<key>SomeOtherKey</key><string>value</string>`;
    const version = parseFactoryVersionFromPlist(plist);
    expect(version).toBeUndefined();
  });

  it("handles whitespace in plist", () => {
    const plist = `
      <key>CFBundleShortVersionString</key>
      <string>
        0.106.0
      </string>
    `;
    const version = parseFactoryVersionFromPlist(plist);
    expect(version).toBe("0.106.0");
  });
});

describe("parseElectronVersionFromPlist", () => {
  it("extracts Electron version from Info.plist content", () => {
    const plist = `
      <key>CFBundleVersion</key>
      <string>39.2.7</string>
    `;
    const version = parseElectronVersionFromPlist(plist);
    expect(version).toBe("39.2.7");
  });

  it("returns undefined for missing key", () => {
    const plist = `<key>SomeOtherKey</key><string>value</string>`;
    const version = parseElectronVersionFromPlist(plist);
    expect(version).toBeUndefined();
  });
});

// ============== Unit tests for computeExtractionHashes ==============

describe("computeExtractionHashes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extraction-hash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes hashes for files in directory", () => {
    fs.writeFileSync(path.join(tmpDir, "file1.txt"), "content 1");
    fs.writeFileSync(path.join(tmpDir, "file2.txt"), "content 2");

    const hashes = computeExtractionHashes(tmpDir);
    expect(Object.keys(hashes)).toHaveLength(2);
    expect(hashes["file1.txt"]).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes["file2.txt"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes hashes for nested directories", () => {
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "nested.txt"), "nested content");

    const hashes = computeExtractionHashes(tmpDir);
    const expectedKey = path.join("subdir", "nested.txt");
    expect(hashes[expectedKey]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns empty for non-existent directory", () => {
    const hashes = computeExtractionHashes("/nonexistent/path");
    expect(Object.keys(hashes)).toHaveLength(0);
  });
});

// ============== Unit tests for extractFromDmg optional vs required paths ==============

describe("extractFromDmg", () => {
  it("treats Electron Framework Info.plist as optional, not required", () => {
    // Create a temp directory and a fake DMG that 7z will reject.
    // We can't easily mock 7z, but we can test the path classification
    // logic by calling extractFromDmg with a nonexistent DMG and
    // verifying that the Electron Framework plist path is returned
    // as a failed optional path rather than throwing.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-opt-"));
    try {
      // Use a nonexistent DMG - all paths will fail.
      // For optional paths, they should be returned in the failed list.
      // For required paths (app.asar, app Info.plist), they should throw.
      const frameworkPlist = DMG_CONTENT_PATHS.electronFrameworkPlist;
      const appAsar = DMG_CONTENT_PATHS.appAsar;

      // Test that app.asar is required (throws)
      expect(() =>
        extractFromDmg("/nonexistent.dmg", tempDir, [appAsar])
      ).toThrow(/Failed to extract required path/);

      // Test that the app's own Info.plist is required (throws)
      expect(() =>
        extractFromDmg("/nonexistent.dmg", tempDir, [DMG_CONTENT_PATHS.infoPlist])
      ).toThrow(/Failed to extract required path/);

      // Test that the Electron Framework plist is optional (returns in failed list)
      const failedPaths = extractFromDmg("/nonexistent.dmg", tempDir, [frameworkPlist]);
      expect(failedPaths).toContain(frameworkPlist);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats icon paths as optional", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-opt-"));
    try {
      const iconPath = DMG_CONTENT_PATHS.electronIcns;
      const failedPaths = extractFromDmg("/nonexistent.dmg", tempDir, [iconPath]);
      expect(failedPaths).toContain(iconPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ============== Unit tests for formatExtractionResult ==============

describe("formatExtractionResult", () => {
  it("formats successful result", () => {
    const result = {
      success: true as const,
      dmgVersion: "0.106.0",
      electronVersion: "39.2.7",
      asarPath: "/tmp/work/extracted/app.asar",
      asarHash: "abc123def456",
      packageMetadata: {
        name: "desktop",
        productName: "Factory",
        version: "0.106.0",
        main: ".vite/build/main.js",
        electronVersion: "39.2.7",
      },
      metadataValidation: {
        valid: true,
        productName: "Factory",
        version: "0.106.0",
        main: ".vite/build/main.js",
        electronVersion: "39.2.7",
        errors: [],
      },
      fileHashes: {},
      warnings: [],
    };
    const formatted = formatExtractionResult(result);
    expect(formatted).toContain("0.106.0");
    expect(formatted).toContain("39.2.7");
    expect(formatted).toContain("✓");
  });

  it("formats failed result", () => {
    const result = {
      success: false as const,
      error: "extraction error",
      warnings: [],
    };
    const formatted = formatExtractionResult(result);
    expect(formatted).toContain("failed");
    expect(formatted).toContain("extraction error");
  });
});

// ============== Unit tests for formatDeterminismResult ==============

describe("formatDeterminismResult", () => {
  it("formats deterministic result", () => {
    const result = {
      deterministic: true,
      run1Version: "0.106.0",
      run2Version: "0.106.0",
      run1Hashes: {
        "Factory/Factory.app/Contents/Resources/app.asar": "abc123",
        "Factory/Factory.app/Contents/Info.plist": "def456",
      },
      differences: [],
    };
    const formatted = formatDeterminismResult(result);
    expect(formatted).toContain("✓");
    expect(formatted).toContain("Deterministic");
    // Should use the app.asar hash, not an arbitrary Object.values order
    expect(formatted).toContain("abc123");
  });

  it("formats deterministic result with no hashes", () => {
    const result = {
      deterministic: true,
      run1Version: "0.106.0",
      run2Version: "0.106.0",
      differences: [],
    };
    const formatted = formatDeterminismResult(result);
    expect(formatted).toContain("N/A");
  });

  it("formats non-deterministic result", () => {
    const result = {
      deterministic: false,
      run1Version: "0.106.0",
      run2Version: "0.106.0",
      differences: ["ASAR hash mismatch"],
    };
    const formatted = formatDeterminismResult(result);
    expect(formatted).toContain("✗");
    expect(formatted).toContain("ASAR hash mismatch");
  });
});

// ============== Integration tests with real DMG ==============

describeIfDmg("extractDmgPayload (integration)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-extract-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // VAL-EXTRACT-004: Package metadata is verified
  it("extracts app.asar and validates metadata", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(true);
    expect(result.dmgVersion).toBe("0.106.0");
    expect(result.asarPath).toBeDefined();
    expect(fs.existsSync(result.asarPath!)).toBe(true);
  });

  it("reports ASAR package metadata", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(true);
    expect(result.packageMetadata).toBeDefined();
    expect(result.packageMetadata!.productName).toBe("Factory");
    expect(result.packageMetadata!.version).toBe("0.106.0");
    expect(result.packageMetadata!.main).toBe(".vite/build/main.js");
  });

  it("reports Electron version", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(true);
    expect(result.electronVersion).toBe("39.2.7");
  });

  it("computes ASAR SHA-256 hash", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(true);
    expect(result.asarHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes file hashes for all extracted files", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(true);
    expect(result.fileHashes).toBeDefined();
    expect(Object.keys(result.fileHashes!).length).toBeGreaterThan(0);
  });

  // VAL-EXTRACT-011: Version mismatch without override fails validation
  it("fails metadata validation when version does not match without override", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.999.0",
    });

    expect(result.success).toBe(true); // Extraction succeeds
    expect(result.metadataValidation).toBeDefined();
    expect(result.metadataValidation!.valid).toBe(false);
    expect(
      result.metadataValidation!.errors.some((e) => e.includes("Version mismatch"))
    ).toBe(true);
  });

  // VAL-EXTRACT-011: Version mismatch with override passes validation
  it("passes metadata validation when version does not match with override", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.999.0",
      versionOverride: true,
    });

    expect(result.success).toBe(true);
    expect(result.metadataValidation).toBeDefined();
    expect(result.metadataValidation!.valid).toBe(true);
  });

  it("fails for nonexistent DMG path", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload("/nonexistent.dmg", extractDir, {
      selectedVersion: "0.106.0",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns empty warnings for successful extraction with all optional paths", () => {
    const extractDir = path.join(workDir, "extracted");
    const result = extractDmgPayload(X64_DMG, extractDir, {
      selectedVersion: "0.106.0",
      extractIcons: true,
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    // Icons should extract successfully from the reference DMG,
    // so there should be no icon-related warnings
    expect(result.warnings.filter((w) => w.includes("icon"))).toHaveLength(0);
  });
});

// VAL-EXTRACT-008: Repeated extraction is deterministic and clean
describeIfDmg("verifyDeterministicExtraction (integration)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-det-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("produces identical results for two consecutive extractions", () => {
    const result = verifyDeterministicExtraction(
      X64_DMG,
      workDir,
      "0.106.0"
    );

    expect(result.deterministic).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  it("reports identical ASAR hashes for both runs", () => {
    const result = verifyDeterministicExtraction(
      X64_DMG,
      workDir,
      "0.106.0"
    );

    expect(result.run1Hashes).toBeDefined();
    expect(result.run2Hashes).toBeDefined();
    // All keys and values should match
    const keys1 = Object.keys(result.run1Hashes!).sort();
    const keys2 = Object.keys(result.run2Hashes!).sort();
    expect(keys1).toEqual(keys2);

    for (const key of keys1) {
      expect(result.run1Hashes![key]).toBe(result.run2Hashes![key]);
    }
  });

  it("reports identical metadata for both runs", () => {
    const result = verifyDeterministicExtraction(
      X64_DMG,
      workDir,
      "0.106.0"
    );

    expect(result.run1Metadata).toBeDefined();
    expect(result.run2Metadata).toBeDefined();
    expect(result.run1Metadata!.productName).toBe(
      result.run2Metadata!.productName
    );
    expect(result.run1Metadata!.version).toBe(result.run2Metadata!.version);
    expect(result.run1Metadata!.main).toBe(result.run2Metadata!.main);
    expect(result.run1Metadata!.electronVersion).toBe(
      result.run2Metadata!.electronVersion
    );
  });

  it("reports identical version selections for both runs", () => {
    const result = verifyDeterministicExtraction(
      X64_DMG,
      workDir,
      "0.106.0"
    );

    expect(result.run1Version).toBe(result.run2Version);
    expect(result.run1Version).toBe("0.106.0");
  });
});

// ============== CLI integration tests ==============

describeIfDmg("CLI extract command (integration)", () => {
  const cliPath = path.resolve(__dirname, "..", "src", "cli.ts");

  it("extracts DMG and reports metadata", () => {
    const output = execSync(
      `npx ts-node "${cliPath}" extract --dmg "${X64_DMG}"`,
      { encoding: "utf-8", timeout: 120000 }
    );
    expect(output).toContain("0.106.0");
    expect(output).toContain("Factory");
  });

  it("rejects version mismatch without override", () => {
    expect(() => {
      execSync(
        `npx ts-node "${cliPath}" extract --dmg "${X64_DMG}" --factory-version 0.999.0`,
        { encoding: "utf-8", timeout: 120000, stdio: "pipe" }
      );
    }).toThrow();
  });

  it("accepts version mismatch with override", () => {
    const output = execSync(
      `npx ts-node "${cliPath}" extract --dmg "${X64_DMG}" --factory-version 0.999.0 --version-override`,
      { encoding: "utf-8", timeout: 120000 }
    );
    expect(output).toContain("0.999.0");
  });
});
