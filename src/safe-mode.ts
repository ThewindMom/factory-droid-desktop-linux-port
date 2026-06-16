/**
 * Safe mode: enforces source-only release behavior by default.
 * Refuses to publish proprietary-derived binary artifacts unless
 * explicit permission-cleared mode is enabled.
 *
 * Fulfills: VAL-PACKAGE-011
 */

import {
  ReleaseMode,
  canPublishBinaries,
} from "./config";

/** Binary artifact types that safe mode refuses to publish */
const BINARY_ARTIFACT_TYPES = [
  ".deb",
  ".AppImage",
  ".rpm",
  ".asar",
  ".dmg",
  ".exe",
  "droid", // downloaded CLI binary
];

/** Result of a publish attempt */
export interface PublishResult {
  allowed: boolean;
  reason?: string;
  artifactType?: string;
}

/**
 * Check whether a specific artifact can be published under the current
 * release mode.
 *
 * In safe mode, ALL binary artifacts and update metadata that implies
 * binary availability are refused.
 */
export function checkPublishAllowed(
  artifactPath: string,
  releaseMode: ReleaseMode
): PublishResult {
  if (canPublishBinaries(releaseMode)) {
    return { allowed: true };
  }

  // Safe mode: check if the artifact is a binary type
  const basename = artifactPath.split("/").pop() || "";
  const ext = basename.includes(".") ? "." + basename.split(".").pop() : "";

  const isBinary = BINARY_ARTIFACT_TYPES.some(
    (type) => basename === type || ext === type
  );

  // Also check for update metadata that implies binary availability
  const isUpdateMetadata =
    basename.includes("latest-linux") ||
    basename.includes("latest-mac") ||
    basename.includes("latest.yml") ||
    basename.endsWith(".yml") && basename.includes("latest");

  if (isBinary) {
    return {
      allowed: false,
      reason: `Safe mode refuses publishing binary artifact: ${basename}. ` +
        `Set release mode to "permission-cleared" to enable binary publishing.`,
      artifactType: ext || basename,
    };
  }

  if (isUpdateMetadata) {
    return {
      allowed: false,
      reason: `Safe mode refuses publishing update metadata that implies binary artifact availability: ${basename}. ` +
        `Set release mode to "permission-cleared" to enable update metadata publishing.`,
      artifactType: "update-metadata",
    };
  }

  return { allowed: true };
}

/**
 * Enforce safe mode for a publish/release command.
 * Throws an error if the release mode does not permit publishing.
 */
export function enforceSafeMode(
  artifactPaths: string[],
  releaseMode: ReleaseMode
): void {
  if (canPublishBinaries(releaseMode)) {
    return;
  }

  const violations: string[] = [];

  for (const artifactPath of artifactPaths) {
    const result = checkPublishAllowed(artifactPath, releaseMode);
    if (!result.allowed) {
      violations.push(result.reason || artifactPath);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Publish refused in safe mode (default). The following issues must be resolved:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\n\nTo publish binary artifacts, set --release-mode=permission-cleared.`
    );
  }
}

/**
 * Get a human-readable description of the current release mode.
 */
export function describeReleaseMode(releaseMode: ReleaseMode): string {
  if (releaseMode === ReleaseMode.Safe) {
    return (
      "Safe/source-only mode (default): Binary artifact publishing is refused. " +
      "Users must supply official DMGs locally and build from source."
    );
  }
  return (
    "Permission-cleared mode: Binary artifacts (.deb, AppImage) and update " +
    "metadata may be published through GitHub Releases."
  );
}
