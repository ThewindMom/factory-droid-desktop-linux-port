/**
 * Tests for ASAR metadata inspection (VAL-EXTRACT-004, VAL-EXTRACT-011).
 *
 * VAL-EXTRACT-004: After extraction, the builder CLI must validate the
 * application package metadata and pass only when the product name,
 * application version, main entry, and Electron compatibility metadata
 * are present and consistent with the selected Factory Desktop version.
 *
 * VAL-EXTRACT-011: When the user requests a specific Factory Desktop
 * version or latest-version mode resolves one, the supplied DMG package
 * metadata must match that version unless an explicit documented override
 * is provided.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  readAsarPackageMetadata,
  validateAsarMetadata,
  computeFileHash,
  formatAsarMetadata,
  formatValidationResult,
  parseIsPackEntry,
  AsarPackageMetadata,
} from "../src/asar-metadata";

import { resolveFetchedDmg } from "./_helpers/fetched-dmg";

const X64_DMG = resolveFetchedDmg("x64");
const x64DmgAvailable = fs.existsSync(X64_DMG);

// Path where app.asar would be extracted
let extractedAsarPath: string | undefined;

// Extract app.asar for testing if DMG is available
if (x64DmgAvailable) {
  const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asar-meta-test-"));
  extractedAsarPath = path.join(
    testTmpDir,
    "Factory/Factory.app/Contents/Resources/app.asar"
  );

  try {
    fs.mkdirSync(path.dirname(extractedAsarPath), { recursive: true });
    execSync(
      `7z x -y -o"${testTmpDir}" "${X64_DMG}" "Factory/Factory.app/Contents/Resources/app.asar"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000 }
    );
  } catch {
    extractedAsarPath = undefined;
  }
}

const describeIfAsar = extractedAsarPath && fs.existsSync(extractedAsarPath)
  ? describe
  : describe.skip;

// ============== Unit tests for validateAsarMetadata ==============

describe("validateAsarMetadata", () => {
  const validMetadata: AsarPackageMetadata = {
    name: "desktop",
    productName: "Factory",
    version: "0.106.0",
    main: ".vite/build/main.js",
    electronVersion: "39.2.7",
  };

  // VAL-EXTRACT-004: Valid metadata passes validation
  it("passes validation for matching version", () => {
    const result = validateAsarMetadata(validMetadata, {
      selectedVersion: "0.106.0",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.productName).toBe("Factory");
    expect(result.version).toBe("0.106.0");
    expect(result.main).toBe(".vite/build/main.js");
    expect(result.electronVersion).toBe("39.2.7");
  });

  // VAL-EXTRACT-004: Product name validation
  it("fails validation for wrong product name", () => {
    const meta = { ...validMetadata, productName: "NotFactory" };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.106.0",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Product name mismatch"))).toBe(true);
  });

  // VAL-EXTRACT-011: Version mismatch without override fails
  it("fails validation for version mismatch without override", () => {
    const result = validateAsarMetadata(validMetadata, {
      selectedVersion: "0.107.0",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Version mismatch"))).toBe(true);
  });

  // VAL-EXTRACT-011: Version mismatch with override passes
  it("passes validation for version mismatch with override", () => {
    const result = validateAsarMetadata(validMetadata, {
      selectedVersion: "0.107.0",
      versionOverride: true,
    });
    expect(result.valid).toBe(true);
  });

  // --version-override does NOT bypass non-version metadata errors
  it("does not bypass non-version errors even with versionOverride", () => {
    const meta: AsarPackageMetadata = {
      name: "desktop",
      productName: "WrongProduct",
      version: "0.106.0",
      main: "",
      electronVersion: undefined,
    };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.107.0",
      versionOverride: true,
    });
    // Version mismatch is bypassed, but other errors still fail
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Product name mismatch"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Main entry"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Electron version"))).toBe(true);
    // Version mismatch should NOT be in errors when override is active
    expect(result.errors.some((e) => e.includes("Version mismatch"))).toBe(false);
  });

  it("fails validation for missing main entry", () => {
    const meta = { ...validMetadata, main: "" };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.106.0",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Main entry"))).toBe(true);
  });

  it("fails validation for missing Electron version", () => {
    const meta = { ...validMetadata, electronVersion: undefined };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.106.0",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Electron version"))).toBe(true);
  });

  it("accepts custom expected product name", () => {
    const meta = { ...validMetadata, productName: "CustomApp" };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.106.0",
      expectedProductName: "CustomApp",
    });
    expect(result.valid).toBe(true);
  });

  it("collects multiple errors at once", () => {
    const meta: AsarPackageMetadata = {
      name: "desktop",
      productName: "WrongProduct",
      version: "0.1.0",
      main: "",
      electronVersion: undefined,
    };
    const result = validateAsarMetadata(meta, {
      selectedVersion: "0.106.0",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ============== Unit tests for formatAsarMetadata ==============

describe("formatAsarMetadata", () => {
  it("formats successful metadata result", () => {
    const result = {
      success: true as const,
      packageMetadata: {
        name: "desktop",
        productName: "Factory",
        version: "0.106.0",
        main: ".vite/build/main.js",
        electronVersion: "39.2.7",
      },
      asarHash: "abc123",
      asarSize: 29931263,
    };
    const formatted = formatAsarMetadata(result);
    expect(formatted).toContain("Factory");
    expect(formatted).toContain("0.106.0");
    expect(formatted).toContain(".vite/build/main.js");
    expect(formatted).toContain("39.2.7");
    expect(formatted).toContain("abc123");
  });

  it("formats error result", () => {
    const result = {
      success: false as const,
      error: "File not found",
    };
    const formatted = formatAsarMetadata(result);
    expect(formatted).toContain("error");
  });
});

// ============== Unit tests for formatValidationResult ==============

describe("formatValidationResult", () => {
  it("formats valid result with check mark", () => {
    const validation = {
      valid: true,
      productName: "Factory",
      version: "0.106.0",
      main: ".vite/build/main.js",
      electronVersion: "39.2.7",
      errors: [],
    };
    const formatted = formatValidationResult(validation, {
      selectedVersion: "0.106.0",
    });
    expect(formatted).toContain("✓");
    expect(formatted).toContain("Factory");
  });

  it("formats invalid result with X mark and errors", () => {
    const validation = {
      valid: false,
      productName: "Factory",
      version: "0.106.0",
      main: ".vite/build/main.js",
      electronVersion: "39.2.7",
      errors: ["Version mismatch"],
    };
    const formatted = formatValidationResult(validation, {
      selectedVersion: "0.107.0",
    });
    expect(formatted).toContain("✗");
    expect(formatted).toContain("Version mismatch");
  });

  it("shows version override warning when active", () => {
    const validation = {
      valid: true,
      productName: "Factory",
      version: "0.106.0",
      main: ".vite/build/main.js",
      electronVersion: "39.2.7",
      errors: [],
    };
    const formatted = formatValidationResult(validation, {
      selectedVersion: "0.107.0",
      versionOverride: true,
    });
    expect(formatted).toContain("override");
  });
});

// ============== Integration tests with real ASAR ==============

describeIfAsar("readAsarPackageMetadata (integration)", () => {
  it("reads valid ASAR metadata from extracted app.asar", () => {
    const result = readAsarPackageMetadata(extractedAsarPath!);
    expect(result.success).toBe(true);
    expect(result.packageMetadata).toBeDefined();
    expect(result.packageMetadata!.productName).toBe("Factory");
    expect(result.packageMetadata!.version).toBe("0.106.0");
    expect(result.packageMetadata!.main).toBe(".vite/build/main.js");
    expect(result.packageMetadata!.name).toBe("desktop");
  });

  it("reports Electron version from devDependencies", () => {
    const result = readAsarPackageMetadata(extractedAsarPath!);
    expect(result.success).toBe(true);
    expect(result.packageMetadata!.electronVersion).toBe("39.2.7");
  });

  it("computes ASAR SHA-256 hash", () => {
    const result = readAsarPackageMetadata(extractedAsarPath!);
    expect(result.success).toBe(true);
    expect(result.asarHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports ASAR file size", () => {
    const result = readAsarPackageMetadata(extractedAsarPath!);
    expect(result.success).toBe(true);
    expect(result.asarSize).toBeGreaterThan(0);
  });

  it("fails for nonexistent ASAR file", () => {
    const result = readAsarPackageMetadata("/nonexistent/app.asar");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ============== Unit tests for computeFileHash ==============

describe("computeFileHash", () => {
  it("computes consistent SHA-256 hashes", () => {
    const tmpFile = path.join(os.tmpdir(), "hash-test-" + Date.now());
    fs.writeFileSync(tmpFile, "test content");
    try {
      const hash1 = computeFileHash(tmpFile);
      const hash2 = computeFileHash(tmpFile);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("produces different hashes for different content", () => {
    const tmpFile1 = path.join(os.tmpdir(), "hash-test-1-" + Date.now());
    const tmpFile2 = path.join(os.tmpdir(), "hash-test-2-" + Date.now());
    fs.writeFileSync(tmpFile1, "content 1");
    fs.writeFileSync(tmpFile2, "content 2");
    try {
      const hash1 = computeFileHash(tmpFile1);
      const hash2 = computeFileHash(tmpFile2);
      expect(hash1).not.toBe(hash2);
    } finally {
      fs.unlinkSync(tmpFile1);
      fs.unlinkSync(tmpFile2);
    }
  });
});

// ─── parseIsPackEntry ──────────────────────────────────────────────────────

describe("parseIsPackEntry", () => {
  it("parses standard isPack prefixed entries", () => {
    // Real output from asar.listPackage(path, { isPack: true })
    expect(parseIsPackEntry("pack   : /path/to/file.js")).toBe("path/to/file.js");
    expect(parseIsPackEntry("pack : /main.js")).toBe("main.js");
  });

  it("handles entries with varying whitespace after colon", () => {
    expect(parseIsPackEntry("pack   :   /foo/bar.js")).toBe("foo/bar.js");
    expect(parseIsPackEntry("pack:file.js")).toBe("file.js");
  });

  it("strips leading slashes from the path", () => {
    expect(parseIsPackEntry("pack   : ///deep/nested.js")).toBe("deep/nested.js");
    expect(parseIsPackEntry("pack   : /single.js")).toBe("single.js");
  });

  it("returns null for entries without a colon", () => {
    expect(parseIsPackEntry("no-colon-here")).toBeNull();
    expect(parseIsPackEntry("")).toBeNull();
  });

  it("handles entries with no leading slash in path", () => {
    expect(parseIsPackEntry("pack   : path/to/file.js")).toBe("path/to/file.js");
  });

  it("handles directory entries", () => {
    expect(parseIsPackEntry("pack   : /some/directory")).toBe("some/directory");
  });

  it("handles map entries (non-pack prefix)", () => {
    // listPackage may also return entries with "map" prefix
    expect(parseIsPackEntry("map    : /some/file.js")).toBe("some/file.js");
  });
});
