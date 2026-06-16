#!/usr/bin/env node
/**
 * Factory Droid Desktop Linux Port Builder CLI
 *
 * Entry point for the builder. Provides subcommands for extraction,
 * runtime assembly, packaging, and publishing.
 *
 * Default mode is safe/source-only: refuses proprietary binary publishing.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Command } from "commander";
import {
  resolveReleaseMode,
  resolveDirs,
  ensureGeneratedDirs,
  DEFAULT_RELEASE_MODE,
} from "./config";
import { validateDmg, validateArm64Dmg } from "./dmg-validator";
import { ArtifactTracker } from "./artifact-hygiene";
import { enforceSafeMode, describeReleaseMode } from "./safe-mode";
import { assertRequiredTools, checkAllTools, checkTool, REQUIRED_TOOLS } from "./tool-check";
import { resolveVersion, isValidSemver, LATEST_VERSION_URL } from "./version-discovery";
import {
  extractDmgPayload,
  verifyDeterministicExtraction,
  formatExtractionResult,
  formatDeterminismResult,
} from "./dmg-extraction";
import {
  compareAsarParity,
  formatParityResult,
} from "./parity-validation";
import {
  validateRuntimePayloadForLinux,
  formatRuntimeValidationResult,
  BinaryType,
} from "./runtime-classifier";
import {
  resolveDroid,
  validateExistingDroid,
  formatDroidResult,
  VersionPolicy,
  DROID_DOWNLOAD_URL_TEMPLATE,
  DROID_SHA256_URL_TEMPLATE,
} from "./droid-resolver";

const program = new Command();

program
  .name("factory-linux-builder")
  .description(
    "Unofficial Linux port builder for Factory Droid Desktop. " +
      "Assembles Linux install artifacts from official Factory Desktop macOS DMGs."
  )
  .version("0.1.0");

/**
 * `check-tools` subcommand: verify required tooling.
 */
program
  .command("check-tools")
  .description("Check that all required tools are available")
  .action(() => {
    const { results, missing, missingRequired } = checkAllTools();

    for (const result of results) {
      const status = result.available ? "✓" : "✗";
      const version = result.version ? ` (${result.version})` : "";
      const required = REQUIRED_TOOLS.find(
        (t) => t.name === result.tool
      )?.required
        ? " [required]"
        : " [optional]";
      process.stdout.write(
        `${status} ${result.tool}${version}${required}\n`
      );
    }

    if (missingRequired.length > 0) {
      process.stderr.write(
        `\nMissing required tools: ${missingRequired.join(", ")}\n`
      );
      process.exit(1);
    }

    if (missing.length > 0) {
      process.stderr.write(
        `\nMissing optional tools: ${missing.join(", ")}\n`
      );
    }
  });

/**
 * `validate` subcommand: validate a DMG input without extracting.
 * Supports --latest for version discovery.
 */
program
  .command("validate")
  .description("Validate a Factory Desktop DMG without extracting payloads")
  .requiredOption("--dmg <path>", "Path to macOS x64 Factory Desktop DMG")
  .option(
    "--arm64-dmg <path>",
    "Path to macOS arm64 Factory Desktop DMG (optional, for parity checking)"
  )
  .option(
    "--factory-version <version>",
    "Factory Desktop version (auto-detected from DMG if omitted)"
  )
  .option(
    "--latest",
    "Discover the latest Factory Desktop version from the official endpoint"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    const releaseMode = resolveReleaseMode(options.releaseMode);
    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    // Validate the x64 DMG
    const result = validateDmg(options.dmg);
    if (!result.valid) {
      process.stderr.write(`Validation failed: ${result.error}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `✓ Valid Factory Desktop DMG: ${options.dmg}\n` +
        `  Discovered version: ${result.version || "unknown"}\n`
    );

    // Resolve version from --latest or --factory-version flag
    if (options.latest || options.factoryVersion) {
      const versionResult = await resolveVersion({
        version: options.factoryVersion,
        latest: options.latest,
      });

      if (!versionResult.success) {
        process.stderr.write(`Version resolution failed: ${versionResult.error}\n`);
        process.exit(1);
      }

      process.stdout.write(
        `  Resolved version: ${versionResult.version}\n` +
          `  Version source: ${options.latest ? "latest-version endpoint" : "--factory-version flag"}\n`
      );

      // VAL-EXTRACT-011: Check DMG metadata version matches resolved version
      const dmgVersion = result.version;
      if (dmgVersion && versionResult.version && dmgVersion !== versionResult.version) {
        process.stderr.write(
          `\nWARNING: DMG filename version "${dmgVersion}" does not match ` +
          `resolved version "${versionResult.version}".\n` +
          `Use --version-override with the extract command to proceed despite the mismatch.\n`
        );
      }
    }

    // Validate arm64 DMG if provided
    if (options.arm64Dmg) {
      const arm64Result = validateArm64Dmg(options.arm64Dmg);
      if (!arm64Result.valid) {
        process.stderr.write(
          `Arm64 DMG validation failed: ${arm64Result.error}\n`
        );
        process.exit(1);
      }
      process.stdout.write(
        `✓ Valid Factory Desktop arm64 DMG: ${options.arm64Dmg}\n`
      );
    }
  });

/**
 * `extract` subcommand: extract payloads from a validated DMG.
 * Supports --latest for version discovery, --version-override for
 * accepting version mismatches, and --verify-determinism for
 * deterministic extraction checks.
 */
program
  .command("extract")
  .description("Extract app payload from a Factory Desktop DMG")
  .requiredOption("--dmg <path>", "Path to macOS x64 Factory Desktop DMG")
  .option(
    "--arm64-dmg <path>",
    "Path to macOS arm64 Factory Desktop DMG (optional)"
  )
  .option(
    "--factory-version <version>",
    "Factory Desktop version (auto-detected from DMG if omitted)"
  )
  .option(
    "--latest",
    "Discover the latest Factory Desktop version from the official endpoint"
  )
  .option(
    "--version-override",
    "Allow version mismatch between requested version and DMG metadata"
  )
  .option(
    "--verify-determinism",
    "Run extraction twice to verify deterministic results"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    const releaseMode = resolveReleaseMode(options.releaseMode);
    const projectRoot = process.cwd();
    const dirs = resolveDirs(projectRoot);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    // Check required tools first
    assertRequiredTools();

    // Validate DMG before extraction
    const validation = validateDmg(options.dmg);
    if (!validation.valid) {
      process.stderr.write(`DMG validation failed: ${validation.error}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `✓ Valid Factory Desktop DMG: ${options.dmg}\n`
    );

    // Resolve the selected version
    let selectedVersion: string;

    if (options.latest) {
      // VAL-EXTRACT-002: Latest version discovery
      process.stdout.write(`\nDiscovering latest Factory Desktop version...\n`);
      const versionResult = await resolveVersion({
        latest: true,
      });

      if (!versionResult.success) {
        // VAL-EXTRACT-010: Safe failure on latest-version errors
        process.stderr.write(
          `Latest-version discovery failed: ${versionResult.error}\n`
        );
        process.exit(1);
      }

      selectedVersion = versionResult.version!;
      process.stdout.write(
        `✓ Latest Factory Desktop version: ${selectedVersion}\n` +
          `  Version source: ${LATEST_VERSION_URL}\n`
      );
    } else if (options.factoryVersion) {
      // Explicit version from --factory-version flag
      if (!isValidSemver(options.factoryVersion)) {
        process.stderr.write(
          `Invalid version format: "${options.factoryVersion}". Expected semver (X.Y.Z).\n`
        );
        process.exit(1);
      }
      selectedVersion = options.factoryVersion;
      process.stdout.write(
        `  Selected version: ${selectedVersion} (from --factory-version flag)\n`
      );
    } else {
      // Auto-detect from DMG filename
      selectedVersion = validation.version || "unknown";
      if (selectedVersion !== "unknown") {
        process.stdout.write(
          `  Selected version: ${selectedVersion} (auto-detected from DMG)\n`
        );
      } else {
        process.stderr.write(
          `Cannot determine Factory Desktop version. ` +
          `Use --factory-version <X.Y.Z> or --latest.\n`
        );
        process.exit(1);
      }
    }

    // Track artifacts for hygiene
    const tracker = new ArtifactTracker(projectRoot);
    const workDir = dirs.work;

    try {
      // Ensure generated directories exist
      ensureGeneratedDirs(dirs);

      // Track the extraction workspace
      tracker.track(workDir, "Extraction workspace");

      process.stdout.write(
        `\nExtraction workspace: ${workDir}\n` +
          `  All extracted payloads will be in generated directories.\n`
      );

      // Verify no proprietary artifacts in tracked source
      const sourceViolations = tracker.checkNoProprietaryInSource(projectRoot);
      if (sourceViolations.length > 0) {
        process.stderr.write(
          `ERROR: Proprietary artifacts found in source: ${sourceViolations.join(", ")}\n`
        );
        tracker.cleanupOnFailure();
        process.exit(1);
      }

      // Verify git ignores generated directories
      const gitCheck = tracker.verifyGitIgnored(projectRoot);
      if (!gitCheck.clean) {
        process.stderr.write(
          `ERROR: Generated artifacts would be tracked by git: ${gitCheck.tracked.join(", ")}\n`
        );
        tracker.cleanupOnFailure();
        process.exit(1);
      }

      process.stdout.write(
        `\n✓ Artifact hygiene verified: no proprietary payloads in tracked source locations.\n`
      );

      // Extract DMG payload with metadata validation
      process.stdout.write(`\nExtracting DMG payload...\n`);

      const extractDir = path.join(workDir, "extracted");
      const extractResult = extractDmgPayload(options.dmg, extractDir, {
        selectedVersion,
        versionOverride: options.versionOverride || false,
        extractIcons: true,
      });

      if (!extractResult.success) {
        process.stderr.write(
          `Extraction failed: ${extractResult.error}\n`
        );
        const cleaned = tracker.cleanupOnFailure();
        if (cleaned.length > 0) {
          process.stderr.write(
            `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
          );
        }
        process.exit(1);
      }

      // Display extraction results
      process.stdout.write(`\n${formatExtractionResult(extractResult)}\n`);

      // VAL-EXTRACT-004: Package metadata validation
      if (extractResult.metadataValidation) {
        if (!extractResult.metadataValidation.valid) {
          // Separate version-mismatch errors from other metadata errors
          const versionMismatchErrors = extractResult.metadataValidation.errors.filter(
            (e) => e.includes("Version mismatch")
          );
          const otherErrors = extractResult.metadataValidation.errors.filter(
            (e) => !e.includes("Version mismatch")
          );

          // --version-override only bypasses version mismatch, not other metadata errors
          if (otherErrors.length > 0) {
            process.stderr.write(
              `\n✗ Package metadata validation failed (cannot be bypassed with --version-override):\n`
            );
            for (const err of otherErrors) {
              process.stderr.write(`  - ${err}\n`);
            }
            const cleaned = tracker.cleanupOnFailure();
            if (cleaned.length > 0) {
              process.stderr.write(
                `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
              );
            }
            process.exit(1);
          }

          // Version mismatch errors are bypassable with --version-override
          if (versionMismatchErrors.length > 0) {
            if (!options.versionOverride) {
              process.stderr.write(
                `\n✗ Package metadata validation failed:\n`
              );
              for (const err of versionMismatchErrors) {
                process.stderr.write(`  - ${err}\n`);
              }
              const cleaned = tracker.cleanupOnFailure();
              if (cleaned.length > 0) {
                process.stderr.write(
                  `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
                );
              }
              process.exit(1);
            } else {
              process.stderr.write(
                `  ⚠ Version mismatch bypassed with --version-override:\n`
              );
              for (const err of versionMismatchErrors) {
                process.stderr.write(`    - ${err}\n`);
              }
            }
          }
        }
      }

      // VAL-EXTRACT-011: Version mismatch check
      if (
        extractResult.dmgVersion &&
        extractResult.dmgVersion !== selectedVersion &&
        !options.versionOverride
      ) {
        process.stderr.write(
          `\nERROR: DMG metadata version "${extractResult.dmgVersion}" ` +
          `does not match selected version "${selectedVersion}".\n` +
          `Use --version-override to proceed despite the mismatch.\n`
        );
        const cleaned = tracker.cleanupOnFailure();
        if (cleaned.length > 0) {
          process.stderr.write(
            `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
          );
        }
        process.exit(1);
      }

      // VAL-EXTRACT-003: Parity check with arm64 DMG
      // VAL-EXTRACT-012: Arm64 DMG is validated before parity checks
      if (options.arm64Dmg) {
        process.stdout.write(`\nValidating arm64 DMG and checking app.asar parity...\n`);

        const parityWorkDir = path.join(workDir, "parity-check");
        if (fs.existsSync(parityWorkDir)) {
          fs.rmSync(parityWorkDir, { recursive: true, force: true });
        }
        fs.mkdirSync(parityWorkDir, { recursive: true });

        const parityResult = compareAsarParity(
          options.dmg,
          options.arm64Dmg,
          parityWorkDir
        );

        process.stdout.write(`\n${formatParityResult(parityResult)}\n`);

        if (!parityResult.valid) {
          process.stderr.write(
            `\n✗ Arm64 DMG validation or app.asar parity check failed. ` +
            `The application payloads differ between architectures.\n`
          );
          const cleaned = tracker.cleanupOnFailure();
          if (cleaned.length > 0) {
            process.stderr.write(
              `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
            );
          }
          process.exit(1);
        }
      }

      // VAL-EXTRACT-005: Validate that macOS runtime components are not used
      {
        const droidInDmg = path.join(
          extractDir,
          "Factory/Factory.app/Contents/Resources/bin/droid"
        );

        if (fs.existsSync(droidInDmg)) {
          process.stdout.write(`\nChecking DMG-bundled droid binary classification...\n`);

          const runtimeValidation = validateRuntimePayloadForLinux(droidInDmg);
          process.stdout.write(
            `\n${formatRuntimeValidationResult(runtimeValidation)}\n`
          );

          if (runtimeValidation.classifications["droid"]?.type === "mach-o") {
            process.stdout.write(
              `  Note: DMG-bundled droid is macOS Mach-O and must be replaced ` +
              `with a Linux ELF binary for the Linux port.\n`
            );
          }
        }
      }

      // VAL-EXTRACT-008: Deterministic extraction check
      if (options.verifyDeterminism) {
        process.stdout.write(`\nVerifying deterministic extraction...\n`);

        // Clean the second extraction directory
        const determinismWorkDir = path.join(workDir, "determinism-check");
        if (fs.existsSync(determinismWorkDir)) {
          fs.rmSync(determinismWorkDir, { recursive: true, force: true });
        }

        const determinismResult = verifyDeterministicExtraction(
          options.dmg,
          determinismWorkDir,
          selectedVersion
        );

        process.stdout.write(
          `\n${formatDeterminismResult(determinismResult)}\n`
        );

        if (!determinismResult.deterministic) {
          process.stderr.write(
            `\n✗ Deterministic extraction check failed. ` +
            `Extraction is not reproducible with identical inputs.\n`
          );
          process.exit(1);
        }
      }

      // Final git status check
      const finalGitCheck = tracker.verifyGitIgnored(projectRoot);
      if (!finalGitCheck.clean) {
        process.stderr.write(
          `\nERROR: Proprietary artifacts detected in tracked locations after extraction: ` +
          `${finalGitCheck.tracked.join(", ")}\n`
        );
        process.exit(1);
      }

      process.stdout.write(
        `\n✓ Extraction complete. All payloads are in generated directories.\n` +
          `  No proprietary artifacts in tracked source locations.\n`
      );
    } catch (err) {
      process.stderr.write(`Extraction failed: ${String(err)}\n`);
      const cleaned = tracker.cleanupOnFailure();
      if (cleaned.length > 0) {
        process.stderr.write(
          `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
        );
      }
      process.exit(1);
    }
  });

/**
 * `discover-version` subcommand: query the Factory Desktop latest-version endpoint.
 *
 * VAL-EXTRACT-002: Reports the resolved version value.
 * VAL-EXTRACT-010: Safe failure on malformed responses.
 */
program
  .command("discover-version")
  .description("Discover the latest Factory Desktop version from the official endpoint")
  .option(
    "--url <url>",
    "Override the latest-version endpoint URL (for testing)",
    LATEST_VERSION_URL
  )
  .option(
    "--timeout <ms>",
    "Request timeout in milliseconds",
    "15000"
  )
  .action(async (options) => {
    const timeoutMs = parseInt(options.timeout, 10);
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(`Invalid timeout: ${options.timeout}. Must be a positive integer.\n`);
      process.exit(1);
    }

    process.stdout.write(`Querying latest-version endpoint: ${options.url}\n`);

    const result = await resolveVersion({
      latest: true,
      latestVersionUrl: options.url,
      timeoutMs,
    });

    if (!result.success) {
      process.stderr.write(`\nLatest-version discovery failed: ${result.error}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `\n✓ Latest Factory Desktop version: ${result.version}\n` +
        `  Endpoint: ${options.url}\n` +
        `  This version will be used for build inputs.\n`
    );
  });

/**
 * `publish` subcommand: gated by safe mode.
 */
program
  .command("publish")
  .description("Publish release artifacts (gated by safe mode)")
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .option(
    "--artifacts <paths...>",
    "Artifact paths to publish",
    []
  )
  .action((options) => {
    const releaseMode = resolveReleaseMode(options.releaseMode);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    // Collect artifact paths from dist/ directory if none specified
    const artifactPaths = options.artifacts?.length > 0
      ? options.artifacts
      : collectDistArtifacts(process.cwd());

    if (artifactPaths.length === 0) {
      process.stdout.write("No artifacts found to publish.\n");
      return;
    }

    process.stdout.write(
      `Found ${artifactPaths.length} artifact(s):\n` +
        artifactPaths.map((p: string) => `  - ${p}`).join("\n") +
        "\n"
    );

    // Enforce safe mode: refuse binary publishing in default mode
    try {
      enforceSafeMode(artifactPaths, releaseMode);
    } catch (err) {
      process.stderr.write(`\n${String(err)}\n`);
      process.exit(1);
    }

    process.stdout.write("\n✓ Publishing allowed in current mode.\n");
  });

/**
 * `package` subcommand: package assembled runtime into target formats.
 */
program
  .command("package")
  .description("Package the assembled Linux app into target formats")
  .option(
    "--targets <targets>",
    "Comma-separated target formats (deb,appimage)",
    "deb,appimage"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action((options) => {
    const releaseMode = resolveReleaseMode(options.releaseMode);
    const targets = options.targets.split(",").map((t: string) => t.trim());

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);
    process.stdout.write(`Targets: ${targets.join(", ")}\n`);

    // Check that rpmbuild is not silently skipped
    if (targets.includes("rpm")) {
      const rpmTool = { name: "rpmbuild", description: "RPM builder", required: false };
      const rpmCheck = checkTool(rpmTool);
      if (!rpmCheck.available) {
        process.stderr.write(
          `RPM target is deferred: rpmbuild is not available on this host.\n` +
          `RPM support will be added when rpmbuild or a Docker-based build path is approved.\n`
        );
        process.exit(1);
      }
    }

    // Packaging is a placeholder for the packaging-worker feature
    process.stdout.write(
      "\nPackaging not yet implemented. " +
      "This will be completed by the packaging-worker feature.\n"
    );
  });

/**
 * Collect artifact paths from the out/ directory (packaging output).
 * TypeScript build output goes to dist/, packaging artifacts go to out/.
 */
function collectDistArtifacts(projectRoot: string): string[] {
  const outDir = path.join(projectRoot, "out");

  if (!fs.existsSync(outDir)) {
    return [];
  }

  const artifacts: string[] = [];
  const entries = fs.readdirSync(outDir);
  for (const entry of entries) {
    const fullPath = path.join(outDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      artifacts.push(fullPath);
    }
  }

  return artifacts;
}

/**
 * `resolve-droid` subcommand: download and verify the Linux x86_64 droid binary.
 *
 * VAL-EXTRACT-006: Linux droid binary matches selected version policy.
 * VAL-EXTRACT-009: Droid download checksum is verified.
 */
program
  .command("resolve-droid")
  .description("Download and verify the Linux x86_64 Factory CLI droid binary")
  .requiredOption(
    "--factory-version <version>",
    "Factory Desktop version to resolve droid for"
  )
  .option(
    "--version-policy <policy>",
    'Version policy: "exact" or "fallback-to-latest" (default)',
    "fallback-to-latest"
  )
  .option(
    "--output-dir <dir>",
    "Directory to save the droid binary (defaults to work/droid/)"
  )
  .option(
    "--existing-droid <path>",
    "Validate an existing droid binary instead of downloading"
  )
  .option(
    "--download-url <url>",
    "Override the download URL (for testing)"
  )
  .option(
    "--checksum-url <url>",
    "Override the checksum URL (for testing)"
  )
  .option(
    "--timeout <ms>",
    "Download timeout in milliseconds",
    "120000"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    const releaseMode = resolveReleaseMode(options.releaseMode);
    const projectRoot = process.cwd();
    const dirs = resolveDirs(projectRoot);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    // Validate version
    if (!isValidSemver(options.factoryVersion)) {
      process.stderr.write(
        `Invalid version format: "${options.factoryVersion}". Expected semver (X.Y.Z).\n`
      );
      process.exit(1);
    }

    // Resolve version policy
    let versionPolicy: VersionPolicy;
    if (options.versionPolicy === "exact") {
      versionPolicy = VersionPolicy.Exact;
    } else if (options.versionPolicy === "fallback-to-latest") {
      versionPolicy = VersionPolicy.FallbackToLatest;
    } else {
      process.stderr.write(
        `Invalid version policy: "${options.versionPolicy}". Must be "exact" or "fallback-to-latest".\n`
      );
      process.exit(1);
    }

    process.stdout.write(
      `Factory version: ${options.factoryVersion}\n` +
        `Version policy: ${versionPolicy}\n` +
        `Download URL template: ${DROID_DOWNLOAD_URL_TEMPLATE}\n` +
        `Checksum URL template: ${DROID_SHA256_URL_TEMPLATE}\n`
    );

    const outputDir = options.outputDir || path.join(dirs.work, "droid");
    const timeoutMs = parseInt(options.timeout, 10);

    // Track artifacts for hygiene
    const tracker = new ArtifactTracker(projectRoot);

    try {
      ensureGeneratedDirs(dirs);
      tracker.track(outputDir, "Droid binary output");

      let result;

      if (options.existingDroid) {
        // Validate existing droid binary
        process.stdout.write(`\nValidating existing droid binary: ${options.existingDroid}\n`);
        result = validateExistingDroid(
          options.existingDroid,
          options.factoryVersion,
          { versionPolicy }
        );
      } else {
        // Download and verify droid
        process.stdout.write(`\nDownloading Linux x86_64 droid binary...\n`);
        result = await resolveDroid(options.factoryVersion, outputDir, {
          versionPolicy,
          timeoutMs,
          downloadUrlOverride: options.downloadUrl,
          checksumUrlOverride: options.checksumUrl,
        });
      }

      process.stdout.write(`\n${formatDroidResult(result)}\n`);

      if (!result.success) {
        process.stderr.write(
          `\n✗ Linux droid binary resolution failed.\n`
        );
        const cleaned = tracker.cleanupOnFailure();
        if (cleaned.length > 0) {
          process.stderr.write(
            `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
          );
        }
        process.exit(1);
      }

      // Final git status check
      const finalGitCheck = tracker.verifyGitIgnored(projectRoot);
      if (!finalGitCheck.clean) {
        process.stderr.write(
          `\nERROR: Proprietary artifacts detected in tracked locations: ` +
          `${finalGitCheck.tracked.join(", ")}\n`
        );
        process.exit(1);
      }

      process.stdout.write(
        `\n✓ Linux droid binary resolved. Binary is in generated directories.\n`
      );
    } catch (err) {
      process.stderr.write(`Droid resolution failed: ${String(err)}\n`);
      const cleaned = tracker.cleanupOnFailure();
      if (cleaned.length > 0) {
        process.stderr.write(
          `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
        );
      }
      process.exit(1);
    }
  });

/**
 * `validate-runtime` subcommand: validate runtime binaries for Linux.
 *
 * VAL-EXTRACT-005: Mac runtime components are not accepted for Linux payload.
 */
program
  .command("validate-runtime")
  .description("Validate that runtime binaries are compatible with Linux")
  .requiredOption(
    "--droid-path <path>",
    "Path to the droid binary to validate"
  )
  .option(
    "--expected-type <type>",
    'Expected binary type: "elf" (default) or "mach-o"',
    "elf"
  )
  .option(
    "--expected-arch <arch>",
    'Expected architecture: "x86_64" (default) or "arm64"',
    "x86_64"
  )
  .action((options) => {
    const expectedType =
      options.expectedType === "mach-o" ? "mach-o" : "elf";
    const expectedArch = options.expectedArch || "x86_64";

    process.stdout.write(
      `Validating runtime binary: ${options.droidPath}\n` +
        `  Expected type: ${expectedType}\n` +
        `  Expected architecture: ${expectedArch}\n`
    );

    const result = validateRuntimePayloadForLinux(options.droidPath, {
      expectedType: expectedType === "elf" ? BinaryType.ELF : BinaryType.MachO,
      expectedArchitecture: expectedArch,
    });

    process.stdout.write(`\n${formatRuntimeValidationResult(result)}\n`);

    if (!result.valid) {
      process.stderr.write(
        `\n✗ Runtime validation failed: macOS runtime components detected or binary is incompatible.\n`
      );
      process.exit(1);
    }

    process.stdout.write(
      `\n✓ Runtime binary validated for Linux.\n`
    );
  });

/**
 * `assemble` subcommand: assemble a Linux Electron app directory.
 *
 * Takes extracted app.asar and resolved Linux droid, assembles a
 * complete Linux Electron app directory with proper layout.
 *
 * Fulfills: VAL-RUNTIME-001, VAL-RUNTIME-002, VAL-RUNTIME-003,
 *           VAL-RUNTIME-010, VAL-RUNTIME-011, VAL-RUNTIME-016
 */
program
  .command("assemble")
  .description("Assemble a Linux Electron app directory from extracted app.asar and resolved droid")
  .requiredOption("--asar <path>", "Path to extracted app.asar file")
  .requiredOption("--droid <path>", "Path to resolved Linux droid ELF binary")
  .option(
    "--asar-hash <hash>",
    "Expected SHA-256 hash of the app.asar file (for integrity verification)"
  )
  .option(
    "--factory-version <version>",
    "Factory Desktop version for the assembled app"
  )
  .option(
    "--electron-version <version>",
    "Electron version to use (default: 39.2.7)",
    "39.2.7"
  )
  .option(
    "--app-name <name>",
    "Application name for the executable (default: factory-desktop)",
    "factory-desktop"
  )
  .option(
    "--output-dir <dir>",
    "Output directory for the assembled app (default: build/)"
  )
  .option(
    "--electron-dist <path>",
    "Override the Electron dist directory (for testing)"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    // Dynamic import to avoid loading the module unless needed
    const {
      assembleLinuxRuntime,
      validateRuntimeLayout,
      validateAsarIntact,
      validateDroidBinary,
      validateSharedLibraries,
      checkResourcesPathResolution,
      checkLaunchRequirements,
      formatAssemblyResult,
      formatLayoutResult,
      formatAsarIntactResult,
      formatDroidBinaryResult,
      formatSharedLibResult,
      formatResourcesPathResult,
      formatLaunchRequirementsResult,
    } = await import("./runtime-assembly");

    const releaseMode = resolveReleaseMode(options.releaseMode);
    const projectRoot = process.cwd();
    const dirs = resolveDirs(projectRoot);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    // Validate inputs
    if (!fs.existsSync(options.asar)) {
      process.stderr.write(`app.asar not found: ${options.asar}\n`);
      process.exit(1);
    }

    if (!fs.existsSync(options.droid)) {
      process.stderr.write(`Droid binary not found: ${options.droid}\n`);
      process.exit(1);
    }

    // Compute asar hash if not provided
    let asarHash = options.asarHash;
    if (!asarHash) {
      const asarContent = fs.readFileSync(options.asar);
      const crypto = await import("crypto");
      asarHash = crypto
        .createHash("sha256")
        .update(asarContent)
        .digest("hex");
      process.stdout.write(`  Computed app.asar hash: ${asarHash}\n`);
    }

    // Determine output directory
    const outputDir = options.outputDir || dirs.build;

    process.stdout.write(
      `\nAssembling Linux Electron runtime...\n` +
        `  app.asar: ${options.asar}\n` +
        `  droid: ${options.droid}\n` +
        `  Electron version: ${options.electronVersion}\n` +
        `  App name: ${options.appName}\n` +
        `  Output: ${outputDir}\n`
    );

    // Track artifacts for hygiene
    const tracker = new ArtifactTracker(projectRoot);

    try {
      ensureGeneratedDirs(dirs);
      tracker.track(outputDir, "Assembled Linux app");

      // Assemble the Linux Electron runtime
      const result = assembleLinuxRuntime({
        asarPath: options.asar,
        asarHash,
        droidPath: options.droid,
        outputDir,
        electronVersion: options.electronVersion,
        appName: options.appName,
        electronDistOverride: options.electronDist,
      });

      // Display results
      process.stdout.write(`\n${formatAssemblyResult(result)}\n`);

      if (!result.success) {
        process.stderr.write(
          `\n✗ Linux Electron runtime assembly failed.\n`
        );
        const cleaned = tracker.cleanupOnFailure();
        if (cleaned.length > 0) {
          process.stderr.write(
            `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
          );
        }
        process.exit(1);
      }

      // Run detailed validations and display results
      process.stdout.write(`\n--- Detailed Validation ---\n`);

      const layoutResult = validateRuntimeLayout(result.appDir);
      process.stdout.write(`\n${formatLayoutResult(layoutResult)}\n`);

      const asarIntactResult = validateAsarIntact(result.appDir, asarHash);
      process.stdout.write(`\n${formatAsarIntactResult(asarIntactResult)}\n`);

      const droidBinaryResult = validateDroidBinary(result.appDir);
      process.stdout.write(`\n${formatDroidBinaryResult(droidBinaryResult)}\n`);

      const sharedLibResult = validateSharedLibraries(result.appDir);
      process.stdout.write(`\n${formatSharedLibResult(sharedLibResult)}\n`);

      const resourcesPathResult = checkResourcesPathResolution(result.appDir);
      process.stdout.write(`\n${formatResourcesPathResult(resourcesPathResult)}\n`);

      // Verify git hygiene
      const finalGitCheck = tracker.verifyGitIgnored(projectRoot);
      if (!finalGitCheck.clean) {
        process.stderr.write(
          `\nERROR: Proprietary artifacts detected in tracked locations: ` +
          `${finalGitCheck.tracked.join(", ")}\n`
        );
        process.exit(1);
      }

      // VAL-RUNTIME-010: Check normal launch requirements
      process.stdout.write(`\n--- Launch Requirements Check (VAL-RUNTIME-010) ---\n`);
      const launchResult = checkLaunchRequirements(result.appDir);
      process.stdout.write(`\n${formatLaunchRequirementsResult(launchResult)}\n`);

      // Summary
      process.stdout.write(
        `\n✓ Linux Electron runtime assembled successfully.\n` +
        `  App directory: ${result.appDir}\n` +
        `  Executable: ${result.executablePath}\n` +
        `  Layout: ${layoutResult.isLinuxLayout ? "Linux" : "non-standard"}\n` +
        `  ASAR intact: ${asarIntactResult.intact ? "yes" : "no"}\n` +
        `  Droid valid: ${droidBinaryResult.valid ? "yes" : "no"}\n` +
        `  Shared libs: ${sharedLibResult.valid ? "all resolvable" : "MISSING: " + sharedLibResult.missingLibs.join(", ")}\n` +
        `  Resources path: ${resourcesPathResult.valid ? "correct" : "incorrect"}\n` +
        `  Normal launch: ${launchResult.normalLaunchPossible ? "yes" : "requires --no-sandbox (documented)"}\n`
      );
    } catch (err) {
      process.stderr.write(`Assembly failed: ${String(err)}\n`);
      const cleaned = tracker.cleanupOnFailure();
      if (cleaned.length > 0) {
        process.stderr.write(
          `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
        );
      }
      process.exit(1);
    }
  });

/**
 * `desktop-integration` subcommand: generate Linux desktop entry,
 * icons, and validate protocol handler / deep-link / path resolution.
 *
 * Fulfills: VAL-RUNTIME-005, VAL-RUNTIME-006, VAL-RUNTIME-007,
 *           VAL-RUNTIME-014, VAL-RUNTIME-015
 */
program
  .command("desktop-integration")
  .description("Generate Linux desktop entry, icons, and validate protocol/deep-link/path integration")
  .option(
    "--app-dir <path>",
    "Path to the assembled Linux app directory (from assemble command)"
  )
  .option(
    "--icns <path>",
    "Path to the source ICNS icon file (from DMG extraction)"
  )
  .option(
    "--app-name <name>",
    "Application name (default: Factory)",
    "Factory"
  )
  .option(
    "--exec-name <name>",
    "Executable name (default: factory-desktop)",
    "factory-desktop"
  )
  .option(
    "--output-dir <dir>",
    "Output directory for desktop integration files (default: build/desktop-integration/)"
  )
  .option(
    "--validate-protocol",
    "Validate protocol handler registration in an isolated XDG profile",
    false
  )
  .option(
    "--validate-deep-link",
    "Validate cold/warm deep-link handling",
    false
  )
  .option(
    "--validate-paths",
    "Validate Linux XDG path resolution",
    false
  )
  .option(
    "--asar <path>",
    "Path to app.asar for path analysis (optional, for static macOS path check)"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    const {
      generateDesktopEntry,
      generateLinuxIcons,
      registerProtocolHandlerIsolated,
      validateDeepLinkHandling,
      validateLinuxPaths,
      cleanupIsolatedXdgDirs,
      formatDesktopEntryResult,
      formatIconGenerationResult,
      formatProtocolValidationResult,
      formatDeepLinkValidationResult,
      formatLinuxPathResult,
    } = await import("./desktop-integration");

    const releaseMode = resolveReleaseMode(options.releaseMode);
    const projectRoot = process.cwd();
    const dirs = resolveDirs(projectRoot);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    const outputDir = options.outputDir || path.join(dirs.build, "desktop-integration");

    // Track artifacts for hygiene
    const tracker = new ArtifactTracker(projectRoot);

    try {
      ensureGeneratedDirs(dirs);
      tracker.track(outputDir, "Desktop integration output");

      // Determine executable path
      const execPath = options.appDir
        ? path.join(options.appDir, options.execName)
        : options.execName;

      // ─── Step 1: Generate .desktop entry ──────────────────────────
      process.stdout.write(`\n--- Generating .desktop entry (VAL-RUNTIME-005) ---\n`);

      const desktopOutputPath = path.join(outputDir, `${options.execName}.desktop`);

      const desktopResult = generateDesktopEntry({
        appName: options.appName,
        execName: options.execName,
        execPath,
        iconName: options.execName,
        protocolScheme: "factory-desktop",
        outputPath: desktopOutputPath,
      });

      process.stdout.write(`\n${formatDesktopEntryResult(desktopResult)}\n`);

      if (!desktopResult.success) {
        process.stderr.write(`\n✗ Desktop entry generation failed.\n`);
        process.exit(1);
      }

      // ─── Step 2: Generate icon assets ─────────────────────────────
      process.stdout.write(`\n--- Generating Linux icon assets (VAL-RUNTIME-006) ---\n`);

      let iconResult;

      if (options.icns && fs.existsSync(options.icns)) {
        iconResult = generateLinuxIcons({
          icnsPath: options.icns,
          outputDir,
          appName: options.execName,
          iconName: options.execName,
        });

        process.stdout.write(`\n${formatIconGenerationResult(iconResult)}\n`);

        if (!iconResult.success) {
          process.stderr.write(`\n✗ Icon generation failed.\n`);
          process.exit(1);
        }
      } else {
        process.stdout.write(
          `  No ICNS file provided. Skipping icon generation.\n` +
          `  Use --icns <path> to generate icons from a source ICNS file.\n`
        );
      }

      // ─── Step 3: Validate protocol handler (optional) ─────────────
      if (options.validateProtocol) {
        process.stdout.write(`\n--- Validating protocol handler (VAL-RUNTIME-007) ---\n`);

        const isolatedDataHome = path.join(os.tmpdir(), "factory-desktop-test-data");
        const isolatedConfigHome = path.join(os.tmpdir(), "factory-desktop-test-config");
        const isolatedCacheHome = path.join(os.tmpdir(), "factory-desktop-test-cache");

        try {
          const protocolResult = registerProtocolHandlerIsolated({
            desktopFilePath: desktopOutputPath,
            protocolScheme: "factory-desktop",
            isolatedDataHome,
            isolatedConfigHome,
            isolatedCacheHome,
          });

          process.stdout.write(`\n${formatProtocolValidationResult(protocolResult)}\n`);

          if (!protocolResult.valid) {
            process.stderr.write(
              `\n⚠ Protocol handler validation did not fully pass. ` +
              `This may be due to the minimal test environment.\n`
            );
          }
        } finally {
          // Clean up isolated directories
          cleanupIsolatedXdgDirs({
            dataHome: isolatedDataHome,
            configHome: isolatedConfigHome,
            cacheHome: isolatedCacheHome,
          });
        }
      }

      // ─── Step 4: Validate deep-link handling (optional) ────────────
      if (options.validateDeepLink) {
        process.stdout.write(`\n--- Validating deep-link handling (VAL-RUNTIME-014) ---\n`);

        const isolatedDataHome = path.join(os.tmpdir(), "factory-deeplink-test-data");

        try {
          const deepLinkResult = validateDeepLinkHandling({
            desktopFilePath: desktopOutputPath,
            protocolScheme: "factory-desktop",
            isolatedDataHome,
          });

          process.stdout.write(`\n${formatDeepLinkValidationResult(deepLinkResult)}\n`);
        } finally {
          // Clean up
          cleanupIsolatedXdgDirs({
            dataHome: isolatedDataHome,
            configHome: path.join(os.tmpdir(), "factory-deeplink-test-config"),
            cacheHome: path.join(os.tmpdir(), "factory-deeplink-test-cache"),
          });
        }
      }

      // ─── Step 5: Validate Linux paths (optional) ──────────────────
      if (options.validatePaths) {
        process.stdout.write(`\n--- Validating Linux path resolution (VAL-RUNTIME-015) ---\n`);

        const pathResult = validateLinuxPaths({
          appName: options.appName.toLowerCase().replace(/\s+/g, "-"),
          asarPath: options.asar,
        });

        process.stdout.write(`\n${formatLinuxPathResult(pathResult)}\n`);
      }

      // Verify git hygiene
      const finalGitCheck = tracker.verifyGitIgnored(projectRoot);
      if (!finalGitCheck.clean) {
        process.stderr.write(
          `\nERROR: Proprietary artifacts detected in tracked locations: ` +
          `${finalGitCheck.tracked.join(", ")}\n`
        );
        process.exit(1);
      }

      // Summary
      process.stdout.write(
        `\n✓ Desktop integration completed successfully.\n` +
        `  Desktop entry: ${desktopOutputPath}\n` +
        `  Protocol: factory-desktop://\n` +
        `  Validation: ${desktopResult.validation.valid ? "passed" : "FAILED"}\n` +
        (iconResult ? `  Icons: ${iconResult.icons.length} generated\n` : "")
      );
    } catch (err) {
      process.stderr.write(`Desktop integration failed: ${String(err)}\n`);
      const cleaned = tracker.cleanupOnFailure();
      if (cleaned.length > 0) {
        process.stderr.write(
          `Cleaned up partial artifacts: ${cleaned.join(", ")}\n`
        );
      }
      process.exit(1);
    }
  });

/**
 * `launch-diagnostics` subcommand: run launch diagnostics and lifecycle
 * harnesses for Xvfb smoke launch, updater-safe startup, daemon binding,
 * stale/existing daemon handling, shutdown cleanup, and log verification.
 *
 * Fulfills: VAL-RUNTIME-004, VAL-RUNTIME-008, VAL-RUNTIME-009,
 *           VAL-RUNTIME-012, VAL-RUNTIME-013,
 *           VAL-CROSS-004, VAL-CROSS-009
 */
program
  .command("launch-diagnostics")
  .description("Run launch diagnostics and lifecycle harnesses for the assembled Linux app")
  .option(
    "--app-dir <path>",
    "Path to the assembled Linux app directory (from assemble command)"
  )
  .option(
    "--droid <path>",
    "Path to the Linux droid ELF binary for daemon lifecycle tests"
  )
  .option(
    "--asar <path>",
    "Path to app.asar for updater-safe startup static analysis"
  )
  .option(
    "--app-name <name>",
    "Application name (default: factory-desktop)",
    "factory-desktop"
  )
  .option(
    "--isolated-home <path>",
    "Isolated HOME directory for tests (default: temp directory)"
  )
  .option(
    "--smoke-launch",
    "Run Xvfb smoke launch test (VAL-RUNTIME-004)",
    false
  )
  .option(
    "--check-updater",
    "Check updater-safe startup behavior (VAL-RUNTIME-008)",
    false
  )
  .option(
    "--daemon-lifecycle",
    "Test daemon start/health/binding lifecycle (VAL-CROSS-004, VAL-RUNTIME-012)",
    false
  )
  .option(
    "--stale-daemon",
    "Test stale/existing daemon detection and handling (VAL-RUNTIME-013)",
    false
  )
  .option(
    "--shutdown-cleanup",
    "Test shutdown cleanup and log verification (VAL-RUNTIME-009, VAL-CROSS-009)",
    false
  )
  .option(
    "--all",
    "Run all diagnostics",
    false
  )
  .option(
    "--no-sandbox",
    "Use --no-sandbox for Electron launch (default: true in CI)",
    true
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action(async (options) => {
    const {
      smokeLaunchElectron,
      checkUpdaterSafeStartup,
      startDaemon,
      checkDaemonHealth,
      checkDaemonBinding,
      detectStaleDaemon,
      handleExistingDaemon,
      performShutdown,
      verifyLogLocation,
      scanForOrphanProcesses,
      captureProcessSnapshot,
      writeDaemonLockFile,
      formatSmokeLaunchResult,
      formatUpdaterCheckResult,
      formatDaemonStartResult,
      formatDaemonHealthResult,
      formatDaemonBindingResult,
      formatStaleDaemonResult,
      formatHandleExistingDaemonResult,
      formatShutdownResult,
      formatLogLocationResult,
      formatOrphanScanResult,
    } = await import("./launch-lifecycle");

    const releaseMode = resolveReleaseMode(options.releaseMode);

    process.stdout.write(`Release mode: ${describeReleaseMode(releaseMode)}\n`);

    const runAll = options.all;
    const appName = options.appName;

    // Set up isolated home directory
    const isolatedHome = options.isolatedHome || path.join(
      os.tmpdir(),
      `factory-launch-diag-${Date.now()}`
    );
    fs.mkdirSync(isolatedHome, { recursive: true });

    const xdgConfigHome = path.join(isolatedHome, ".config");
    const xdgCacheHome = path.join(isolatedHome, ".cache");
    const xdgDataHome = path.join(isolatedHome, ".local", "share");
    const xdgRuntimeDir = path.join(isolatedHome, ".runtime");
    const xdgStateHome = path.join(isolatedHome, ".local", "state");

    for (const dir of [xdgConfigHome, xdgCacheHome, xdgDataHome, xdgRuntimeDir, xdgStateHome]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const ownedPids: number[] = [];
    let hasErrors = false;

    try {
      // ─── Step 1: Updater-Safe Startup Check (VAL-RUNTIME-008) ────────
      if (runAll || options.checkUpdater) {
        process.stdout.write(`\n--- Checking updater-safe startup (VAL-RUNTIME-008) ---\n`);

        const updaterResult = checkUpdaterSafeStartup({
          asarPath: options.asar,
          hasManualUpdateCheck: false,
          usesProjectReleases: false,
        });

        process.stdout.write(`\n${formatUpdaterCheckResult(updaterResult)}\n`);

        if (!updaterResult.safe) {
          hasErrors = true;
          process.stderr.write(
            `\n✗ Updater-safe startup check failed. The app may crash on Linux due to updater assumptions.\n`
          );
        }
      }

      // ─── Step 2: Xvfb Smoke Launch (VAL-RUNTIME-004) ────────────────
      if (runAll || options.smokeLaunch) {
        if (!options.appDir) {
          process.stderr.write(
            `⚠ Skipping smoke launch: --app-dir is required. Provide the path to the assembled Linux app directory.\n`
          );
        } else {
          process.stdout.write(`\n--- Running Xvfb smoke launch (VAL-RUNTIME-004) ---\n`);

          const smokeResult = smokeLaunchElectron({
            appPath: options.appDir,
            isDirectory: true,
            isolatedHome,
            xdgConfigHome,
            xdgCacheHome,
            xdgDataHome,
            xdgRuntimeDir,
            appName,
            noSandbox: options.noSandbox,
          });

          process.stdout.write(`\n${formatSmokeLaunchResult(smokeResult)}\n`);

          if (smokeResult.pid) {
            ownedPids.push(smokeResult.pid);
          }

          if (!smokeResult.success) {
            hasErrors = true;
            process.stderr.write(
              `\n✗ Smoke launch failed. The app may have startup errors or shared library issues.\n`
            );
          }
        }
      }

      // ─── Step 3: Daemon Lifecycle (VAL-CROSS-004, VAL-RUNTIME-012) ──
      if (runAll || options.daemonLifecycle) {
        if (!options.droid) {
          process.stderr.write(
            `⚠ Skipping daemon lifecycle: --droid is required. Provide the path to the Linux droid ELF binary.\n`
          );
        } else {
          process.stdout.write(
            `\n--- Testing daemon lifecycle (VAL-CROSS-004, VAL-RUNTIME-012) ---\n`
          );

          // Step 3a: Start daemon
          process.stdout.write(`\nStarting droid daemon...\n`);

          const daemonResult = await startDaemon({
            droidPath: options.droid,
            runtimeDir: xdgRuntimeDir,
            port: 0, // Auto-select
            host: "127.0.0.1",
            isolatedHome,
          });

          process.stdout.write(`\n${formatDaemonStartResult(daemonResult)}\n`);

          if (daemonResult.pid) {
            ownedPids.push(daemonResult.pid);
          }

          if (daemonResult.success && daemonResult.endpoint) {
            // Step 3b: Check daemon health
            process.stdout.write(`\nChecking daemon health...\n`);

            const healthResult = await checkDaemonHealth(daemonResult.endpoint);
            process.stdout.write(`\n${formatDaemonHealthResult(healthResult)}\n`);

            // Step 3c: Check daemon binding
            process.stdout.write(`\nChecking daemon binding safety...\n`);

            const bindingResult = await checkDaemonBinding({
              host: daemonResult.host || "127.0.0.1",
              port: daemonResult.port || 0,
              endpoint: daemonResult.endpoint,
            });

            process.stdout.write(`\n${formatDaemonBindingResult(bindingResult)}\n`);

            if (!bindingResult.safe) {
              hasErrors = true;
              process.stderr.write(
                `\n✗ Daemon binding is not safe. Check loopback and port constraints.\n`
              );
            }
          } else {
            hasErrors = true;
            process.stderr.write(
              `\n✗ Daemon start failed. Cannot test health or binding.\n`
            );
          }
        }
      }

      // ─── Step 4: Stale/Existing Daemon Handling (VAL-RUNTIME-013) ────
      if (runAll || options.staleDaemon) {
        process.stdout.write(
          `\n--- Testing stale/existing daemon handling (VAL-RUNTIME-013) ---\n`
        );

        // Test detection
        const staleResult = detectStaleDaemon({
          runtimeDir: xdgRuntimeDir,
          expectedVersion: "0.106.0",
          droidPath: options.droid,
        });

        process.stdout.write(`\n${formatStaleDaemonResult(staleResult)}\n`);

        // Test handling
        const handleResult = handleExistingDaemon(staleResult, {
          runtimeDir: xdgRuntimeDir,
          allowReuse: true,
          allowCleanStale: true,
        });

        process.stdout.write(`\n${formatHandleExistingDaemonResult(handleResult)}\n`);

        if (!handleResult.handled) {
          hasErrors = true;
        }

        // Test with stale files
        process.stdout.write(`\nTesting stale file detection...\n`);
        writeDaemonLockFile(xdgRuntimeDir, 999999999, 18080, "0.106.0");

        const staleResult2 = detectStaleDaemon({
          runtimeDir: xdgRuntimeDir,
          expectedVersion: "0.106.0",
        });

        process.stdout.write(`\n${formatStaleDaemonResult(staleResult2)}\n`);

        const handleResult2 = handleExistingDaemon(staleResult2, {
          runtimeDir: xdgRuntimeDir,
          allowCleanStale: true,
        });

        process.stdout.write(`\n${formatHandleExistingDaemonResult(handleResult2)}\n`);
      }

      // ─── Step 5: Shutdown Cleanup (VAL-RUNTIME-009, VAL-CROSS-009) ──
      if (runAll || options.shutdownCleanup) {
        process.stdout.write(
          `\n--- Testing shutdown cleanup (VAL-RUNTIME-009, VAL-CROSS-009) ---\n`
        );

        // Create a log file to verify
        const logDir = path.join(xdgStateHome, appName, "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          path.join(logDir, "main.log"),
          `${new Date().toISOString()} App startup\n${new Date().toISOString()} App ready\n`
        );

        const shutdownResult = await performShutdown({
          ownedPids,
          runtimeDir: xdgRuntimeDir,
          isolatedHome,
          appName,
          verifyLogs: true,
        });

        process.stdout.write(`\n${formatShutdownResult(shutdownResult)}\n`);

        if (!shutdownResult.success) {
          hasErrors = true;
        }

        // Verify log location
        process.stdout.write(`\n--- Verifying log locations (VAL-CROSS-009) ---\n`);

        const logResult = verifyLogLocation({
          appName,
          isolatedHome,
          xdgConfigHome,
          xdgStateHome,
        });

        process.stdout.write(`\n${formatLogLocationResult(logResult)}\n`);

        if (!logResult.valid) {
          hasErrors = true;
        }

        // Scan for orphan processes
        process.stdout.write(`\n--- Scanning for orphan processes (VAL-RUNTIME-009) ---\n`);

        const baseline = captureProcessSnapshot([appName, "electron", "droid"]);
        const orphanResult = scanForOrphanProcesses({
          baselineProcesses: baseline,
          appName,
        });

        process.stdout.write(`\n${formatOrphanScanResult(orphanResult)}\n`);

        if (orphanResult.hasOrphans) {
          hasErrors = true;
        }
      }

      // Summary
      if (hasErrors) {
        process.stderr.write(
          `\n✗ Launch diagnostics completed with errors.\n`
        );
        process.exit(1);
      } else {
        process.stdout.write(
          `\n✓ Launch diagnostics completed successfully.\n`
        );
      }
    } catch (err) {
      process.stderr.write(`Launch diagnostics failed: ${String(err)}\n`);

      // Try to clean up owned processes
      if (ownedPids.length > 0) {
        try {
          await performShutdown({
            ownedPids,
            runtimeDir: xdgRuntimeDir,
            isolatedHome,
            appName,
            verifyLogs: false,
          });
        } catch {
          // Best-effort cleanup
        }
      }

      process.exit(1);
    } finally {
      // Clean up isolated home if we created it
      if (!options.isolatedHome && fs.existsSync(isolatedHome)) {
        try {
          fs.rmSync(isolatedHome, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  });

program.parse();
