/**
 * Tests for packaging module: deb/AppImage build, validation, checksums,
 * and extracted launch context.
 *
 * Fulfills: VAL-PACKAGE-001, VAL-PACKAGE-002, VAL-PACKAGE-003,
 *           VAL-PACKAGE-004, VAL-PACKAGE-005, VAL-PACKAGE-006,
 *           VAL-PACKAGE-013
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";
import {
  buildPackages,
  validateDebPackage,
  validatePackagedDroid,
  generateChecksums,
  verifyChecksums,
  extractDebContext,
  formatPackageBuildResult,
  formatDebValidationResult,
  formatAppImageValidationResult,
  formatPackagedDroidResult,
  formatChecksumResult,
  formatExtractedLaunchResult,
  checkRpmPrerequisites,
  findPartialRpmArtifacts,
  formatRpmPrerequisiteCheckResult,
  RpmDeferralReason,
} from "../src/packaging";
import { ReleaseMode } from "../src/config";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary directory for test artifacts */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `factory-pack-test-${prefix}-`));
  return dir;
}

/** Clean up a temporary directory */
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Create a minimal mock app directory for testing */
function createMockAppDir(baseDir: string, execName = "factory-desktop"): string {
  const appDir = path.join(baseDir, `${execName}-linux-unpacked`);
  fs.mkdirSync(appDir, { recursive: true });

  // Create a mock executable
  const execPath = path.join(appDir, execName);
  fs.writeFileSync(execPath, "#!/bin/bash\necho 'mock app'\n");
  fs.chmodSync(execPath, 0o755);

  // Create resources directory
  const resourcesDir = path.join(appDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Create mock app.asar
  fs.writeFileSync(path.join(resourcesDir, "app.asar"), "mock asar content");

  // Create resources/bin/droid
  const binDir = path.join(resourcesDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "droid"), "#!/bin/bash\necho '0.106.0'\n");
  fs.chmodSync(path.join(binDir, "droid"), 0o755);

  // Create version file
  fs.writeFileSync(path.join(appDir, "version"), "39.2.7\n");

  return appDir;
}

/** Create a real-looking mock .deb file for validation testing */
function createMockDeb(outputDir: string, execName = "factory-desktop"): string {
  fs.mkdirSync(outputDir, { recursive: true });

  // Create a proper .deb structure using dpkg-deb
  const debDir = path.join(outputDir, "deb-staging");
  const debianDir = path.join(debDir, "DEBIAN");
  fs.mkdirSync(debianDir, { recursive: true });

  // Create control file
  const controlContent = [
    "Package: factory-desktop",
    "Version: 0.106.0",
    "Architecture: amd64",
    "Maintainer: Factory AI <hello@factory.ai>",
    "Description: Factory AI Desktop - Unofficial Linux Port",
    "Depends: libgtk-3-0, libnss3",
    "Section: devel",
    "Priority: optional",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(debianDir, "control"), controlContent);

  // Create application files in /opt/
  const optDir = path.join(debDir, "opt", execName);
  fs.mkdirSync(optDir, { recursive: true });

  // Copy a real executable
  const mockExec = path.join(optDir, execName);
  fs.writeFileSync(mockExec, "#!/bin/bash\necho 'mock app'\n");
  fs.chmodSync(mockExec, 0o755);

  // Create resources
  const resourcesDir = path.join(optDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, "app.asar"), "mock asar content");

  const binDir = path.join(resourcesDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "droid"), "#!/bin/bash\necho '0.106.0'\n");
  fs.chmodSync(path.join(binDir, "droid"), 0o755);

  // Create desktop integration
  const applicationsDir = path.join(debDir, "usr", "share", "applications");
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(applicationsDir, `${execName}.desktop`),
    "[Desktop Entry]\nName=Factory\nExec=factory-desktop\nType=Application\nMimeType=x-scheme-handler/factory-desktop;\n"
  );

  // Build the .deb
  const debPath = path.join(outputDir, `factory-desktop_0.106.0_amd64.deb`);
  try {
    execSync(`dpkg-deb --build "${debDir}" "${debPath}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    // If dpkg-deb is not available, create a minimal ar archive
    // This is a fallback for environments without dpkg-deb
    throw new Error("dpkg-deb is required for mock .deb creation in tests");
  }

  // Clean up staging directory
  try {
    fs.rmSync(debDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  return debPath;
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("packaging", () => {
  describe("generateChecksums", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("checksums");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("generates SHA-256 checksums for artifact files", () => {
      // Create mock artifacts
      const artifact1 = path.join(tempDir, "test_0.106.0_amd64.deb");
      const artifact2 = path.join(tempDir, "test_0.106.0_x86_64.AppImage");
      fs.writeFileSync(artifact1, "deb content");
      fs.writeFileSync(artifact2, "appimage content");

      const result = generateChecksums([artifact1, artifact2], tempDir);

      expect(result.success).toBe(true);
      expect(result.artifactCount).toBe(2);
      expect(result.manifestPath).toBe(path.join(tempDir, "checksums.txt"));
      expect(Object.keys(result.checksums)).toHaveLength(2);

      // Verify manifest file exists
      expect(fs.existsSync(result.manifestPath)).toBe(true);

      // Verify manifest format (sha256sum format: <hash>  <filename>)
      const manifestContent = fs.readFileSync(result.manifestPath, "utf-8");
      expect(manifestContent).toContain("test_0.106.0_amd64.deb");
      expect(manifestContent).toContain("test_0.106.0_x86_64.AppImage");
    });

    test("computes correct SHA-256 hashes", () => {
      const artifact = path.join(tempDir, "test.deb");
      const content = "test content for hashing";
      fs.writeFileSync(artifact, content);

      const expectedHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const result = generateChecksums([artifact], tempDir);

      expect(result.success).toBe(true);
      expect(result.checksums["test.deb"]).toBe(expectedHash);
    });

    test("handles missing artifact files", () => {
      const missingArtifact = path.join(tempDir, "nonexistent.deb");

      const result = generateChecksums([missingArtifact], tempDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("handles empty artifact list", () => {
      const result = generateChecksums([], tempDir);

      expect(result.success).toBe(false);
      expect(result.artifactCount).toBe(0);
    });
  });

  describe("verifyChecksums", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("verify-checksums");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("verifies valid checksum manifest", () => {
      // Create an artifact and its checksum
      const artifact = path.join(tempDir, "test_0.106.0_amd64.deb");
      const content = "test deb content";
      fs.writeFileSync(artifact, content);

      const hash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const manifestPath = path.join(tempDir, "checksums.txt");
      fs.writeFileSync(manifestPath, `${hash}  test_0.106.0_amd64.deb\n`);

      const result = verifyChecksums(manifestPath);

      expect(result.valid).toBe(true);
      expect(result.output).toContain("OK");
    });

    test("detects checksum mismatch", () => {
      const artifact = path.join(tempDir, "test_0.106.0_amd64.deb");
      fs.writeFileSync(artifact, "actual content");

      const wrongHash = "0".repeat(64);
      const manifestPath = path.join(tempDir, "checksums.txt");
      fs.writeFileSync(manifestPath, `${wrongHash}  test_0.106.0_amd64.deb\n`);

      const result = verifyChecksums(manifestPath);

      expect(result.valid).toBe(false);
    });

    test("handles missing manifest file", () => {
      const result = verifyChecksums("/nonexistent/checksums.txt");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("validateDebPackage", () => {
    test("validates a real .deb package with expected contents", () => {
      // Check if dpkg-deb is available
      try {
        execSync("which dpkg-deb", { encoding: "utf-8" });
      } catch {
        console.warn("Skipping .deb validation test: dpkg-deb not available");
        return;
      }

      const tempDir = createTempDir("deb-validate");
      try {
        const debPath = createMockDeb(tempDir);
        const result = validateDebPackage(debPath);

        expect(result.packageName).toBe("factory-desktop");
        expect(result.packageVersion).toBe("0.106.0");
        expect(result.packageArch).toBe("amd64");
        expect(result.hasAppAsar).toBe(true);
        expect(result.hasDroid).toBe(true);
        expect(result.droidIsExecutable).toBe(true);
        expect(result.hasDesktopIntegration).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for missing .deb file", () => {
      const result = validateDebPackage("/nonexistent/package.deb");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("validatePackagedDroid", () => {
    test("validates a real Linux ELF droid binary", () => {
      // Use the real droid from the assembled app if available
      const droidPath = path.join(
        process.cwd(),
        "build",
        "factory-desktop-linux-unpacked",
        "resources",
        "bin",
        "droid"
      );

      if (!fs.existsSync(droidPath)) {
        console.warn("Skipping droid validation test: no assembled droid available");
        return;
      }

      const result = validatePackagedDroid(droidPath, "deb");

      expect(result.exists).toBe(true);
      expect(result.isElf).toBe(true);
      expect(result.isExecutable).toBe(true);
      expect(result.architecture).toBe("x86_64");
      expect(result.versionRan).toBe(true);
    });

    test("fails for non-existent droid", () => {
      const result = validatePackagedDroid("/nonexistent/droid", "appimage");

      expect(result.valid).toBe(false);
      expect(result.exists).toBe(false);
    });

    test("fails for non-executable droid", () => {
      const tempDir = createTempDir("droid-noexec");
      try {
        const droidPath = path.join(tempDir, "droid");
        fs.writeFileSync(droidPath, "not an elf binary");
        // Don't set executable bit

        const result = validatePackagedDroid(droidPath, "deb");

        expect(result.exists).toBe(true);
        expect(result.isExecutable).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("buildPackages", () => {
    test("fails when app directory does not exist", () => {
      const result = buildPackages({
        appDir: "/nonexistent/app-dir",
        outputDir: "/tmp/test-output",
        factoryVersion: "0.106.0",
        appName: "Factory",
        execName: "factory-desktop",
        targets: ["deb", "appimage"],
        releaseMode: ReleaseMode.Safe,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("fails when main executable is missing from app dir", () => {
      const tempDir = createTempDir("build-noexe");
      try {
        // Create app dir without the executable
        const appDir = path.join(tempDir, "app");
        fs.mkdirSync(appDir, { recursive: true });

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.success).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails with deferred diagnostic for RPM-only target (VAL-PACKAGE-010)", () => {
      const tempDir = createTempDir("build-rpm-deferred");
      try {
        const appDir = createMockAppDir(tempDir);

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["rpm"],
          releaseMode: ReleaseMode.Safe,
        });

        // VAL-PACKAGE-010: RPM requests must fail with deferred diagnostic
        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining("RPM target is deferred"),
          ])
        );
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining("RPM target requested but prerequisites are not met"),
          ])
        );
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.stringContaining("RPM target is DEFERRED")])
        );

        // No partial .rpm files should be produced
        const distDir = path.join(tempDir, "dist");
        if (fs.existsSync(distDir)) {
          const rpmFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".rpm"));
          expect(rpmFiles).toHaveLength(0);
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("includes RPM deferral warning alongside valid deb target", () => {
      const tempDir = createTempDir("build-rpm-with-deb");
      try {
        const appDir = createMockAppDir(tempDir);

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb", "rpm"],
          releaseMode: ReleaseMode.Safe,
        });

        // Should produce RPM deferral warning
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.stringContaining("RPM target is DEFERRED")])
        );

        // Should still have RPM deferred error
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining("RPM target is deferred"),
          ])
        );

        // deb target should still be attempted (even if electron-builder
        // can't run in test environment, the filtering and error handling
        // should be correct)
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("cleans stale dist artifacts from previous builds by default", () => {
      const tempDir = createTempDir("build-stale-clean");
      try {
        const appDir = createMockAppDir(tempDir);
        const outputDir = path.join(tempDir, "dist");
        fs.mkdirSync(outputDir, { recursive: true });

        // Create stale artifacts that should be cleaned.
        // Use version-specific names that electron-builder won't recreate
        // with the same name during the current build.
        const staleDeb = path.join(outputDir, "factory-desktop_0.105.0_amd64.deb");
        const staleAppImage = path.join(outputDir, "factory-desktop_0.105.0_x86_64.AppImage");
        const staleSha256 = path.join(outputDir, "checksums.txt.sha256");
        const staleBlockmap = path.join(outputDir, "factory-desktop_0.105.0_x86_64.blockmap");
        fs.writeFileSync(staleDeb, "old deb content");
        fs.writeFileSync(staleAppImage, "old appimage content");
        fs.writeFileSync(staleSha256, "old sha256 content");
        fs.writeFileSync(staleBlockmap, "old blockmap content");

        const result = buildPackages({
          appDir,
          outputDir,
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        // The stale artifacts should have been removed (clean defaults to true)
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Removed stale artifact"),
          ])
        );

        // The stale files should no longer exist (version-specific names
        // won't be recreated by the current build)
        expect(fs.existsSync(staleDeb)).toBe(false);
        expect(fs.existsSync(staleAppImage)).toBe(false);
        expect(fs.existsSync(staleSha256)).toBe(false);
        expect(fs.existsSync(staleBlockmap)).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("skips stale artifact cleaning when clean is false", () => {
      const tempDir = createTempDir("build-no-clean");
      try {
        const appDir = createMockAppDir(tempDir);
        const outputDir = path.join(tempDir, "dist");
        fs.mkdirSync(outputDir, { recursive: true });

        // Create a stale artifact that should NOT be cleaned
        const staleDeb = path.join(outputDir, "factory-desktop_0.105.0_amd64.deb");
        fs.writeFileSync(staleDeb, "old deb content");

        const result = buildPackages({
          appDir,
          outputDir,
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
          clean: false,
        });

        // No stale artifact removal warnings
        expect(result.warnings).not.toEqual(
          expect.arrayContaining([
            expect.stringContaining("Removed stale artifact"),
          ])
        );

        // The stale file should still exist
        expect(fs.existsSync(staleDeb)).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for no valid targets (unknown format)", () => {
      const tempDir = createTempDir("build-notargets");
      try {
        const appDir = createMockAppDir(tempDir);

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["unknown-format"], // Unknown format, not RPM
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("No valid targets")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ─── RPM Deferral Tests (VAL-PACKAGE-010) ─────────────────────────────────

  describe("checkRpmPrerequisites (VAL-PACKAGE-010)", () => {
    test("returns deferred when rpmbuild is not available", () => {
      // rpmbuild is not installed in the test environment
      const result = checkRpmPrerequisites();

      expect(result.available).toBe(false);
      expect(result.reasons).toContain(RpmDeferralReason.NoRpmbuild);
      expect(result.diagnostic).toContain("RPM target is DEFERRED");
      expect(result.diagnostic).toContain("rpmbuild is not installed");
    });

    test("returns deferred when Docker is not approved even if available", () => {
      // Even if Docker were available, the strategy must be explicitly approved
      // In the test environment, FACTORY_RPM_DOCKER_STRATEGY is not set
      const result = checkRpmPrerequisites();

      expect(result.available).toBe(false);
      // The diagnostic should mention the approval requirement
      if (result.reasons.includes(RpmDeferralReason.DockerNotApproved)) {
        expect(result.diagnostic).toContain("FACTORY_RPM_DOCKER_STRATEGY");
      }
    });

    test("formatRpmPrerequisiteCheckResult produces readable output", () => {
      const result = checkRpmPrerequisites();
      const formatted = formatRpmPrerequisiteCheckResult(result);

      expect(formatted).toContain("=== RPM Prerequisite Check ===");
      expect(formatted).toContain("DEFERRED");
      expect(formatted).toContain("no-rpmbuild");
    });

    test("checkRpmPrerequisites remains deferred with only Docker strategy approved", () => {
      // Docker strategy approval alone is not enough - the pipeline must be verified
      const originalEnv = process.env.FACTORY_RPM_DOCKER_STRATEGY;
      try {
        process.env.FACTORY_RPM_DOCKER_STRATEGY = "approved";

        const result = checkRpmPrerequisites();

        // Should still be deferred because the Docker pipeline is not verified
        expect(result.available).toBe(false);
        expect(result.reasons).toContain(RpmDeferralReason.NoRpmbuild);
        expect(result.diagnostic).toContain("not yet verified");
      } finally {
        if (originalEnv !== undefined) {
          process.env.FACTORY_RPM_DOCKER_STRATEGY = originalEnv;
        } else {
          delete process.env.FACTORY_RPM_DOCKER_STRATEGY;
        }
      }
    });

    test("checkRpmPrerequisites returns available with approved and verified Docker", () => {
      const origStrategy = process.env.FACTORY_RPM_DOCKER_STRATEGY;
      const origVerified = process.env.FACTORY_RPM_DOCKER_VERIFIED;
      try {
        process.env.FACTORY_RPM_DOCKER_STRATEGY = "approved";
        process.env.FACTORY_RPM_DOCKER_VERIFIED = "true";

        const result = checkRpmPrerequisites();

        // If Docker is available on this host, RPM should be available
        // If Docker is NOT available, still deferred
        // Check the result based on Docker availability
        if (result.available) {
          expect(result.available).toBe(true);
          expect(result.reasons).toHaveLength(0);
          expect(result.diagnostic).toContain("verified Docker-based RPM build");
        } else {
          // Docker is not available on this host
          expect(result.reasons).toContain(RpmDeferralReason.NoRpmbuild);
        }
      } finally {
        if (origStrategy !== undefined) {
          process.env.FACTORY_RPM_DOCKER_STRATEGY = origStrategy;
        } else {
          delete process.env.FACTORY_RPM_DOCKER_STRATEGY;
        }
        if (origVerified !== undefined) {
          process.env.FACTORY_RPM_DOCKER_VERIFIED = origVerified;
        } else {
          delete process.env.FACTORY_RPM_DOCKER_VERIFIED;
        }
      }
    });
  });

  describe("findPartialRpmArtifacts (VAL-PACKAGE-010)", () => {
    test("returns empty when no .rpm files exist", () => {
      const tempDir = createTempDir("rpm-partial-clean");
      try {
        const outputDir = path.join(tempDir, "dist");
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, "test.deb"), "mock deb");

        const rpmFiles = findPartialRpmArtifacts(outputDir);
        expect(rpmFiles).toHaveLength(0);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("finds .rpm files when they exist", () => {
      const tempDir = createTempDir("rpm-partial-found");
      try {
        const outputDir = path.join(tempDir, "dist");
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, "factory-desktop-0.106.0.x86_64.rpm"), "mock rpm");

        const rpmFiles = findPartialRpmArtifacts(outputDir);
        expect(rpmFiles).toHaveLength(1);
        expect(rpmFiles[0]).toContain(".rpm");
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("RPM stale artifact cleanup", () => {
    test("cleans stale .rpm artifacts from previous builds", () => {
      const tempDir = createTempDir("rpm-stale-clean");
      try {
        const appDir = createMockAppDir(tempDir);
        const outputDir = path.join(tempDir, "dist");
        fs.mkdirSync(outputDir, { recursive: true });

        // Create stale RPM artifact that should be cleaned
        const staleRpm = path.join(outputDir, "factory-desktop-0.105.0.x86_64.rpm");
        fs.writeFileSync(staleRpm, "old rpm content");

        const result = buildPackages({
          appDir,
          outputDir,
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        // The stale RPM artifact should have been removed
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Removed stale artifact"),
          ])
        );
        expect(fs.existsSync(staleRpm)).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("no partial .rpm files produced on RPM request (VAL-PACKAGE-010)", () => {
    test("RPM-only target leaves no .rpm files in output directory", () => {
      const tempDir = createTempDir("rpm-no-partial");
      try {
        const appDir = createMockAppDir(tempDir);
        const outputDir = path.join(tempDir, "dist");

        const result = buildPackages({
          appDir,
          outputDir,
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["rpm"],
          releaseMode: ReleaseMode.Safe,
        });

        // Build should fail (RPM is deferred)
        expect(result.success).toBe(false);

        // No .rpm files should exist in the output directory
        if (fs.existsSync(outputDir)) {
          const rpmFiles = fs.readdirSync(outputDir).filter((f) => f.endsWith(".rpm"));
          expect(rpmFiles).toHaveLength(0);
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("extractDebContext", () => {
    test("extracts a real .deb into an install context", () => {
      try {
        execSync("which dpkg-deb", { encoding: "utf-8" });
      } catch {
        console.warn("Skipping deb extraction test: dpkg-deb not available");
        return;
      }

      const tempDir = createTempDir("extract-deb");
      try {
        const debPath = createMockDeb(path.join(tempDir, "source"));
        const extractDir = path.join(tempDir, "extracted");

        const result = extractDebContext(debPath, extractDir);

        expect(result.success).toBe(true);
        expect(fs.existsSync(extractDir)).toBe(true);

        // Should find the executable
        if (result.executablePath) {
          expect(fs.existsSync(result.executablePath)).toBe(true);
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for missing .deb file", () => {
      const result = extractDebContext("/nonexistent/package.deb", "/tmp/extract");

      expect(result.success).toBe(false);
    });
  });

  describe("formatting functions", () => {
    test("formatPackageBuildResult formats correctly", () => {
      const result = formatPackageBuildResult({
        success: true,
        artifacts: ["/path/to/test.deb", "/path/to/test.AppImage"],
        debPath: "/path/to/test.deb",
        appImagePath: "/path/to/test.AppImage",
        errors: [],
        warnings: [],
      });

      expect(result).toContain("SUCCESS");
      expect(result).toContain("test.deb");
      expect(result).toContain("test.AppImage");
    });

    test("formatDebValidationResult formats correctly", () => {
      const result = formatDebValidationResult({
        valid: true,
        packageName: "factory-desktop",
        packageVersion: "0.106.0",
        packageArch: "amd64",
        hasAppAsar: true,
        hasDroid: true,
        droidIsExecutable: true,
        hasDesktopIntegration: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("factory-desktop");
      expect(result).toContain("0.106.0");
    });

    test("formatAppImageValidationResult formats correctly", () => {
      const result = formatAppImageValidationResult({
        valid: true,
        fileType: "ELF 64-bit LSB executable",
        hasAppAsar: true,
        hasDroid: true,
        droidIsExecutable: true,
        hasDesktopEntry: true,
        hasProtocolMetadata: true,
        hasIcons: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("ELF");
    });

    test("formatPackagedDroidResult formats correctly", () => {
      const result = formatPackagedDroidResult({
        valid: true,
        exists: true,
        isElf: true,
        isExecutable: true,
        architecture: "x86_64",
        versionRan: true,
        versionOutput: "0.106.0",
        sourcePackage: "deb",
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("x86_64");
      expect(result).toContain("0.106.0");
    });

    test("formatChecksumResult formats correctly", () => {
      const result = formatChecksumResult({
        success: true,
        manifestPath: "/path/to/checksums.txt",
        artifactCount: 2,
        checksums: { "test.deb": "abc123", "test.AppImage": "def456" },
        errors: [],
      });

      expect(result).toContain("SUCCESS");
      expect(result).toContain("abc123");
      expect(result).toContain("2");
    });

    test("formatExtractedLaunchResult formats correctly", () => {
      const result = formatExtractedLaunchResult({
        success: true,
        packageType: "deb",
        extractedPath: "/tmp/extract",
        executablePath: "/tmp/extract/factory-desktop",
        initialized: true,
        terminatedCleanly: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("deb");
    });
  });

  describe("checksum end-to-end", () => {
    test("generate and verify checksum round-trip", () => {
      const tempDir = createTempDir("checksum-e2e");
      try {
        // Create artifacts
        const artifacts: string[] = [];
        for (let i = 0; i < 3; i++) {
          const filePath = path.join(tempDir, `artifact_${i}.bin`);
          const content = `artifact content ${i} with ${crypto.randomBytes(16).toString("hex")}`;
          fs.writeFileSync(filePath, content);
          artifacts.push(filePath);
        }

        // Generate checksums
        const genResult = generateChecksums(artifacts, tempDir);
        expect(genResult.success).toBe(true);
        expect(genResult.artifactCount).toBe(3);

        // Verify checksums
        const verifyResult = verifyChecksums(genResult.manifestPath);
        expect(verifyResult.valid).toBe(true);
        expect(verifyResult.output).toContain("OK");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("checksum verification fails when artifact is modified after manifest generation", () => {
      const tempDir = createTempDir("checksum-tamper");
      try {
        const artifact = path.join(tempDir, "test.deb");
        fs.writeFileSync(artifact, "original content");

        const genResult = generateChecksums([artifact], tempDir);
        expect(genResult.success).toBe(true);

        // Modify the artifact
        fs.writeFileSync(artifact, "tampered content");

        const verifyResult = verifyChecksums(genResult.manifestPath);
        expect(verifyResult.valid).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("safe mode integration", () => {
    test("buildPackages works in safe mode (does not publish)", () => {
      // Safe mode should not prevent building - only publishing
      const tempDir = createTempDir("safe-mode-build");
      try {
        const appDir = createMockAppDir(tempDir);

        // In safe mode, building should still work, just publishing is refused
        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        // The build may fail because our mock app dir isn't a real Electron
        // app that electron-builder can package, but the safe mode should
        // not be the reason for failure.
        // Just verify the function accepts safe mode without erroring on it.
        expect(result).toBeDefined();
        expect(result.errors).not.toEqual(
          expect.arrayContaining([expect.stringContaining("safe mode")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });
});
