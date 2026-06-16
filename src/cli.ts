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
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action((options) => {
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
    "--version <version>",
    "Factory Desktop version (auto-detected from DMG if omitted)"
  )
  .option(
    "--release-mode <mode>",
    "Release mode: safe (default) or permission-cleared",
    DEFAULT_RELEASE_MODE
  )
  .action((options) => {
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

    const version = options.version || validation.version;
    process.stdout.write(
      `✓ Valid Factory Desktop DMG: ${options.dmg}\n` +
        `  Version: ${version || "unknown"}\n`
    );

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

program.parse();
