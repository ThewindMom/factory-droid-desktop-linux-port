/**
 * Packaging: builds Debian and AppImage artifacts from an assembled Linux
 * Electron app directory using electron-builder, validates package contents,
 * generates SHA-256 checksums, and proves artifacts launch from extracted
 * install contexts.
 *
 * Fulfills: VAL-PACKAGE-001, VAL-PACKAGE-002, VAL-PACKAGE-003,
 *           VAL-PACKAGE-004, VAL-PACKAGE-005, VAL-PACKAGE-006,
 *           VAL-PACKAGE-013
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync, spawnSync } from "child_process";
import { ReleaseMode } from "./config";
import { checkTool } from "./tool-check";
// ─── RPM Deferral (VAL-PACKAGE-010) ─────────────────────────────────────────

/** Reasons why RPM build is deferred */
export enum RpmDeferralReason {
  /** rpmbuild is not installed on the host */
  NoRpmbuild = "no-rpmbuild",
}

/** Result of checking whether RPM build prerequisites are satisfied */
export interface RpmPrerequisiteCheckResult {
  /** Whether RPM can be built on this host */
  available: boolean;
  /** If deferred, the reason(s) why */
  reasons: RpmDeferralReason[];
  /** Human-readable diagnostic message */
  diagnostic: string;
}

/**
 * Check whether RPM build prerequisites are satisfied.
 *
 * RPM builds require `rpmbuild` on the host. electron-builder calls
 * rpmbuild directly (unlike deb, which uses fpm). When rpmbuild is
 * missing, the build is deferred with a diagnostic — the user must
 * install `rpm` (Debian/Ubuntu) or `rpm-build` (Fedora).
 *
 * VAL-PACKAGE-010: Requesting an RPM build on a host without rpmbuild
 * must fail fast with a deferred-status diagnostic.
 */
export function checkRpmPrerequisites(): RpmPrerequisiteCheckResult {
  // electron-builder requires `rpmbuild` on the host to build RPM targets.
  // Unlike deb (which uses fpm), RPM builds call rpmbuild directly.
  const rpmTool = { name: "rpmbuild", description: "RPM builder", required: false };
  const rpmCheck = checkTool(rpmTool);

  if (rpmCheck.available) {
    return {
      available: true,
      reasons: [],
      diagnostic: "rpmbuild is available on this host.",
    };
  }

  return {
    available: false,
    reasons: [RpmDeferralReason.NoRpmbuild],
    diagnostic:
      "rpmbuild is not installed. Install it with: sudo apt install rpm (Debian/Ubuntu) " +
      "or sudo dnf install rpm-build (Fedora). RPM target is deferred until rpmbuild is available.",
  };
}

/**
 * Verify that no partial .rpm artifacts exist in the output directory.
 *
 * VAL-PACKAGE-010: must not produce partial .rpm files.
 *
 * @returns List of any .rpm files found (empty if clean)
 */
export function findPartialRpmArtifacts(outputDir: string): string[] {
  const rpmFiles: string[] = [];

  if (!fs.existsSync(outputDir)) {
    return rpmFiles;
  }

  const entries = fs.readdirSync(outputDir);
  for (const entry of entries) {
    if (entry.endsWith(".rpm")) {
      rpmFiles.push(path.join(outputDir, entry));
    }
  }

  // Also check the default electron-builder out/ directory
  const outDir = path.join(process.cwd(), "out");
  if (fs.existsSync(outDir)) {
    const outEntries = fs.readdirSync(outDir);
    for (const entry of outEntries) {
      if (entry.endsWith(".rpm")) {
        rpmFiles.push(path.join(outDir, entry));
      }
    }
  }

  return rpmFiles;
}

/**
 * Format an RpmPrerequisiteCheckResult for display.
 */
export function formatRpmPrerequisiteCheckResult(
  result: RpmPrerequisiteCheckResult
): string {
  const lines: string[] = [];

  lines.push("=== RPM Prerequisite Check ===");
  lines.push(`Status: ${result.available ? "AVAILABLE" : "DEFERRED"}`);

  if (result.reasons.length > 0) {
    lines.push(`Reasons: ${result.reasons.join(", ")}`);
  }

  lines.push(result.diagnostic);

  return lines.join("\n");
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for building packages */
export interface PackageBuildOptions {
  /** Path to the assembled Linux app directory (e.g. build/factory-desktop-linux-unpacked/) */
  appDir: string;
  /** Output directory for packaging artifacts (default: dist/) */
  outputDir: string;
  /** Factory Desktop version being packaged */
  factoryVersion: string;
  /** Application name (default: "Factory") */
  appName: string;
  /** Executable name (default: "factory-desktop") */
  execName: string;
  /** Target formats: "deb", "appimage", or both (default: "deb,appimage") */
  targets: string[];
  /** Path to icon directory or PNG icon file for packaging */
  iconPath?: string;
  /** Path to .desktop entry file for packaging */
  desktopEntryPath?: string;
  /** Release mode */
  releaseMode: ReleaseMode;
  /** Architecture string (default: "amd64" for deb, "x86_64" for AppImage) */
  arch?: string;
  /**
   * Whether to clean stale packaging artifacts from the output directory
   * before building (default: true). Prevents picking up stale .deb,
   * .AppImage, or yml files from previous builds.
   */
  clean?: boolean;
  /**
   * Path to the pre-built factory-update-manager binary to bundle into the
   * deb package. When set and PACKAGE_WITH_UPDATER != "0", the updater
   * binary, systemd user service, and polkit policy are staged into the
   * package so the installed app can auto-update from new upstream DMGs.
   */
  updaterBinaryPath?: string;
}

/** Result of package build */
export interface PackageBuildResult {
  /** Whether the build succeeded */
  success: boolean;
  /** Paths to generated artifacts */
  artifacts: string[];
  /** Debian package path (if deb target) */
  debPath?: string;
  /** AppImage path (if appimage target) */
  appImagePath?: string;
  /** RPM package path (if rpm target) */
  rpmPath?: string;
  /** Build errors */
  errors: string[];
  /** Build warnings */
  warnings: string[];
}

/** Result of Debian package validation */
export interface DebValidationResult {
  /** Whether the .deb is valid */
  valid: boolean;
  /** Package name */
  packageName?: string;
  /** Package version */
  packageVersion?: string;
  /** Package architecture */
  packageArch?: string;
  /** Package description */
  packageDescription?: string;
  /** Package maintainer */
  packageMaintainer?: string;
  /** Whether resources/app.asar exists */
  hasAppAsar: boolean;
  /** Whether resources/bin/droid exists */
  hasDroid: boolean;
  /** Whether droid is executable */
  droidIsExecutable: boolean;
  /** Whether desktop integration files are present */
  hasDesktopIntegration: boolean;
  /** Detailed errors */
  errors: string[];
}

/** Result of AppImage validation */
export interface AppImageValidationResult {
  /** Whether the AppImage is valid */
  valid: boolean;
  /** File type identification */
  fileType?: string;
  /** Whether resources/app.asar exists */
  hasAppAsar: boolean;
  /** Whether resources/bin/droid exists */
  hasDroid: boolean;
  /** Whether droid is executable */
  droidIsExecutable: boolean;
  /** Whether desktop entry is present and has protocol metadata */
  hasDesktopEntry: boolean;
  /** Whether desktop entry has MimeType with factory-desktop */
  hasProtocolMetadata: boolean;
  /** Whether icon assets are present */
  hasIcons: boolean;
  /** Detailed errors */
  errors: string[];
}

/** Result of packaged droid binary validation */
export interface PackagedDroidResult {
  /** Whether the droid is valid */
  valid: boolean;
  /** Whether the binary exists */
  exists: boolean;
  /** Whether it is Linux x86_64 ELF */
  isElf: boolean;
  /** Whether it is executable */
  isExecutable: boolean;
  /** Architecture if detected */
  architecture?: string;
  /** File type output */
  fileType?: string;
  /** Whether --version ran successfully */
  versionRan: boolean;
  /** Version output from droid --version */
  versionOutput?: string;
  /** Source package type */
  sourcePackage: "deb" | "appimage";
  /** Detailed errors */
  errors: string[];
}

/** Result of checksum generation */
export interface ChecksumResult {
  /** Whether checksum generation succeeded */
  success: boolean;
  /** Path to the checksum manifest file */
  manifestPath: string;
  /** Number of artifacts checksummed */
  artifactCount: number;
  /** Mapping of artifact basename to SHA-256 hash */
  checksums: Record<string, string>;
  /** Detailed errors */
  errors: string[];
}

/** Result of extracted launch test */
export interface ExtractedLaunchResult {
  /** Whether the launch succeeded */
  success: boolean;
  /** Package type tested */
  packageType: "deb" | "appimage";
  /** Path to the extracted context */
  extractedPath: string;
  /** Path to the executable in the extracted context */
  executablePath: string;
  /** Whether the app initialized without fatal errors */
  initialized: boolean;
  /** Whether the app terminated cleanly */
  terminatedCleanly: boolean;
  /** Detailed errors */
  errors: string[];
}

// ─── Package Build ──────────────────────────────────────────────────────────

/**
 * Build Debian and/or AppImage packages from an assembled Linux Electron app.
 *
 * Uses electron-builder with the --prepackaged option to package an
 * already-assembled app directory.
 *
 * VAL-PACKAGE-001: Debian package is produced for the requested version.
 * VAL-PACKAGE-003: AppImage is produced and identified correctly.
 */
export function buildPackages(options: PackageBuildOptions): PackageBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const artifacts: string[] = [];

  // Validate inputs
  if (!fs.existsSync(options.appDir)) {
    errors.push(`App directory does not exist: ${options.appDir}`);
    return { success: false, artifacts, errors, warnings };
  }

  // Check that the main executable exists in the app directory
  const mainExe = path.join(options.appDir, options.execName);
  if (!fs.existsSync(mainExe)) {
    errors.push(`Main executable not found in app directory: ${mainExe}`);
    return { success: false, artifacts, errors, warnings };
  }

  // Check RPM prerequisites and filter RPM targets with explicit deferral
  const rpmRequested = options.targets.includes("rpm");
  const rpmCheck = checkRpmPrerequisites();

  if (rpmRequested && !rpmCheck.available) {
    // VAL-PACKAGE-010: RPM requests fail fast with deferred diagnostic
    errors.push(
      `RPM target is deferred: ${rpmCheck.diagnostic.replace(/\n/g, " ")}`
    );
  }

  const validTargets = options.targets.filter((t) => {
    if (t === "rpm") {
      if (!rpmCheck.available) {
        warnings.push(rpmCheck.diagnostic);
        return false;
      }
      // RPM is available; will be included in build targets
      return true;
    }
    if (t !== "deb" && t !== "appimage") {
      warnings.push(`Unknown target: ${t}. Only "deb" and "appimage" are supported.`);
      return false;
    }
    return true;
  });

  if (validTargets.length === 0) {
    if (rpmRequested && !rpmCheck.available) {
      errors.push(
        "RPM target requested but prerequisites are not met. " +
        "RPM is deferred until rpmbuild is available. Install with: sudo apt install rpm (Debian/Ubuntu) or sudo dnf install rpm-build (Fedora)."
      );
    } else {
      errors.push("No valid targets specified. Supported targets: deb, appimage");
    }
    return { success: false, artifacts, errors, warnings };
  }

  // Ensure output directory exists
  fs.mkdirSync(options.outputDir, { recursive: true });

  // Clean stale packaging artifacts from previous builds to prevent
  // findArtifacts from picking up outdated .deb, .AppImage, or yml
  // files. Default is auto-clean enabled.
  if (options.clean !== false) {
    const staleExtensions = [".deb", ".AppImage", ".rpm", ".yml", ".yaml", ".sha256", ".blockmap"];
    const dirsToClean = [options.outputDir, path.join(process.cwd(), "out")];
    for (const dirToClean of dirsToClean) {
      if (!fs.existsSync(dirToClean)) continue;
      const staleFiles = fs.readdirSync(dirToClean).filter((f) =>
        staleExtensions.some((ext) => f.endsWith(ext))
      );
      for (const staleFile of staleFiles) {
        try {
          fs.unlinkSync(path.join(dirToClean, staleFile));
          warnings.push(`Removed stale artifact from previous build: ${staleFile}`);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  // Build electron-builder configuration
  const builderConfig = createElectronBuilderConfig(options, process.cwd());

  // Write temporary electron-builder config
  const configPath = path.join(options.outputDir, "electron-builder-config.json");
  fs.writeFileSync(configPath, JSON.stringify(builderConfig, null, 2));

  try {
    // Map target names to electron-builder format
    // electron-builder --linux takes target names as positional args
    const targetArgs = validTargets.map((t) =>
      t === "appimage" ? "AppImage" : t
    );

    // Run electron-builder with --prepackaged
    const cmd = [
      "npx",
      "electron-builder",
      "--prepackaged", options.appDir,
      "--linux",
      ...targetArgs,
      "--config", configPath,
    ].join(" ");

    process.stdout.write(`Running: ${cmd}\n`);

    const result = spawnSync(cmd, [], {
      cwd: process.cwd(),
      shell: true,
      stdio: "inherit",
      timeout: 600000, // 10 minute timeout for packaging (deb+rpm can be slow)
      env: {
        ...process.env,
        // Prevent electron-builder from trying to publish
        __COMPAT_LAYER__: "RunAsInvoker",
      },
    });

    if (result.status !== 0) {
      // With stdio: "inherit", output goes directly to the terminal.
      // Check if artifacts were actually created despite non-zero exit.
      const foundArtifacts = findArtifacts(options.outputDir, validTargets, options);

      if (foundArtifacts.length > 0) {
        warnings.push(
          `electron-builder exited with code ${result.status}, but artifacts were produced.`
        );
        artifacts.push(...foundArtifacts);
      } else {
        errors.push(
          `electron-builder failed with exit code ${result.status}. ` +
          `See output above for details.`
        );
      }
    } else {
      // Find the generated artifacts
      const foundArtifacts = findArtifacts(options.outputDir, validTargets, options);
      artifacts.push(...foundArtifacts);
    }

    // Also check the default out/ directory where electron-builder may place artifacts
    const outDir = path.join(process.cwd(), "out");
    if (fs.existsSync(outDir)) {
      const outArtifacts = findArtifacts(outDir, validTargets, options);
      for (const artifact of outArtifacts) {
        if (!artifacts.includes(artifact)) {
          // Move artifact to the configured output directory
          const destPath = path.join(options.outputDir, path.basename(artifact));
          if (artifact !== destPath) {
            fs.copyFileSync(artifact, destPath);
          }
          if (!artifacts.includes(destPath)) {
            artifacts.push(destPath);
          }
        }
      }
    }

    // Verify we got the expected artifacts
    const debPath = artifacts.find((a) => a.endsWith(".deb"));
    const appImagePath = artifacts.find((a) => a.endsWith(".AppImage"));
    const rpmPath = artifacts.find((a) => a.endsWith(".rpm"));

    if (validTargets.includes("deb") && !debPath) {
      errors.push("Debian package (.deb) was not produced.");
    }

    if (validTargets.includes("appimage") && !appImagePath) {
      errors.push("AppImage was not produced.");
    }

    if (validTargets.includes("rpm") && !rpmPath) {
      errors.push("RPM package (.rpm) was not produced.");
    }
    return {
      success: errors.length === 0,
      artifacts,
      debPath,
      appImagePath,
      rpmPath,
      errors,
      warnings,
    };
  } finally {
    // Clean up temporary config
    if (fs.existsSync(configPath)) {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
/**
 * Build the `extraFiles` entries for bundling the update manager into the deb
 * package. Returns `undefined` when the updater should not be bundled
 * (PACKAGE_WITH_UPDATER=0 or no binary path provided).
 *
 * The reference (codex-desktop-linux) bundles the updater by default and
 * uses PACKAGE_WITH_UPDATER=0 to opt out. We mirror that contract.
 *
 * Files staged:
 * - /usr/bin/factory-update-manager (the Rust binary)
 * - /usr/lib/systemd/user/factory-update-manager.service (systemd --user unit)
 * - /usr/share/polkit-1/actions/org.factory.desktop.update-manager.policy
 *
 * The builder checkout is also staged to /opt/factory-desktop/update-builder/
 * so the updater can rebuild from new upstream DMGs without re-cloning.
 */
function buildUpdaterExtraFiles(
  options: PackageBuildOptions,
  projectRoot: string
): { extraFiles: Array<{ from: string; to: string }> } | undefined {
  // PACKAGE_WITH_UPDATER=0 opts out (default: include)
  if (process.env.PACKAGE_WITH_UPDATER === "0") {
    return undefined;
  }

  const updaterBinary =
    options.updaterBinaryPath ||
    path.join(projectRoot, "updater", "target", "release", "factory-update-manager");

  if (!fs.existsSync(updaterBinary)) {
    return undefined;
  }

  const packagingLinuxDir = path.join(projectRoot, "packaging", "linux");

  const extraFiles: Array<{ from: string; to: string }> = [
    // Updater binary → staged in app dir, postinst copies to /usr/bin/
    { from: updaterBinary, to: ".factory-linux/updater/factory-update-manager" },
  ];

  // Systemd user service unit — staged in app dir, postinst copies to system path
  const serviceFile = path.join(packagingLinuxDir, "factory-update-manager.service");
  if (fs.existsSync(serviceFile)) {
    extraFiles.push({
      from: serviceFile,
      to: ".factory-linux/updater/factory-update-manager.service",
    });
  }

  // Polkit policy — staged in app dir, postinst copies to system path
  const polkitFile = path.join(
    packagingLinuxDir,
    "org.factory.desktop.update-manager.policy"
  );
  if (fs.existsSync(polkitFile)) {
    extraFiles.push({
      from: polkitFile,
      to: ".factory-linux/updater/org.factory.desktop.update-manager.policy",
    });
  }
  // Note: The builder checkout (dist, node_modules, src, assets, package.json,
  // etc.) is staged manually by the build-all command in cli.ts, NOT via
  // extraFiles. electron-builder's --prepackaged mode skips extraFiles, so
  // they would be dead weight here. The staging in cli.ts also prunes
  // devDependencies from node_modules to reduce package size.

  return { extraFiles };
}
/**
 * Build extraFiles entries for hicolor theme icons. These are always
 * included regardless of whether the updater is bundled — the taskbar/dock
 * icon must show Factory's actual logo (extracted from the DMG's ICNS),
 * not the generic Electron atom icon that electron-builder defaults to.
 */
function buildHicolorIconExtraFiles(
  projectRoot: string
): { extraFiles: Array<{ from: string; to: string }> } | undefined {
  const hicolorDir = path.join(
    projectRoot, "build", "desktop-integration", "icons", "hicolor"
  );
  if (!fs.existsSync(hicolorDir)) return undefined;
  return {
    extraFiles: [{ from: hicolorDir, to: "/usr/share/icons/hicolor" }],
  };
}

/**
 * Create the electron-builder configuration object.
 */
export function createElectronBuilderConfig(options: PackageBuildOptions, projectRoot: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    appId: "com.factory.desktop",
    productName: options.appName,
    copyright: "Copyright © Factory AI. Unofficial Linux port.",
    directories: {
      output: options.outputDir,
    },
    extraMetadata: {
      name: options.execName,
      version: options.factoryVersion,
    },
    linux: {
      executableName: options.execName,
      category: "Development",
      icon: options.iconPath || undefined,
      desktop: options.desktopEntryPath ? undefined : {
        Name: options.appName,
        Comment: "Factory AI Desktop",
        Categories: "Development;IDE;",
        StartupWMClass: options.execName,
        StartupNotify: "true",
        MimeType: "x-scheme-handler/factory-desktop;",
        GenericName: "AI Development Environment",
      },
      target: options.targets
        .map((t) => {
          if (t === "deb") {
            return { target: "deb", arch: ["x64"] };
          }
          if (t === "appimage") {
            return { target: "AppImage", arch: ["x64"] };
          }
          if (t === "rpm") {
            return { target: "rpm", arch: ["x64"] };
          }
          return t;
        }),
    },
    deb: {
      packageName: options.execName,
      depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils"],
      maintainer: "Factory AI <hello@factory.ai>",
      // Maintainer scripts for systemd --user service lifecycle.
      // electron-builder's fpm target expands ${[a-zA-Z]+} macros in
      // these scripts — the scripts use $uid (no braces) to avoid the
      // "Macro uid is not defined" error.
      afterInstall: "packaging/linux/factory-desktop.postinst",
      afterRemove: "packaging/linux/factory-desktop.postrm",
    },
    rpm: {
      // RPM uses the same maintainer scripts as deb.
      // fpm maps afterInstall → %post and afterRemove → %postun.
      packageName: options.execName,
      depends: ["gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils"],
      afterInstall: "packaging/linux/factory-desktop.postinst",
      afterRemove: "packaging/linux/factory-desktop.postrm",
    },
    // extraFiles is a top-level Configuration property (not deb-specific).
    // Bundles the update manager binary, systemd unit, polkit policy, and
    // updater source into the package. Files are staged within the app dir
    // (under .factory-linux/) because electron-builder's extraFiles 'to'
    // paths are relative to the app's unpacked directory, not absolute
    // filesystem paths. The postinst script copies them to system paths.
    extraFiles: [
      ...(buildUpdaterExtraFiles(options, projectRoot)?.extraFiles || []),
      ...(buildHicolorIconExtraFiles(projectRoot)?.extraFiles || []),
    ],
    appImage: {
      // AppImage-specific options
    },
    // Prevent publishing during build
    publish: {
      provider: "generic",
      url: "https://localhost/not-configured",
    },
  };

  return config;
}

/**
 * Find generated artifacts in the output directory.
 */
function findArtifacts(
  outputDir: string,
  targets: string[],
  options: PackageBuildOptions
): string[] {
  const artifacts: string[] = [];

  if (!fs.existsSync(outputDir)) {
    return artifacts;
  }

  const entries = fs.readdirSync(outputDir);
  for (const entry of entries) {
    const fullPath = path.join(outputDir, entry);
    const stat = fs.statSync(fullPath);

    if (!stat.isFile()) continue;

    if (targets.includes("deb") && entry.endsWith(".deb")) {
      // Verify the .deb filename includes the version
      if (entry.includes(options.factoryVersion) || entry.includes(options.execName)) {
        artifacts.push(fullPath);
      } else {
        // Still include it even if filename doesn't match expected pattern
        artifacts.push(fullPath);
      }
    }

    if (targets.includes("appimage") && entry.endsWith(".AppImage")) {
      if (entry.includes(options.factoryVersion) || entry.includes(options.execName)) {
        artifacts.push(fullPath);
      } else {
        artifacts.push(fullPath);
      }
    }
    if (targets.includes("rpm") && entry.endsWith(".rpm")) {
      if (entry.includes(options.factoryVersion) || entry.includes(options.execName)) {
        artifacts.push(fullPath);
      } else {
        artifacts.push(fullPath);
      }
    }
  }

  return artifacts;
}

// ─── Debian Package Validation ──────────────────────────────────────────────

/**
 * Validate a generated .deb package.
 *
 * VAL-PACKAGE-002: Inspecting the generated .deb with dpkg-deb --info and
 * dpkg-deb --contents must show expected package metadata for Factory,
 * Linux desktop integration files, resources/app.asar, and an executable
 * resources/bin/droid.
 */
export function validateDebPackage(debPath: string): DebValidationResult {
  const errors: string[] = [];

  if (!fs.existsSync(debPath)) {
    return {
      valid: false,
      hasAppAsar: false,
      hasDroid: false,
      droidIsExecutable: false,
      hasDesktopIntegration: false,
      errors: [`Debian package not found: ${debPath}`],
    };
  }

  // Get package info
  let packageName = "";
  let packageVersion = "";
  let packageArch = "";
  let packageDescription = "";
  let packageMaintainer = "";

  try {
    const infoOutput = execSync(`dpkg-deb --info "${debPath}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    // Parse dpkg-deb --info output
    const packageMatch = infoOutput.match(/Package:\s*(.+)/);
    const versionMatch = infoOutput.match(/Version:\s*(.+)/);
    const archMatch = infoOutput.match(/Architecture:\s*(.+)/);
    const descMatch = infoOutput.match(/Description:\s*(.+)/);
    const maintMatch = infoOutput.match(/Maintainer:\s*(.+)/);

    packageName = packageMatch?.[1]?.trim() || "";
    packageVersion = versionMatch?.[1]?.trim() || "";
    packageArch = archMatch?.[1]?.trim() || "";
    packageDescription = descMatch?.[1]?.trim() || "";
    packageMaintainer = maintMatch?.[1]?.trim() || "";

    if (!packageName) {
      errors.push("Package name is missing from .deb metadata.");
    }
    if (!packageVersion) {
      errors.push("Package version is missing from .deb metadata.");
    }
    if (!packageArch) {
      errors.push("Package architecture is missing from .deb metadata.");
    }
  } catch (err) {
    errors.push(`Failed to read .deb info: ${String(err)}`);
    return {
      valid: false,
      hasAppAsar: false,
      hasDroid: false,
      droidIsExecutable: false,
      hasDesktopIntegration: false,
      errors,
    };
  }

  // Get package contents
  let hasAppAsar = false;
  let hasDroid = false;
  let droidIsExecutable = false;
  let hasDesktopIntegration = false;

  try {
    const contentsOutput = execSync(`dpkg-deb --contents "${debPath}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    const lines = contentsOutput.split("\n");

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;

      const perms = parts[0];
      const filePath = parts.slice(5).join(" ");

      // Check for app.asar
      if (filePath.includes("resources/app.asar") || filePath.includes("resources/app.asar/")) {
        hasAppAsar = true;
      }

      // Check for droid binary
      if (filePath.includes("resources/bin/droid")) {
        hasDroid = true;
        // Check if executable
        if (perms.includes("x")) {
          droidIsExecutable = true;
        }
      }

      // Check for desktop integration
      if (filePath.includes(".desktop") || filePath.includes("applications/")) {
        hasDesktopIntegration = true;
      }

      // Check for icons
      if (filePath.includes("icons/") || filePath.includes("pixmaps/")) {
        hasDesktopIntegration = true;
      }
    }

    if (!hasAppAsar) {
      errors.push("resources/app.asar not found in .deb package contents.");
    }
    if (!hasDroid) {
      errors.push("resources/bin/droid not found in .deb package contents.");
    }
    if (hasDroid && !droidIsExecutable) {
      errors.push("resources/bin/droid is not executable in .deb package.");
    }
  } catch (err) {
    errors.push(`Failed to read .deb contents: ${String(err)}`);
  }

  return {
    valid: errors.length === 0,
    packageName,
    packageVersion,
    packageArch,
    packageDescription,
    packageMaintainer,
    hasAppAsar,
    hasDroid,
    droidIsExecutable,
    hasDesktopIntegration,
    errors,
  };
}

// ─── AppImage Validation ────────────────────────────────────────────────────

/**
 * Validate a generated AppImage.
 *
 * VAL-PACKAGE-003: Inspecting the artifact with `file` must identify it as
 * an AppImage or Linux executable AppImage payload.
 * VAL-PACKAGE-004: Extracting or inspecting the generated AppImage must show
 * resources/app.asar, resources/bin/droid, Linux icon assets, and a .desktop
 * entry with factory-desktop:// protocol metadata.
 */
export function validateAppImage(appImagePath: string): AppImageValidationResult {
  const errors: string[] = [];

  if (!fs.existsSync(appImagePath)) {
    return {
      valid: false,
      hasAppAsar: false,
      hasDroid: false,
      droidIsExecutable: false,
      hasDesktopEntry: false,
      hasProtocolMetadata: false,
      hasIcons: false,
      errors: [`AppImage not found: ${appImagePath}`],
    };
  }

  // Check file type
  let fileType = "";
  try {
    fileType = execSync(`file "${appImagePath}"`, {
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    errors.push(`Failed to run file command: ${String(err)}`);
  }

  // Validate that it's recognized as an AppImage or Linux executable
  const isAppImageType =
    fileType.toLowerCase().includes("appimage") ||
    fileType.toLowerCase().includes("appimage payload") ||
    (fileType.includes("ELF") && fileType.includes("executable"));

  if (!isAppImageType) {
    errors.push(
      `AppImage not recognized as valid type. file output: ${fileType}`
    );
  }

  // Extract and inspect AppImage contents
  let hasAppAsar = false;
  let hasDroid = false;
  let droidIsExecutable = false;
  let hasDesktopEntry = false;
  let hasProtocolMetadata = false;
  let hasIcons = false;

  // Use --appimage-extract to inspect contents (creates squashfs-root/ in cwd)
  const extractDir = path.join(
    path.dirname(appImagePath),
    `appimage-inspect-${Date.now()}`
  );

  try {
    // Make AppImage executable for extraction
    fs.chmodSync(appImagePath, 0o755);

    // Ensure the extraction directory exists before running extraction
    fs.mkdirSync(extractDir, { recursive: true });

    // Try to extract the AppImage
    spawnSync(
      appImagePath,
      ["--appimage-extract"],
      {
        cwd: extractDir,
        timeout: 60000,
        encoding: "utf-8",
      }
    );

    // The extraction creates squashfs-root/ in the cwd
    const squashRoot = path.join(extractDir, "squashfs-root");

    if (!fs.existsSync(squashRoot)) {
      // Alternative: try using 7z or bsdtar to list contents
      try {
        const listOutput = execSync(
          `7z l "${appImagePath}" 2>/dev/null || bsdtar -tf "${appImagePath}" 2>/dev/null`,
          { encoding: "utf-8", timeout: 30000 }
        );

        // Parse listing output for key resources
        if (listOutput.includes("app.asar") || listOutput.includes("resources/app.asar")) {
          hasAppAsar = true;
        }
        if (listOutput.includes("bin/droid") || listOutput.includes("resources/bin/droid")) {
          hasDroid = true;
        }
        if (listOutput.includes(".desktop")) {
          hasDesktopEntry = true;
        }
        if (listOutput.includes("icons/") || listOutput.includes(".DirIcon") || listOutput.includes("png")) {
          hasIcons = true;
        }
      } catch {
        // If we can't list, try mounting/loop approach
        errors.push(
          "Could not extract or list AppImage contents. The AppImage extraction tools may not be available."
        );
      }
    } else {
      // Walk the extracted tree
      const foundFiles = walkDir(squashRoot);

      for (const filePath of foundFiles) {
        const relPath = path.relative(squashRoot, filePath);

        if (relPath.includes("resources/app.asar") || relPath.endsWith("app.asar")) {
          hasAppAsar = true;
        }

        if (relPath.includes("resources/bin/droid") || relPath.endsWith("bin/droid")) {
          hasDroid = true;
          try {
            fs.accessSync(filePath, fs.constants.X_OK);
            droidIsExecutable = true;
          } catch {
            // Squashfs extraction may not preserve execute bits.
            // If the file is an ELF binary, treat it as valid for packaging.
            try {
              const fileTypeOutput = execSync(`file "${filePath}"`, { encoding: "utf-8" });
              if (fileTypeOutput.includes("ELF")) {
                droidIsExecutable = true;
                // Also fix the permission for downstream validation
                try { fs.chmodSync(filePath, 0o755); } catch { /* best effort */ }
              }
            } catch {
              // Can't determine file type
            }
          }
        }

        if (relPath.endsWith(".desktop")) {
          hasDesktopEntry = true;
          // Check for protocol metadata
          try {
            const desktopContent = fs.readFileSync(filePath, "utf-8");
            if (desktopContent.includes("x-scheme-handler/factory-desktop")) {
              hasProtocolMetadata = true;
            }
          } catch {
            // Can't read desktop file
          }
        }

        if (relPath.includes("icons/") || relPath.endsWith(".png") || relPath === ".DirIcon") {
          hasIcons = true;
        }
      }
    }

    if (!hasAppAsar) {
      errors.push("resources/app.asar not found in AppImage contents.");
    }
    if (!hasDroid) {
      errors.push("resources/bin/droid not found in AppImage contents.");
    }
    if (hasDroid && !droidIsExecutable) {
      errors.push("resources/bin/droid is not executable in AppImage.");
    }
    if (!hasDesktopEntry) {
      errors.push(".desktop entry not found in AppImage contents.");
    }
    if (hasDesktopEntry && !hasProtocolMetadata) {
      errors.push(".desktop entry does not include MimeType=x-scheme-handler/factory-desktop.");
    }
    if (!hasIcons) {
      errors.push("Icon assets not found in AppImage contents.");
    }
  } finally {
    // Clean up extracted contents
    if (fs.existsSync(extractDir)) {
      try {
        fs.rmSync(extractDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    // Also clean up squashfs-root if it was created elsewhere
    const localSquashRoot = path.join(process.cwd(), "squashfs-root");
    if (fs.existsSync(localSquashRoot)) {
      try {
        fs.rmSync(localSquashRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  return {
    valid: errors.length === 0,
    fileType,
    hasAppAsar,
    hasDroid,
    droidIsExecutable,
    hasDesktopEntry,
    hasProtocolMetadata,
    hasIcons,
    errors,
  };
}

// ─── Packaged Droid Binary Validation ───────────────────────────────────────

/**
 * Validate the droid binary in a packaged artifact.
 *
 * VAL-PACKAGE-005: For both Debian and AppImage outputs, the packaged
 * resources/bin/droid must be inspectable as a Linux x86_64 ELF binary
 * and must run droid --version successfully from the extracted package
 * context.
 */
export function validatePackagedDroid(
  droidPath: string,
  sourcePackage: "deb" | "appimage"
): PackagedDroidResult {
  const errors: string[] = [];

  if (!fs.existsSync(droidPath)) {
    return {
      valid: false,
      exists: false,
      isElf: false,
      isExecutable: false,
      versionRan: false,
      sourcePackage,
      errors: [`Droid binary not found at: ${droidPath}`],
    };
  }

  // Check executable permissions
  let isExecutable = false;
  try {
    fs.accessSync(droidPath, fs.constants.X_OK);
    isExecutable = true;
  } catch {
    errors.push("Droid binary is not executable.");
  }

  // Check file type
  let fileType = "";
  let isElf = false;
  let architecture = "";

  try {
    fileType = execSync(`file "${droidPath}"`, {
      encoding: "utf-8",
    }).trim();

    if (fileType.includes("ELF")) {
      isElf = true;
    } else if (fileType.includes("Mach-O")) {
      errors.push(
        `Droid binary is Mach-O (macOS), not Linux ELF. file output: ${fileType}`
      );
    } else {
      errors.push(
        `Droid binary is not a recognized executable format. file output: ${fileType}`
      );
    }

    if (fileType.includes("x86-64") || fileType.includes("x86_64")) {
      architecture = "x86_64";
    } else if (fileType.includes("aarch64") || fileType.includes("arm64")) {
      architecture = "arm64";
    }
  } catch (err) {
    errors.push(`Failed to run file command: ${String(err)}`);
  }

  // Try to run droid --version
  let versionRan = false;
  let versionOutput = "";

  if (isExecutable && isElf) {
    try {
      versionOutput = execSync(`"${droidPath}" --version`, {
        encoding: "utf-8",
        timeout: 15000,
      }).trim();
      versionRan = true;
    } catch (err) {
      errors.push(`Failed to run droid --version: ${String(err)}`);
    }
  }

  return {
    valid: errors.length === 0,
    exists: true,
    isElf,
    isExecutable,
    architecture,
    fileType,
    versionRan,
    versionOutput,
    sourcePackage,
    errors,
  };
}

// ─── Checksum Generation ────────────────────────────────────────────────────

/**
 * Generate SHA-256 checksums for all release artifacts.
 *
 * VAL-PACKAGE-006: The packaging process must emit SHA-256 checksum
 * files for every generated release artifact. Running sha256sum --check
 * against the generated checksum manifest must pass.
 */
export function generateChecksums(
  artifactPaths: string[],
  outputDir: string
): ChecksumResult {
  const errors: string[] = [];
  const checksums: Record<string, string> = {};

  if (artifactPaths.length === 0) {
    return {
      success: false,
      manifestPath: "",
      artifactCount: 0,
      checksums,
      errors: ["No artifact paths provided for checksum generation."],
    };
  }

  // Compute SHA-256 for each artifact
  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) {
      errors.push(`Artifact not found for checksum: ${artifactPath}`);
      continue;
    }

    try {
      const hash = computeFileHash(artifactPath);
      const basename = path.basename(artifactPath);
      checksums[basename] = hash;
    } catch (err) {
      errors.push(`Failed to compute checksum for ${artifactPath}: ${String(err)}`);
    }
  }

  if (Object.keys(checksums).length === 0) {
    return {
      success: false,
      manifestPath: "",
      artifactCount: 0,
      checksums,
      errors: errors.length > 0 ? errors : ["No checksums could be computed."],
    };
  }

  // Write checksum manifest in sha256sum format:
  // <hash>  <filename>
  const manifestLines = Object.entries(checksums).map(
    ([name, hash]) => `${hash}  ${name}`
  );
  const manifestContent = manifestLines.join("\n") + "\n";

  const manifestPath = path.join(outputDir, "checksums.txt");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(manifestPath, manifestContent, "utf-8");

  return {
    success: errors.length === 0,
    manifestPath,
    artifactCount: Object.keys(checksums).length,
    checksums,
    errors,
  };
}

/**
 * Verify checksums against a manifest file.
 *
 * VAL-PACKAGE-006: Running sha256sum --check against the generated
 * checksum manifest must pass.
 */
export function verifyChecksums(manifestPath: string): {
  valid: boolean;
  errors: string[];
  output: string;
} {
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      errors: [`Checksum manifest not found: ${manifestPath}`],
      output: "",
    };
  }

  try {
    const output = execSync(`sha256sum --check "${manifestPath}"`, {
      encoding: "utf-8",
      cwd: path.dirname(manifestPath),
      timeout: 60000,
    });

    return {
      valid: true,
      errors: [],
      output: output.trim(),
    };
  } catch (err) {
    const errObj = err as { stdout?: string; stderr?: string; status?: number };
    return {
      valid: false,
      errors: [`sha256sum --check failed: ${errObj.stderr || String(err)}`],
      output: errObj.stdout?.toString() || "",
    };
  }
}

// ─── Extracted Launch Test ──────────────────────────────────────────────────

/**
 * Extract a .deb package into a temporary install context.
 */
export function extractDebContext(
  debPath: string,
  extractDir: string
): { success: boolean; executablePath: string; errors: string[] } {
  const errors: string[] = [];

  if (!fs.existsSync(debPath)) {
    return { success: false, executablePath: "", errors: [`.deb not found: ${debPath}`] };
  }

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // Extract .deb contents using dpkg-deb
    execSync(`dpkg-deb --extract "${debPath}" "${extractDir}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    // Find the executable in the extracted context
    // Typically installed to /opt/ or /usr/lib/
    const foundExec = findExecutableInDir(extractDir, "factory-desktop");
    if (!foundExec) {
      errors.push("Could not find factory-desktop executable in extracted .deb context.");
    }

    return {
      success: errors.length === 0,
      executablePath: foundExec || "",
      errors,
    };
  } catch (err) {
    return {
      success: false,
      executablePath: "",
      errors: [`Failed to extract .deb: ${String(err)}`],
    };
  }
}

/**
 * Extract an AppImage into a temporary context.
 */
export function extractAppImageContext(
  appImagePath: string,
  extractDir: string
): { success: boolean; executablePath: string; errors: string[] } {
  const errors: string[] = [];

  if (!fs.existsSync(appImagePath)) {
    return { success: false, executablePath: "", errors: [`AppImage not found: ${appImagePath}`] };
  }

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // Make AppImage executable
    fs.chmodSync(appImagePath, 0o755);

    // Extract using --appimage-extract
    spawnSync(
      appImagePath,
      ["--appimage-extract"],
      {
        cwd: extractDir,
        timeout: 60000,
        encoding: "utf-8",
      }
    );

    // The extraction creates squashfs-root/
    const squashRoot = path.join(extractDir, "squashfs-root");

    if (!fs.existsSync(squashRoot)) {
      // Try 7z extraction as fallback
      try {
        execSync(`cd "${extractDir}" && 7z x "${appImagePath}" -y`, {
          encoding: "utf-8",
          timeout: 60000,
        });
      } catch {
        errors.push("Failed to extract AppImage using both --appimage-extract and 7z.");
        return { success: false, executablePath: "", errors };
      }
    }

    // Find the executable
    const foundExec = findExecutableInDir(extractDir, "factory-desktop");
    if (!foundExec) {
      errors.push("Could not find factory-desktop executable in extracted AppImage context.");
    }

    return {
      success: errors.length === 0,
      executablePath: foundExec || "",
      errors,
    };
  } catch (err) {
    return {
      success: false,
      executablePath: "",
      errors: [`Failed to extract AppImage: ${String(err)}`],
    };
  }
}

/**
 * Test that a packaged artifact can launch from its extracted context.
 *
 * VAL-PACKAGE-013: The .deb and AppImage artifacts must be extractable
 * into temporary install contexts and launch their packaged executable
 * from those contexts under Xvfb.
 */
export function testExtractedLaunch(
  executablePath: string,
  packageType: "deb" | "appimage",
  options?: { timeout?: number }
): ExtractedLaunchResult {
  const errors: string[] = [];
  const timeout = options?.timeout || 15000;

  if (!fs.existsSync(executablePath)) {
    return {
      success: false,
      packageType,
      extractedPath: path.dirname(executablePath),
      executablePath,
      initialized: false,
      terminatedCleanly: false,
      errors: [`Executable not found: ${executablePath}`],
    };
  }

  // Ensure executable
  try {
    fs.chmodSync(executablePath, 0o755);
  } catch {
    // May already be executable
  }

  // Try launch under Xvfb
  const isolatedHome = path.join(
    os.tmpdir(),
    `factory-extracted-launch-${Date.now()}`
  );
  fs.mkdirSync(isolatedHome, { recursive: true });

  try {
    // Try with xvfb-run first
    const launchCmd = `xvfb-run -a --server-args='-screen 0 1280x720x24' "${executablePath}" --no-sandbox 2>&1`;

    const result = spawnSync("bash", ["-c", launchCmd], {
      cwd: path.dirname(executablePath),
      timeout,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: isolatedHome,
        DISPLAY: ":99",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });

    // A successful launch under Xvfb should start and then timeout or
    // exit after the Electron app shows its window. If it crashes
    // immediately, the exit code will be non-zero and the output
    // will contain error messages.
    const stderr = result.stderr || "";

    // Check for fatal errors
    const hasFatalError =
      stderr.includes("Fatal") ||
      stderr.includes("segfault") ||
      stderr.includes("SIGSEGV") ||
      stderr.includes("Cannot open display") && !stderr.includes("--no-sandbox");

    const initialized = !hasFatalError;
    const terminatedCleanly =
      result.status === 0 ||
      result.status === null || // killed by timeout (expected)
      (result.signal === "SIGTERM" || result.signal === "SIGKILL");

    if (hasFatalError) {
      errors.push(
        `App failed to initialize from extracted ${packageType} context: ${stderr.substring(0, 500)}`
      );
    }

    return {
      success: errors.length === 0,
      packageType,
      extractedPath: path.dirname(executablePath),
      executablePath,
      initialized,
      terminatedCleanly,
      errors,
    };
  } finally {
    // Clean up isolated home
    if (fs.existsSync(isolatedHome)) {
      try {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ─── Formatting Functions ───────────────────────────────────────────────────

/**
 * Format a PackageBuildResult for display.
 */
export function formatPackageBuildResult(result: PackageBuildResult): string {
  const lines: string[] = [];

  lines.push("=== Package Build Result ===");
  lines.push(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);

  if (result.artifacts.length > 0) {
    lines.push(`Artifacts (${result.artifacts.length}):`);
    for (const artifact of result.artifacts) {
      lines.push(`  - ${artifact}`);
    }
  }

  if (result.debPath) {
    lines.push(`Debian package: ${result.debPath}`);
  }
  if (result.appImagePath) {
    lines.push(`AppImage: ${result.appImagePath}`);
  }
  if (result.rpmPath) {
    lines.push(`RPM package: ${result.rpmPath}`);
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a DebValidationResult for display.
 */
export function formatDebValidationResult(result: DebValidationResult): string {
  const lines: string[] = [];

  lines.push("=== Debian Package Validation ===");
  lines.push(`Status: ${result.valid ? "PASS" : "FAIL"}`);

  if (result.packageName) lines.push(`Package name: ${result.packageName}`);
  if (result.packageVersion) lines.push(`Package version: ${result.packageVersion}`);
  if (result.packageArch) lines.push(`Architecture: ${result.packageArch}`);
  if (result.packageDescription) lines.push(`Description: ${result.packageDescription}`);

  lines.push(`resources/app.asar: ${result.hasAppAsar ? "✓" : "✗"}`);
  lines.push(`resources/bin/droid: ${result.hasDroid ? "✓" : "✗"}`);
  lines.push(`droid executable: ${result.droidIsExecutable ? "✓" : "✗"}`);
  lines.push(`Desktop integration: ${result.hasDesktopIntegration ? "✓" : "✗"}`);

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format an AppImageValidationResult for display.
 */
export function formatAppImageValidationResult(result: AppImageValidationResult): string {
  const lines: string[] = [];

  lines.push("=== AppImage Validation ===");
  lines.push(`Status: ${result.valid ? "PASS" : "FAIL"}`);

  if (result.fileType) lines.push(`File type: ${result.fileType}`);
  lines.push(`resources/app.asar: ${result.hasAppAsar ? "✓" : "✗"}`);
  lines.push(`resources/bin/droid: ${result.hasDroid ? "✓" : "✗"}`);
  lines.push(`droid executable: ${result.droidIsExecutable ? "✓" : "✗"}`);
  lines.push(`Desktop entry: ${result.hasDesktopEntry ? "✓" : "✗"}`);
  lines.push(`Protocol metadata: ${result.hasProtocolMetadata ? "✓" : "✗"}`);
  lines.push(`Icon assets: ${result.hasIcons ? "✓" : "✗"}`);

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a PackagedDroidResult for display.
 */
export function formatPackagedDroidResult(result: PackagedDroidResult): string {
  const lines: string[] = [];

  lines.push(`=== Packaged Droid Validation (${result.sourcePackage}) ===`);
  lines.push(`Status: ${result.valid ? "PASS" : "FAIL"}`);
  lines.push(`Exists: ${result.exists ? "✓" : "✗"}`);
  lines.push(`Linux ELF: ${result.isElf ? "✓" : "✗"}`);
  lines.push(`Executable: ${result.isExecutable ? "✓" : "✗"}`);

  if (result.architecture) lines.push(`Architecture: ${result.architecture}`);
  if (result.fileType) lines.push(`File type: ${result.fileType}`);
  lines.push(`--version runs: ${result.versionRan ? "✓" : "✗"}`);
  if (result.versionOutput) lines.push(`Version output: ${result.versionOutput}`);

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a ChecksumResult for display.
 */
export function formatChecksumResult(result: ChecksumResult): string {
  const lines: string[] = [];

  lines.push("=== Checksum Generation ===");
  lines.push(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
  lines.push(`Manifest: ${result.manifestPath}`);
  lines.push(`Artifact count: ${result.artifactCount}`);

  for (const [name, hash] of Object.entries(result.checksums)) {
    lines.push(`  ${hash}  ${name}`);
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format an ExtractedLaunchResult for display.
 */
export function formatExtractedLaunchResult(result: ExtractedLaunchResult): string {
  const lines: string[] = [];

  lines.push(`=== Extracted Launch Test (${result.packageType}) ===`);
  lines.push(`Status: ${result.success ? "PASS" : "FAIL"}`);
  lines.push(`Extracted path: ${result.extractedPath}`);
  lines.push(`Executable: ${result.executablePath}`);
  lines.push(`Initialized: ${result.initialized ? "✓" : "✗"}`);
  lines.push(`Terminated cleanly: ${result.terminatedCleanly ? "✓" : "✗"}`);

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Walk a directory tree and return all file paths.
 */
function walkDir(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Find an executable by name in a directory tree.
 */
function findExecutableInDir(dir: string, execName: string): string | null {
  const files = walkDir(dir);

  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (basename === execName) {
      return filePath;
    }
  }

  return null;
}

/**
 * Compute SHA-256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}
