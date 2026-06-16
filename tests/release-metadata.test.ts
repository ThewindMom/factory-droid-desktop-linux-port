/**
 * Tests for release-metadata module: GitHub Releases metadata generation,
 * feed URL validation, and metadata completeness validation.
 *
 * Fulfills: VAL-PACKAGE-007
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  generateReleaseMetadata,
  validateFeedUrl,
  validateReleaseMetadataCompleteness,
  computeFileSha512,
  hexToBase64,
  formatReleaseMetadataResult,
  LINUX_UPDATE_METADATA_FILENAME,
  FACTORY_OFFICIAL_FEED_PATTERNS,
  ReleaseMetadataDocument,
  ArtifactMetadata,
} from "../src/release-metadata";
import { ReleaseMode } from "../src/config";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `factory-release-meta-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function createMockArtifact(dir: string, name: string, content: string = "mock artifact content"): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("release-metadata", () => {
  describe("computeFileSha512 and hexToBase64", () => {
    test("computes correct SHA-512 hash", () => {
      const tempDir = createTempDir("sha512");
      try {
        const content = "test content for sha512";
        const filePath = createMockArtifact(tempDir, "test.deb", content);

        const expectedHex = crypto.createHash("sha512").update(content).digest("hex");
        const result = computeFileSha512(filePath);
        expect(result).toBe(expectedHex);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("hexToBase64 converts correctly", () => {
      const hex = crypto.createHash("sha512").update("test").digest("hex");
      const base64 = hexToBase64(hex);
      // Verify round-trip
      const decoded = Buffer.from(base64, "base64").toString("hex");
      expect(decoded).toBe(hex);
    });
  });

  describe("generateReleaseMetadata", () => {
    test("refuses to generate metadata in safe mode", () => {
      const tempDir = createTempDir("safe-refuse");
      try {
        const artifact = createMockArtifact(tempDir, "test.AppImage");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.Safe,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [artifact],
          outputDir: path.join(tempDir, "dist"),
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("safe/source-only mode")])
        );
        expect(result.metadataPath).toBe("");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("generates metadata in permission-cleared mode", () => {
      const tempDir = createTempDir("perm-cleared");
      try {
        const distDir = path.join(tempDir, "dist");
        const artifact = createMockArtifact(distDir, "Factory-0.106.0.AppImage", "appimage content");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [artifact],
          outputDir: distDir,
        });

        expect(result.success).toBe(true);
        expect(result.metadataPath).toBe(path.join(distDir, LINUX_UPDATE_METADATA_FILENAME));
        expect(result.document).toBeDefined();
        expect(result.document!.version).toBe("0.106.0");
        expect(result.document!.files.length).toBe(1);
        expect(result.document!.files[0].primary).toBe(true);

        // Verify the metadata file was written
        expect(fs.existsSync(result.metadataPath)).toBe(true);
        const content = fs.readFileSync(result.metadataPath, "utf-8");
        expect(content).toContain("version: 0.106.0");
        expect(content).toContain("sha512:");
        expect(content).toContain("releaseDate:");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("generates metadata for both deb and AppImage", () => {
      const tempDir = createTempDir("both-artifacts");
      try {
        const distDir = path.join(tempDir, "dist");
        const debArtifact = createMockArtifact(distDir, "factory-desktop_0.106.0_amd64.deb", "deb content");
        const appImageArtifact = createMockArtifact(distDir, "Factory-0.106.0.AppImage", "appimage content");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [debArtifact, appImageArtifact],
          outputDir: distDir,
        });

        expect(result.success).toBe(true);
        expect(result.document!.files.length).toBe(2);

        // AppImage should be primary
        const appImageFile = result.document!.files.find(
          (f) => f.url.includes("AppImage")
        );
        expect(appImageFile?.primary).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails when artifact does not exist", () => {
      const tempDir = createTempDir("missing-artifact");
      try {
        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: ["/nonexistent/test.AppImage"],
          outputDir: path.join(tempDir, "dist"),
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("Artifact not found")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for invalid version format", () => {
      const tempDir = createTempDir("invalid-ver");
      try {
        const distDir = path.join(tempDir, "dist");
        const artifact = createMockArtifact(distDir, "test.AppImage");

        const result = generateReleaseMetadata({
          version: "not-a-version",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [artifact],
          outputDir: distDir,
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("Invalid version")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("rejects Factory official feed URLs in download links", () => {
      const tempDir = createTempDir("factory-feed");
      try {
        const distDir = path.join(tempDir, "dist");
        const artifact = createMockArtifact(distDir, "test.AppImage");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [artifact],
          outputDir: distDir,
          downloadBaseUrl: "https://update.factory.ai/releases",
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("Factory's official update channel")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("includes correct SHA-512 base64 hashes", () => {
      const tempDir = createTempDir("sha512-b64");
      try {
        const distDir = path.join(tempDir, "dist");
        const content = "test content for sha512 base64";
        const artifact = createMockArtifact(distDir, "test.AppImage", content);

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [artifact],
          outputDir: distDir,
        });

        expect(result.success).toBe(true);
        const expectedHex = crypto.createHash("sha512").update(content).digest("hex");
        const expectedBase64 = Buffer.from(expectedHex, "hex").toString("base64");
        expect(result.document!.files[0].sha512Base64).toBe(expectedBase64);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("validateFeedUrl", () => {
    test("accepts this project's GitHub releases URL", () => {
      const result = validateFeedUrl(
        "https://github.com/test-owner/test-repo/latest-linux.yml"
      );
      expect(result.valid).toBe(true);
    });

    test("rejects Factory official update URLs", () => {
      for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
        const result = validateFeedUrl(`https://${pattern}/some-path`);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Factory's official update channel");
      }
    });

    test("rejects factory.ai/api/update feed", () => {
      const result = validateFeedUrl(
        "https://factory.ai/api/update/darwin/0.106.0"
      );
      expect(result.valid).toBe(false);
    });
  });

  describe("validateReleaseMetadataCompleteness", () => {
    test("passes for complete metadata", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/releases/download/v0.106.0/Factory-0.106.0.AppImage",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "Factory-0.106.0.AppImage",
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(
        document,
        ["Factory-0.106.0.AppImage"]
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("fails when expected artifact is omitted", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/releases/download/v0.106.0/Factory-0.106.0.AppImage",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "Factory-0.106.0.AppImage",
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(
        document,
        ["Factory-0.106.0.AppImage", "factory-desktop_0.106.0_amd64.deb"]
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("omits expected artifact")])
      );
    });

    test("fails when checksum is missing", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/test.AppImage",
            sha512: "",
            sha512Base64: "",
            size: 123456,
            primary: true,
          },
        ],
        path: "test.AppImage",
        sha512: "",
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(document, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("without checksum")])
      );
    });

    test("fails when feed URL points to Factory official feed", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/test.AppImage",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "test.AppImage",
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://update.factory.ai/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(document, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Factory's official")])
      );
    });

    test("fails for missing required fields", () => {
      const document = {
        version: "",
        files: [] as ArtifactMetadata[],
        path: "",
        sha512: "",
        releaseDate: "",
        channel: "latest",
        feedUrl: "https://github.com/test/test/latest-linux.yml",
      } as ReleaseMetadataDocument;

      const result = validateReleaseMetadataCompleteness(document, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("version"),
          expect.stringContaining("releaseDate"),
          expect.stringContaining("path"),
          expect.stringContaining("sha512"),
        ])
      );
    });
  });

  // ─── RPM Availability Guard Tests (VAL-PACKAGE-010) ────────────────────────

  describe("RPM artifact rejection (VAL-PACKAGE-010)", () => {
    test("generateReleaseMetadata rejects RPM artifact paths", () => {
      const tempDir = createTempDir("rpm-reject");
      try {
        const debPath = createMockArtifact(tempDir, "factory-desktop_0.106.0_amd64.deb");
        const rpmPath = createMockArtifact(tempDir, "factory-desktop-0.106.0.x86_64.rpm");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [debPath, rpmPath],
          outputDir: tempDir,
        });

        // Should fail because RPM artifacts are not allowed in release metadata
        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Release metadata must not include RPM artifacts"),
          ])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("generateReleaseMetadata succeeds with only deb and AppImage", () => {
      const tempDir = createTempDir("rpm-not-included");
      try {
        const debPath = createMockArtifact(tempDir, "factory-desktop_0.106.0_amd64.deb");
        const appImagePath = createMockArtifact(tempDir, "Factory-0.106.0.AppImage");

        const result = generateReleaseMetadata({
          version: "0.106.0",
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          artifactPaths: [debPath, appImagePath],
          outputDir: tempDir,
        });

        // Should succeed because no RPM artifacts are included
        expect(result.success).toBe(true);
        expect(result.errors).not.toEqual(
          expect.arrayContaining([
            expect.stringContaining("RPM"),
          ])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("validateReleaseMetadataCompleteness rejects RPM file references", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/releases/download/v0.106.0/factory-desktop-0.106.0.x86_64.rpm",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "factory-desktop-0.106.0.x86_64.rpm",
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(
        document,
        ["factory-desktop-0.106.0.x86_64.rpm"]
      );

      // Should fail because metadata claims RPM availability
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("claims RPM availability"),
        ])
      );
    });

    test("validateReleaseMetadataCompleteness rejects RPM primary path", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/releases/download/v0.106.0/Factory-0.106.0.AppImage",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "factory-desktop-0.106.0.x86_64.rpm", // RPM path reference
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(
        document,
        ["Factory-0.106.0.AppImage"]
      );

      // Should fail because primary path references RPM
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("primary path references an RPM artifact"),
        ])
      );
    });

    test("validateReleaseMetadataCompleteness passes without RPM references", () => {
      const document: ReleaseMetadataDocument = {
        version: "0.106.0",
        files: [
          {
            url: "https://github.com/test/test/releases/download/v0.106.0/Factory-0.106.0.AppImage",
            sha512: "a".repeat(128),
            sha512Base64: Buffer.from("a".repeat(128), "hex").toString("base64"),
            size: 123456,
            primary: true,
          },
        ],
        path: "Factory-0.106.0.AppImage",
        sha512: Buffer.from("a".repeat(128), "hex").toString("base64"),
        releaseDate: "2024-01-01T00:00:00.000Z",
        channel: "latest",
        feedUrl: "https://github.com/test-owner/test-repo/latest-linux.yml",
      };

      const result = validateReleaseMetadataCompleteness(
        document,
        ["Factory-0.106.0.AppImage"]
      );

      // Should pass - no RPM references
      expect(result.valid).toBe(true);
      expect(result.errors).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("RPM"),
        ])
      );
    });
  });

  describe("formatReleaseMetadataResult", () => {
    test("formats success result", () => {
      const result = formatReleaseMetadataResult({
        success: true,
        metadataPath: "/dist/latest-linux.yml",
        document: {
          version: "0.106.0",
          files: [{
            url: "https://github.com/test/test/Factory-0.106.0.AppImage",
            sha512: "abc",
            sha512Base64: "base64abc",
            size: 123456,
            primary: true,
          }],
          path: "Factory-0.106.0.AppImage",
          sha512: "base64abc",
          releaseDate: "2024-01-01",
          channel: "latest",
          feedUrl: "https://github.com/test/test/latest-linux.yml",
        },
        errors: [],
        warnings: [],
      });

      expect(result).toContain("SUCCESS");
      expect(result).toContain("0.106.0");
    });

    test("formats failure result", () => {
      const result = formatReleaseMetadataResult({
        success: false,
        metadataPath: "",
        errors: ["Safe mode refuses publishing"],
        warnings: [],
      });

      expect(result).toContain("FAILED");
      expect(result).toContain("Safe mode");
    });
  });
});
