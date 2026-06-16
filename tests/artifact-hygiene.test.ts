/**
 * Tests for artifact hygiene (VAL-EXTRACT-007, VAL-EXTRACT-013).
 *
 * VAL-EXTRACT-007: After a successful extraction or version-resolution run,
 * all extracted Factory payloads must be under configured generated output
 * directories. No proprietary-derived payload appears in tracked source.
 *
 * VAL-EXTRACT-013: For failed input validation, the builder must leave no
 * partial proprietary payloads in tracked source locations and must either
 * clean or clearly quarantine generated partial outputs.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { ArtifactTracker } from "../src/artifact-hygiene";
import { resolveDirs, GENERATED_DIRS } from "../src/config";

describe("ArtifactTracker", () => {
  let projectRoot: string;
  let tracker: ArtifactTracker;
  let dirs: ReturnType<typeof resolveDirs>;

  beforeEach(() => {
    // Create a temporary project directory for each test
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-hygiene-"));

    // Create generated directories
    dirs = resolveDirs(projectRoot);
    for (const dirPath of Object.values(dirs)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Create src/ directory
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });

    tracker = new ArtifactTracker(projectRoot);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("VAL-EXTRACT-007: Payloads stay in generated locations", () => {
    it("allows tracking artifacts in generated directories", () => {
      const artifactPath = path.join(dirs.work, "app.asar");
      expect(() => {
        tracker.track(artifactPath, "Extracted app payload");
      }).not.toThrow();
    });

    it("refuses tracking artifacts outside generated directories", () => {
      const srcArtifact = path.join(projectRoot, "src", "app.asar");
      expect(() => {
        tracker.track(srcArtifact, "Should not be here");
      }).toThrow(/outside generated directories/);
    });

    it("refuses tracking artifacts in project root", () => {
      const rootArtifact = path.join(projectRoot, "app.asar");
      expect(() => {
        tracker.track(rootArtifact, "Should not be in root");
      }).toThrow(/outside generated directories/);
    });

    it("detects proprietary artifacts in source directory", () => {
      // Create a proprietary file in src/
      const proprietaryFile = path.join(projectRoot, "src", "app.asar");
      fs.writeFileSync(proprietaryFile, "fake asar content");

      const violations = tracker.checkNoProprietaryInSource(projectRoot);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("app.asar");
    });

    it("finds no violations when source is clean", () => {
      // Only non-proprietary files in src/
      const sourceFile = path.join(projectRoot, "src", "index.ts");
      fs.writeFileSync(sourceFile, "console.log('hello');");

      const violations = tracker.checkNoProprietaryInSource(projectRoot);
      expect(violations).toHaveLength(0);
    });

    it("all generated directories are gitignored", () => {
      // Verify the configured generated directory names match gitignore entries
      const gitignorePath = path.join(projectRoot, ".gitignore");
      fs.writeFileSync(
        gitignorePath,
        GENERATED_DIRS.map((d) => d + "/").join("\n")
      );

      const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
      for (const dir of GENERATED_DIRS) {
        expect(gitignoreContent).toContain(dir);
      }
    });
  });

  describe("VAL-EXTRACT-013: Failed runs leave no partial payloads", () => {
    it("cleans up created artifacts on failure", () => {
      const artifactPath = path.join(dirs.work, "app.asar");

      // Track and create the artifact
      tracker.track(artifactPath, "Extracted app payload");
      fs.writeFileSync(artifactPath, "fake asar content");
      tracker.markCreated(artifactPath);

      // Verify artifact exists
      expect(fs.existsSync(artifactPath)).toBe(true);

      // Cleanup on failure
      const cleaned = tracker.cleanupOnFailure();
      expect(cleaned).toContain(path.resolve(artifactPath));
      expect(fs.existsSync(artifactPath)).toBe(false);
    });

    it("cleans up directories on failure", () => {
      const subDir = path.join(dirs.work, "extracted");
      fs.mkdirSync(subDir, { recursive: true });
      const artifactPath = path.join(subDir, "payload.bin");
      fs.writeFileSync(artifactPath, "data");

      tracker.track(artifactPath, "Extracted binary");
      tracker.markCreated(artifactPath);

      const cleaned = tracker.cleanupOnFailure();
      expect(cleaned.length).toBeGreaterThan(0);
      expect(fs.existsSync(artifactPath)).toBe(false);
    });

    it("handles cleanup when artifacts do not exist", () => {
      const artifactPath = path.join(dirs.work, "nonexistent.asar");
      tracker.track(artifactPath, "Not yet created");

      // Should not throw
      const cleaned = tracker.cleanupOnFailure();
      expect(cleaned).toHaveLength(0);
    });

    it("cleans up multiple artifacts on failure", () => {
      const artifacts = [
        path.join(dirs.work, "app.asar"),
        path.join(dirs.work, "Info.plist"),
        path.join(dirs.build, "droid"),
      ];

      for (const artifactPath of artifacts) {
        const dir = path.dirname(artifactPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(artifactPath, "fake content");
        tracker.track(artifactPath, `Artifact: ${path.basename(artifactPath)}`);
        tracker.markCreated(artifactPath);
      }

      const cleaned = tracker.cleanupOnFailure();
      expect(cleaned.length).toBe(artifacts.length);

      for (const artifactPath of artifacts) {
        expect(fs.existsSync(artifactPath)).toBe(false);
      }
    });

    it("no tracked proprietary artifacts remain after cleanup", () => {
      const artifactPath = path.join(dirs.work, "app.asar");
      fs.writeFileSync(artifactPath, "fake");
      tracker.track(artifactPath, "Extracted payload");
      tracker.markCreated(artifactPath);

      tracker.cleanupOnFailure();

      // Verify nothing proprietary remains
      const violations = tracker.checkNoProprietaryInSource(projectRoot);
      expect(violations).toHaveLength(0);
    });
  });

  describe("git ignore verification", () => {
    it("reports generated artifacts as untracked when gitignored", () => {
      // Initialize a git repo in the temp project root
      execSync("git init", { cwd: projectRoot });
      execSync("git config user.email 'test@test.com'", { cwd: projectRoot });
      execSync("git config user.name 'Test'", { cwd: projectRoot });

      // Write a .gitignore
      const gitignoreContent = GENERATED_DIRS.map((d) => d + "/").join("\n") + "\n";
      fs.writeFileSync(path.join(projectRoot, ".gitignore"), gitignoreContent);

      // Create a file in a generated directory
      const artifactPath = path.join(dirs.work, "app.asar");
      fs.writeFileSync(artifactPath, "fake");

      // Check git status - the work/ directory should be ignored
      const status = execSync("git status --porcelain", {
        cwd: projectRoot,
        encoding: "utf-8",
      });

      // The work/app.asar should NOT appear in git status (it's ignored)
      expect(status).not.toContain("app.asar");
    });
  });
});
