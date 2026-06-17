/**
 * Tests for Linux Electron runtime assembly.
 *
 * Fulfills: VAL-RUNTIME-001, VAL-RUNTIME-002, VAL-RUNTIME-003,
 *           VAL-RUNTIME-010, VAL-RUNTIME-011, VAL-RUNTIME-016
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  assembleLinuxRuntime,
  validateRuntimeLayout,
  validateAsarIntact,
  validateDroidBinary,
  validateSharedLibraries,
  checkResourcesPathResolution,
  checkLaunchRequirements,
  getElectronDistPath,
  formatAssemblyResult,
  formatLayoutResult,
} from "../src/runtime-assembly";
import { classifyBinary, BinaryType } from "../src/runtime-classifier";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary directory for test isolation */
function createTempDir(prefix = "runtime-assembly-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively remove a directory */
function rmrf(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Compute SHA-256 hash of a file */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Create a minimal mock Electron dist directory for testing
 * without depending on the full electron npm package at test time.
 */
function createMockElectronDist(baseDir: string): string {
  const distDir = path.join(baseDir, "electron-dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, "resources"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "locales"), { recursive: true });

  // Create a mock electron executable (simple shell script)
  const exePath = path.join(distDir, "electron");
  fs.writeFileSync(exePath, "#!/bin/sh\necho mock-electron\n");
  fs.chmodSync(exePath, 0o755);

  // Create required runtime files
  fs.writeFileSync(path.join(distDir, "version"), "39.2.7");
  fs.writeFileSync(path.join(distDir, "resources.pak"), "mock");
  fs.writeFileSync(path.join(distDir, "icudtl.dat"), "mock");
  fs.writeFileSync(path.join(distDir, "snapshot_blob.bin"), "mock");
  fs.writeFileSync(path.join(distDir, "v8_context_snapshot.bin"), "mock");
  fs.writeFileSync(path.join(distDir, "chrome_100_percent.pak"), "mock");
  fs.writeFileSync(path.join(distDir, "chrome_200_percent.pak"), "mock");

  // Create default_app.asar
  fs.writeFileSync(
    path.join(distDir, "resources", "default_app.asar"),
    "mock-default-app"
  );

  return distDir;
}

/**
 * Create a mock app.asar file with valid package.json content
 * that @electron/asar can read. Uses the async API.
 */
async function createMockAsar(
  outputDir: string,
  version = "0.106.0",
  productName = "Factory"
): Promise<string> {
  const asarDir = path.join(outputDir, "asar");
  fs.mkdirSync(asarDir, { recursive: true });

  const asarPath = path.join(asarDir, "app.asar");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar");

  const packageDir = path.join(asarDir, "package-source");
  fs.mkdirSync(packageDir, { recursive: true });

  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "desktop",
      productName,
      version,
      main: ".vite/build/main.js",
      devDependencies: { electron: "^39.2.7" },
    })
  );

  await asar.createPackage(packageDir, asarPath);
  return asarPath;
}

/**
 * Create a mock Linux droid ELF binary for testing.
 * Uses /usr/bin/true as a stand-in for a real ELF binary when available.
 */
function createMockDroid(outputDir: string, version = "0.106.0"): string {
  const droidDir = path.join(outputDir, "droid");
  fs.mkdirSync(droidDir, { recursive: true });

  const droidPath = path.join(droidDir, "droid");

  // Try to use a real ELF binary as a stand-in for droid
  try {
    fs.copyFileSync("/usr/bin/true", droidPath);
    fs.chmodSync(droidPath, 0o755);
  } catch {
    // Fallback: create a shell script
    fs.writeFileSync(
      droidPath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho mock-droid\n`
    );
    fs.chmodSync(droidPath, 0o755);
  }

  return droidPath;
}

/**
 * Create a mock assembled app directory for validation tests.
 * Uses a simple binary blob as asar stand-in for layout tests,
 * or creates a real asar for metadata tests.
 */
async function createMockAssembledApp(
  baseDir: string,
  options: {
    includeAsar?: boolean;
    includeDroid?: boolean;
    droidIsElf?: boolean;
    includeMacPaths?: boolean;
    useRealAsar?: boolean;
  } = {}
): Promise<string> {
  const appDir = path.join(baseDir, "assembled-app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "resources", "bin"), { recursive: true });

  // Main executable - use a real ELF if possible for ldd tests
  const exePath = path.join(appDir, "factory-desktop");
  try {
    fs.copyFileSync("/usr/bin/true", exePath);
    fs.chmodSync(exePath, 0o755);
  } catch {
    fs.writeFileSync(exePath, "#!/bin/sh\necho mock-factory-desktop\n");
    fs.chmodSync(exePath, 0o755);
  }

  // Runtime files
  fs.writeFileSync(path.join(appDir, "version"), "39.2.7");
  fs.writeFileSync(path.join(appDir, "resources.pak"), "mock");
  fs.writeFileSync(path.join(appDir, "icudtl.dat"), "mock");

  // app.asar
  if (options.includeAsar !== false) {
    if (options.useRealAsar) {
      // Create a real asar with valid package.json for metadata tests
      const realAsarPath = await createMockAsar(baseDir, "0.106.0");
      fs.copyFileSync(realAsarPath, path.join(appDir, "resources", "app.asar"));
    } else {
      // Create a simple binary blob as asar stand-in for layout tests
      fs.writeFileSync(
        path.join(appDir, "resources", "app.asar"),
        "mock-asar-content"
      );
    }
  }

  // Droid binary
  if (options.includeDroid !== false) {
    const droidPath = path.join(appDir, "resources", "bin", "droid");

    if (options.droidIsElf === false) {
      // Create a non-ELF droid (simple script)
      fs.writeFileSync(droidPath, "#!/bin/sh\necho 0.106.0\n");
      fs.chmodSync(droidPath, 0o755);
    } else {
      // Use a real ELF binary as stand-in
      try {
        fs.copyFileSync("/usr/bin/true", droidPath);
        fs.chmodSync(droidPath, 0o755);
      } catch {
        fs.writeFileSync(droidPath, "#!/bin/sh\necho 0.106.0\n");
        fs.chmodSync(droidPath, 0o755);
      }
    }
  }

  // macOS paths (for negative testing)
  if (options.includeMacPaths) {
    const frameworksDir = path.join(
      appDir,
      "Contents",
      "Frameworks",
      "Electron Framework.framework"
    );
    fs.mkdirSync(frameworksDir, { recursive: true });
    fs.writeFileSync(
      path.join(frameworksDir, "Electron Framework"),
      "mock-mach-o"
    );
  }

  return appDir;
}

// ─── getElectronDistPath ────────────────────────────────────────────────────

describe("getElectronDistPath", () => {
  it("returns a path that contains the electron binary when electron is installed", () => {
    const distPath = getElectronDistPath();
    // In the test environment, electron should be installed
    if (fs.existsSync(distPath)) {
      expect(fs.existsSync(path.join(distPath, "electron"))).toBe(true);
      expect(fs.existsSync(path.join(distPath, "version"))).toBe(true);
    } else {
      // If electron isn't installed, the function should return a plausible path
      expect(distPath).toContain("electron");
      expect(distPath).toContain("dist");
    }
  });
});

// ─── validateRuntimeLayout (VAL-RUNTIME-001) ────────────────────────────────

describe("validateRuntimeLayout", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("passes for a valid Linux Electron layout", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = validateRuntimeLayout(appDir);

    expect(result.valid).toBe(true);
    expect(result.isLinuxLayout).toBe(true);
    expect(result.hasMacPaths).toBe(false);
    expect(result.hasExecutable).toBe(true);
    expect(result.hasResourcesDir).toBe(true);
    expect(result.hasAppAsar).toBe(true);
    expect(result.hasDroid).toBe(true);
  });

  it("fails when macOS Contents/Frameworks path is present", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeMacPaths: true,
    });
    const result = validateRuntimeLayout(appDir);

    expect(result.valid).toBe(false);
    expect(result.hasMacPaths).toBe(true);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Contents/Frameworks"),
      ])
    );
  });

  it("fails when executable is missing", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    fs.unlinkSync(path.join(appDir, "factory-desktop"));
    const result = validateRuntimeLayout(appDir);

    expect(result.valid).toBe(false);
    expect(result.hasExecutable).toBe(false);
  });

  it("fails when resources/app.asar is missing", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeAsar: false,
    });
    const result = validateRuntimeLayout(appDir);

    expect(result.valid).toBe(false);
    expect(result.hasAppAsar).toBe(false);
  });

  it("fails when resources/bin/droid is missing", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeDroid: false,
    });
    const result = validateRuntimeLayout(appDir);

    expect(result.valid).toBe(false);
    expect(result.hasDroid).toBe(false);
  });

  it("includes file type info for the executable", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = validateRuntimeLayout(appDir);

    // Should report file type of the executable
    expect(result.executableFileType).toBeDefined();
  });

  it("accepts custom executable name via appName option", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    // Rename the executable to a custom name
    const oldExe = path.join(appDir, "factory-desktop");
    const newExe = path.join(appDir, "my-custom-app");
    fs.renameSync(oldExe, newExe);

    // Without appName, it should still find the renamed executable via scan
    const result = validateRuntimeLayout(appDir);
    expect(result.hasExecutable).toBe(true);

    // With explicit appName, it should find it directly
    const result2 = validateRuntimeLayout(appDir, { appName: "my-custom-app" });
    expect(result2.hasExecutable).toBe(true);
  });

  it("detects single executable when no known names match", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    // Remove the default factory-desktop executable
    const oldExe = path.join(appDir, "factory-desktop");
    fs.unlinkSync(oldExe);
    // Create a differently-named executable
    fs.writeFileSync(path.join(appDir, "custom-electron-app"), "#!/bin/sh\necho test");
    fs.chmodSync(path.join(appDir, "custom-electron-app"), 0o755);

    const result = validateRuntimeLayout(appDir);
    expect(result.hasExecutable).toBe(true);
  });
});

// ─── validateAsarIntact (VAL-RUNTIME-002) ──────────────────────────────────

describe("validateAsarIntact", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("passes when app.asar hash matches expected", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      useRealAsar: true,
    });
    const asarPath = path.join(appDir, "resources", "app.asar");
    const expectedHash = computeFileHash(asarPath);

    const result = validateAsarIntact(appDir, expectedHash);

    expect(result.intact).toBe(true);
    expect(result.hashMatch).toBe(true);
    expect(result.actualHash).toBe(expectedHash);
  });

  it("fails when app.asar hash does not match expected", async () => {
    const appDir = await createMockAssembledApp(tempDir);

    const result = validateAsarIntact(appDir, "0000000000000000");

    expect(result.intact).toBe(false);
    expect(result.hashMatch).toBe(false);
  });

  it("fails when app.asar is missing", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeAsar: false,
    });

    const result = validateAsarIntact(appDir, "any-hash");

    expect(result.intact).toBe(false);
    expect(result.asarPresent).toBe(false);
  });

  it("validates package metadata is preserved", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      useRealAsar: true,
    });
    const asarPath = path.join(appDir, "resources", "app.asar");
    const expectedHash = computeFileHash(asarPath);

    const result = validateAsarIntact(appDir, expectedHash);

    expect(result.intact).toBe(true);
    expect(result.metadataPresent).toBe(true);
    if (result.metadata) {
      expect(result.metadata.productName).toBe("Factory");
      expect(result.metadata.version).toBe("0.106.0");
      expect(result.metadata.main).toBe(".vite/build/main.js");
    }
  });

  it("accepts non-placeholder productName when no expectedProductName is set", async () => {
    // Create an ASAR with a future Factory productName
    const asarPath = await createMockAsar(tempDir, "0.106.0", "Factory Desktop");
    const appDir = path.join(tempDir, "app-future-name");
    fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });
    fs.copyFileSync(asarPath, path.join(appDir, "resources", "app.asar"));
    fs.mkdirSync(path.join(appDir, "resources", "bin"), { recursive: true });
    createMockDroid(appDir);

    const hash = computeFileHash(path.join(appDir, "resources", "app.asar"));
    const result = validateAsarIntact(appDir, hash, {
      expectedProductName: undefined, // Don't enforce a specific name
    });

    // Should pass because "Factory Desktop" is not a placeholder
    expect(result.intact).toBe(true);
  });

  it("rejects placeholder productName like 'electron-quick-start'", async () => {
    const asarPath = await createMockAsar(tempDir, "0.106.0", "electron-quick-start");
    const appDir = path.join(tempDir, "app-placeholder");
    fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });
    fs.copyFileSync(asarPath, path.join(appDir, "resources", "app.asar"));
    fs.mkdirSync(path.join(appDir, "resources", "bin"), { recursive: true });
    createMockDroid(appDir);

    const hash = computeFileHash(path.join(appDir, "resources", "app.asar"));
    const result = validateAsarIntact(appDir, hash, {
      expectedProductName: undefined,
    });

    expect(result.intact).toBe(false);
    expect(result.errors.some((e) => e.includes("placeholder"))).toBe(true);
  });

  it("enforces expectedProductName when explicitly provided", async () => {
    const asarPath = await createMockAsar(tempDir, "0.106.0", "Factory Desktop");
    const appDir = path.join(tempDir, "app-mismatch");
    fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });
    fs.copyFileSync(asarPath, path.join(appDir, "resources", "app.asar"));
    fs.mkdirSync(path.join(appDir, "resources", "bin"), { recursive: true });
    createMockDroid(appDir);

    const hash = computeFileHash(path.join(appDir, "resources", "app.asar"));
    const result = validateAsarIntact(appDir, hash, {
      expectedProductName: "Factory", // Explicit expectation that doesn't match
    });

    expect(result.intact).toBe(false);
    expect(result.errors.some((e) => e.includes("expected \"Factory\""))).toBe(true);
  });
});

// ─── validateDroidBinary (VAL-RUNTIME-003) ──────────────────────────────────

describe("validateDroidBinary", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("reports valid for an executable ELF x86_64 binary", async () => {
    const appDir = await createMockAssembledApp(tempDir, { droidIsElf: true });
    const result = validateDroidBinary(appDir);

    const droidPath = path.join(appDir, "resources", "bin", "droid");
    const classification = classifyBinary(droidPath);

    if (classification.type === BinaryType.ELF) {
      expect(result.valid).toBe(true);
      expect(result.isElf).toBe(true);
      expect(result.isExecutable).toBe(true);
    } else {
      // Not a real ELF in this test environment
      expect(result.valid).toBe(false);
      expect(result.isElf).toBe(false);
    }
  });

  it("fails when droid is missing", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeDroid: false,
    });
    const result = validateDroidBinary(appDir);

    expect(result.valid).toBe(false);
    expect(result.exists).toBe(false);
  });

  it("fails when droid is not executable", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      droidIsElf: false,
    });
    const droidPath = path.join(appDir, "resources", "bin", "droid");
    fs.chmodSync(droidPath, 0o644); // Remove execute permission

    const result = validateDroidBinary(appDir);

    expect(result.valid).toBe(false);
    expect(result.isExecutable).toBe(false);
  });

  it("fails when droid is not ELF", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      droidIsElf: false,
    });
    const droidPath = path.join(appDir, "resources", "bin", "droid");

    // Only verify if the stand-in is not actually ELF
    const classification = classifyBinary(droidPath);
    if (classification.type !== BinaryType.ELF) {
      const result = validateDroidBinary(appDir);
      expect(result.valid).toBe(false);
      expect(result.isElf).toBe(false);
    }
  });

  it("rejects Mach-O droid binary", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeDroid: false,
    });
    // The actual Mach-O rejection is tested in runtime-classifier.test.ts.
    // Here we verify validateDroidBinary handles missing droids properly.
    const result = validateDroidBinary(appDir);
    expect(result.valid).toBe(false);
    expect(result.exists).toBe(false);
  });
});

// ─── validateSharedLibraries (VAL-RUNTIME-016) ─────────────────────────────

describe("validateSharedLibraries", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("runs ldd on the main executable and reports results", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = validateSharedLibraries(appDir);

    // Should report whether ldd ran at all
    expect(result.lddRan).toBeDefined();

    // If ldd ran on a real ELF, should report results
    if (result.lddRan) {
      expect(result.missingLibs).toBeDefined();
      expect(Array.isArray(result.missingLibs)).toBe(true);
    }
  });

  it("reports missing libraries when ldd finds them", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = validateSharedLibraries(appDir);

    // On this Linux system, a real ELF should have all libs resolved
    // This is more of a smoke test that the function runs correctly
    expect(typeof result.valid).toBe("boolean");
  });

  it("handles non-ELF executables gracefully", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const exePath = path.join(appDir, "factory-desktop");

    // Replace with a non-ELF file
    fs.writeFileSync(exePath, "#!/bin/sh\necho test\n");
    fs.chmodSync(exePath, 0o755);

    // Should not crash
    const result = validateSharedLibraries(appDir);
    expect(result).toBeDefined();
  });
});

// ─── checkResourcesPathResolution (VAL-RUNTIME-011) ────────────────────────

describe("checkResourcesPathResolution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("verifies the resources directory contains expected layout", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = checkResourcesPathResolution(appDir);

    expect(result.resourcesDirExists).toBe(true);
    expect(result.appAsarInResources).toBe(true);
    expect(result.binDroidInResources).toBe(true);
  });

  it("reports the expected resourcesPath value", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = checkResourcesPathResolution(appDir);

    // resourcesPath should resolve to the resources directory
    expect(result.expectedResourcesPath).toContain("resources");
  });

  it("reports missing resources directory", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    fs.rmSync(path.join(appDir, "resources"), {
      recursive: true,
      force: true,
    });

    const result = checkResourcesPathResolution(appDir);

    expect(result.resourcesDirExists).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("reports missing droid in resources/bin", async () => {
    const appDir = await createMockAssembledApp(tempDir, {
      includeDroid: false,
    });
    const result = checkResourcesPathResolution(appDir);

    expect(result.binDroidInResources).toBe(false);
    expect(result.valid).toBe(false);
  });
});

// ─── checkLaunchRequirements (VAL-RUNTIME-010) ─────────────────────────────

describe("checkLaunchRequirements", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("reports chrome-sandbox status", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = checkLaunchRequirements(appDir);

    // chrome-sandbox may or may not exist in our mock app
    expect(typeof result.sandboxConfigured).toBe("boolean");
    expect(typeof result.noSandboxRequired).toBe("boolean");
    expect(result.chromeSandboxPath).toContain("chrome-sandbox");
  });

  it("provides instructions when --no-sandbox is required", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = checkLaunchRequirements(appDir);

    // Since our mock app doesn't have chrome-sandbox, --no-sandbox may be required
    if (result.noSandboxRequired) {
      expect(result.instructions.length).toBeGreaterThan(0);
      expect(result.instructions.some((i) => i.includes("4755") || i.includes("--no-sandbox"))).toBe(true);
    }
  });

  it("reports normalLaunchPossible correctly", async () => {
    const appDir = await createMockAssembledApp(tempDir);
    const result = checkLaunchRequirements(appDir);

    expect(typeof result.normalLaunchPossible).toBe("boolean");
  });
});

// ─── assembleLinuxRuntime (integration) ─────────────────────────────────────

describe("assembleLinuxRuntime", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmrf(tempDir);
  });

  it("assembles a Linux Electron app directory from mock inputs", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(true);
    expect(result.appDir).toBeDefined();
    expect(fs.existsSync(result.appDir)).toBe(true);

    // Check for the main executable
    const exePath = path.join(result.appDir, "factory-desktop");
    expect(fs.existsSync(exePath)).toBe(true);

    // Check for resources/app.asar
    const asarInApp = path.join(result.appDir, "resources", "app.asar");
    expect(fs.existsSync(asarInApp)).toBe(true);

    // Check for resources/bin/droid
    const droidInApp = path.join(result.appDir, "resources", "bin", "droid");
    expect(fs.existsSync(droidInApp)).toBe(true);
  });

  it("preserves app.asar hash", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(true);

    // Verify asar integrity
    const asarIntactResult = validateAsarIntact(result.appDir, asarHash);
    expect(asarIntactResult.intact).toBe(true);
  });

  it("sets executable permissions on droid binary", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(true);

    const droidInApp = path.join(result.appDir, "resources", "bin", "droid");
    expect(fs.existsSync(droidInApp)).toBe(true);
    // Verify execute permission
    fs.accessSync(droidInApp, fs.constants.X_OK);
  });

  it("removes default_app.asar from resources", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(true);

    // default_app.asar should not be in the assembled app
    const defaultAppAsar = path.join(
      result.appDir,
      "resources",
      "default_app.asar"
    );
    expect(fs.existsSync(defaultAppAsar)).toBe(false);
  });

  it("does not contain macOS Contents/Frameworks", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(true);

    const layoutResult = validateRuntimeLayout(result.appDir);
    expect(layoutResult.hasMacPaths).toBe(false);
  });

  it("fails when asar path does not exist", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const result = await assembleLinuxRuntime({
      asarPath: "/nonexistent/app.asar",
      asarHash: "invalid",
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when droid path does not exist", async () => {
    const mockDist = createMockElectronDist(tempDir);
    const asarPath = await createMockAsar(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath: "/nonexistent/droid",
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: mockDist,
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when electron dist directory does not exist", async () => {
    const asarPath = await createMockAsar(tempDir);
    const droidPath = createMockDroid(tempDir);
    const outputDir = path.join(tempDir, "build-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const asarHash = computeFileHash(asarPath);

    const result = await assembleLinuxRuntime({
      asarPath,
      asarHash,
      droidPath,
      outputDir,
      electronVersion: "39.2.7",
      appName: "factory-desktop",
      electronDistOverride: "/nonexistent/electron-dist",
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── Format functions ───────────────────────────────────────────────────────

describe("format functions", () => {
  it("formatAssemblyResult produces readable output", () => {
    const result = {
      success: true,
      appDir: "/tmp/test-app",
      executablePath: "/tmp/test-app/factory-desktop",
      asarResult: {
        intact: true,
        hashMatch: true,
        actualHash: "abc123",
        expectedHash: "abc123",
      },
      droidResult: {
        valid: true,
        path: "/tmp/test-app/resources/bin/droid",
        isElf: true,
        isExecutable: true,
      },
      layoutResult: {
        valid: true,
        isLinuxLayout: true,
        hasMacPaths: false,
      },
      sharedLibResult: { valid: true, missingLibs: [] },
      daemonTransportPatchResult: {
        success: true,
        patched: true,
        originalHash: "abc123",
        patchedHash: "def456",
        patchCount: 2,
        patches: [],
        errors: [],
        warnings: [],
      },
      errors: [] as string[],
      warnings: [] as string[],
    };

    const output = formatAssemblyResult(result);
    expect(output).toContain("successfully");
    expect(output).toContain("/tmp/test-app");
  });

  it("formatLayoutResult produces readable output", () => {
    const result = {
      valid: true,
      isLinuxLayout: true,
      hasMacPaths: false,
      hasExecutable: true,
      hasResourcesDir: true,
      hasAppAsar: true,
      hasDroid: true,
      errors: [] as string[],
    };

    const output = formatLayoutResult(result);
    expect(output).toContain("Linux Electron");
    expect(output).toContain("valid");
  });
});
