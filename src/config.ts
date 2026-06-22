/**
 * Builder configuration: paths, safe mode defaults, and release mode management.
 *
 * All generated Factory-derived artifacts must live under configured generated
 * output directories that are gitignored. The default mode is safe/source-only,
 * which refuses proprietary binary publishing.
 */

import * as path from "path";
import * as fs from "fs";

/** Generated artifact directories (all gitignored) */
export const GENERATED_DIRS = ["work", "build", "dist", "out", ".cache"] as const;
export type GeneratedDir = (typeof GENERATED_DIRS)[number];

/** Release mode determines what can be published */
export enum ReleaseMode {
  /** Default: source/build scripts only, no binary artifact publishing */
  Safe = "safe",
  /** Permission-cleared: may publish .deb, AppImage, and update metadata */
  PermissionCleared = "permission-cleared",
}

/** Resolved builder configuration */
export interface BuilderConfig {
  /** Root directory of the builder project */
  projectRoot: string;
  /** Path to user-supplied x64 DMG */
  dmgPath: string;
  /** Optional path to arm64 DMG for parity checking */
  arm64DmgPath?: string;
  /** Requested Factory Desktop version (or "latest") */
  version: string;
  /** Release mode (defaults to safe) */
  releaseMode: ReleaseMode;
  /** Generated artifact output directories */
  dirs: Record<GeneratedDir, string>;
  /** Target package formats */
  targets: string[];
}

/** Default release mode is safe/source-only */
export const DEFAULT_RELEASE_MODE = ReleaseMode.Safe;

/**
 * Resolve generated directory paths relative to project root.
 *
 * When the updater (factory-update-manager) drives a rebuild, it sets
 * FACTORY_DIST_DIR / FACTORY_WORK_DIR / FACTORY_INSTALL_DIR to redirect
 * outputs into a per-candidate workspace. This keeps the builder checkout
 * clean and lets the updater find the produced .deb.
 */
export function resolveDirs(projectRoot: string): Record<GeneratedDir, string> {
  const envOverride = (key: string, fallback: string): string =>
    process.env[key] || fallback;

  return {
    work: envOverride("FACTORY_WORK_DIR", path.join(projectRoot, "work")),
    build: envOverride("FACTORY_BUILD_DIR", path.join(projectRoot, "build")),
    dist: envOverride("FACTORY_DIST_DIR", path.join(projectRoot, "dist")),
    out: envOverride("FACTORY_OUT_DIR", path.join(projectRoot, "out")),
    ".cache": path.join(projectRoot, ".cache"),
  };
}

/**
 * Validate and resolve a release mode string.
 * Defaults to Safe if not provided.
 */
export function resolveReleaseMode(mode?: string): ReleaseMode {
  if (!mode) return DEFAULT_RELEASE_MODE;
  const normalized = mode.toLowerCase().trim();
  if (normalized === "safe" || normalized === ReleaseMode.Safe) {
    return ReleaseMode.Safe;
  }
  if (
    normalized === "permission-cleared" ||
    normalized === ReleaseMode.PermissionCleared
  ) {
    return ReleaseMode.PermissionCleared;
  }
  throw new Error(
    `Invalid release mode: "${mode}". Must be "safe" or "permission-cleared".`
  );
}

/**
 * Check whether the current release mode allows binary artifact publishing.
 * Only permission-cleared mode permits this.
 */
export function canPublishBinaries(releaseMode: ReleaseMode): boolean {
  return releaseMode === ReleaseMode.PermissionCleared;
}

/**
 * Ensure generated directories exist.
 */
export function ensureGeneratedDirs(dirs: Record<GeneratedDir, string>): void {
  for (const dirPath of Object.values(dirs)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
