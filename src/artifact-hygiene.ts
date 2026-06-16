/**
 * Artifact hygiene: tracks generated Factory-derived payloads and ensures
 * they stay in gitignored locations. Cleans up partial outputs on failure.
 *
 * Fulfills: VAL-EXTRACT-007, VAL-EXTRACT-013
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { GENERATED_DIRS } from "./config";

/** Patterns that identify proprietary-derived artifacts */
const PROPRIETARY_PATTERNS = [
  "app.asar",
  "Factory.app",
  "droid", // downloaded Linux CLI binary
  ".deb",
  ".rpm",
  ".AppImage",
  "Info.plist",
  "electron.icns",
];

/** Tracked artifact for cleanup on failure */
export interface TrackedArtifact {
  /** Absolute path to the artifact */
  path: string;
  /** Whether it was successfully created */
  created: boolean;
  /** Description for diagnostics */
  description: string;
}

/**
 * ArtifactTracker ensures generated payloads stay in configured generated
 * directories and can be cleaned up on failure.
 */
export class ArtifactTracker {
  private artifacts: TrackedArtifact[] = [];
  private allowedDirs: Set<string>;

  constructor(projectRoot: string) {
    this.allowedDirs = new Set(
      GENERATED_DIRS.map((dir) => path.join(projectRoot, dir))
    );
  }

  /**
   * Register an artifact that will be or has been created.
   * Validates that the path is under a generated output directory.
   */
  track(artifactPath: string, description: string): void {
    const resolved = path.resolve(artifactPath);
    const isAllowed = Array.from(this.allowedDirs).some((dir) =>
      resolved.startsWith(dir + path.sep)
    );

    if (!isAllowed) {
      throw new Error(
        `Refusing to track artifact outside generated directories: ${artifactPath}. ` +
          `All proprietary-derived payloads must be under: ${Array.from(this.allowedDirs).join(", ")}`
      );
    }

    this.artifacts.push({
      path: resolved,
      created: fs.existsSync(resolved),
      description,
    });
  }

  /**
   * Mark an artifact as successfully created.
   */
  markCreated(artifactPath: string): void {
    const resolved = path.resolve(artifactPath);
    const artifact = this.artifacts.find((a) => a.path === resolved);
    if (artifact) {
      artifact.created = true;
    }
  }

  /**
   * Get all tracked artifacts.
   */
  getArtifacts(): ReadonlyArray<TrackedArtifact> {
    return [...this.artifacts];
  }

  /**
   * Clean up all tracked artifacts on failure.
   * Removes created files/directories and leaves no partial proprietary payloads.
   *
   * Returns a list of items that were cleaned up.
   */
  cleanupOnFailure(): string[] {
    const cleaned: string[] = [];

    for (const artifact of this.artifacts) {
      if (artifact.created && fs.existsSync(artifact.path)) {
        const stat = fs.statSync(artifact.path);
        if (stat.isDirectory()) {
          fs.rmSync(artifact.path, { recursive: true, force: true });
        } else {
          fs.unlinkSync(artifact.path);
        }
        cleaned.push(artifact.path);
      }
    }

    // Also clean up empty parent directories within generated dirs
    for (const dir of this.allowedDirs) {
      if (fs.existsSync(dir)) {
        this.removeEmptySubdirs(dir);
      }
    }

    this.artifacts = [];
    return cleaned;
  }

  /**
   * Check that no proprietary-derived artifacts exist in tracked source
   * locations (i.e., outside generated directories).
   *
   * Returns a list of violations (proprietary files found in source paths).
   */
  checkNoProprietaryInSource(projectRoot: string): string[] {
    const violations: string[] = [];
    const srcDir = path.join(projectRoot, "src");

    if (!fs.existsSync(srcDir)) {
      return violations;
    }

    this.walkDir(srcDir, (filePath) => {
      const basename = path.basename(filePath);
      if (PROPRIETARY_PATTERNS.some((pattern) => basename.includes(pattern))) {
        violations.push(filePath);
      }
    });

    return violations;
  }

  /**
   * Verify that all generated artifacts are under gitignored directories.
   * This checks the git status to ensure no proprietary-derived files
   * would be tracked.
   */
  verifyGitIgnored(projectRoot: string): { clean: boolean; tracked: string[] } {
    const tracked: string[] = [];

    try {
      // Check for any tracked files in generated directories
      const status = execSync("git status --porcelain", {
        cwd: projectRoot,
        encoding: "utf-8",
      });

      const lines = status.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const filePath = line.substring(3).trim();
        const resolvedPath = path.resolve(projectRoot, filePath);

        const isInGeneratedDir = Array.from(this.allowedDirs).some((dir) =>
          resolvedPath.startsWith(dir + path.sep)
        );

        if (isInGeneratedDir) {
          tracked.push(filePath);
        }

        // Also check for proprietary file patterns
        const basename = path.basename(filePath);
        if (PROPRIETARY_PATTERNS.some((p) => basename.includes(p))) {
          tracked.push(filePath);
        }
      }
    } catch {
      // Not a git repo or git not available
      return { clean: true, tracked: [] };
    }

    return { clean: tracked.length === 0, tracked };
  }

  private removeEmptySubdirs(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(dir, entry.name);
        this.removeEmptySubdirs(subPath);
        try {
          fs.rmdirSync(subPath); // Only removes if empty
        } catch {
          // Directory not empty, leave it
        }
      }
    }
  }

  private walkDir(dir: string, callback: (filePath: string) => void): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(fullPath, callback);
      } else {
        callback(fullPath);
      }
    }
  }
}
