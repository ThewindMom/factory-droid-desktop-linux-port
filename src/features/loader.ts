/**
 * Optional Linux feature descriptor loader.
 *
 * Mirrors the codex-desktop-linux `linux-features/` boundary: optional,
 * distro/workflow-specific integrations live as self-contained feature
 * directories and are disabled by default. The loader discovers them and
 * returns only the enabled ones.
 *
 * Design rule (ported from the reference):
 * - Required for the app to launch/behave correctly on Linux for most users
 *   -> core patch in src/patches/registry.ts.
 * - Optional / distro / workflow specific -> linux-features/<id>/, off by default.
 */

import * as fs from "fs";
import * as path from "path";

/** A feature.json manifest. */
export interface FeatureManifest {
  /** Stable feature identifier (kebab-case, must match the directory name). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Whether the feature is enabled. Default: false. */
  enabled?: boolean;
  /** Optional list of distro ids this feature targets (e.g. ["debian", "arch"]). */
  distros?: string[];
  /** Free-form notes for maintainers. */
  notes?: string;
}

/** A resolved feature descriptor (manifest + on-disk location). */
export interface FeatureDescriptor extends FeatureManifest {
  /** Absolute path to the feature directory. */
  dir: string;
  /** Absolute path to the feature README. */
  readmePath: string;
}

/** Default feature root, relative to the project root. */
export const DEFAULT_FEATURES_DIR = "linux-features";

/**
 * Load all feature descriptors under `featuresDir`.
 *
 * Each direct child directory must contain a `feature.json`. Directories
 * without one are skipped with a warning. Returns ALL descriptors; callers
 * filter by `enabled` as needed.
 */
export function loadAllFeatures(featuresDir: string): FeatureDescriptor[] {
  const descriptors: FeatureDescriptor[] = [];
  if (!fs.existsSync(featuresDir)) return descriptors;

  for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "local") continue; // user-local, gitignored

    const manifestPath = path.join(featuresDir, entry.name, "feature.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: FeatureManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }

    descriptors.push({
      ...manifest,
      id: manifest.id || entry.name,
      dir: path.join(featuresDir, entry.name),
      readmePath: path.join(featuresDir, entry.name, "README.md"),
    });
  }

  return descriptors;
}

/**
 * Load only enabled features (enabled === true). Disabled/absent flags are
 * treated as off — features must opt in explicitly.
 */
export function loadEnabledFeatures(featuresDir: string): FeatureDescriptor[] {
  return loadAllFeatures(featuresDir).filter((f) => f.enabled === true);
}

/**
 * Filter features by distro id. A feature with no `distros` array applies to
 * all distros; otherwise it must include the requested id.
 */
export function featuresForDistro(
  features: FeatureDescriptor[],
  distroId: string
): FeatureDescriptor[] {
  return features.filter(
    (f) => !f.distros || f.distros.length === 0 || f.distros.includes(distroId)
  );
}
