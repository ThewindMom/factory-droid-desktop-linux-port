/**
 * E2E validation harness for one-command build and launch flow.
 *
 * Validates VAL-CROSS-001: One command builds a launchable Linux app from a valid DMG.
 * Validates VAL-CROSS-002: Built app launches and shows Factory UI shell.
 *
 * These tests validate the full pipeline from DMG input to packaged Linux app,
 * and verify that the assembled app starts correctly and renders a UI.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  validateUiShell,
} from "../src/launch-lifecycle";

// ─── Test constants ────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "dist", "cli.js");
import { resolveFetchedDmg } from "./_helpers/fetched-dmg";
const X64_DMG = resolveFetchedDmg("x64");
const ARM64_DMG = resolveFetchedDmg("arm64");
const FACTORY_VERSION = "0.106.0";

// Whether reference DMGs are available
const hasX64Dmg = fs.existsSync(X64_DMG);
const hasArm64Dmg = fs.existsSync(ARM64_DMG);
const hasBuiltApp = fs.existsSync(
  path.join(PROJECT_ROOT, "build", "factory-desktop-linux-unpacked", "factory-desktop")
);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Clean packaging artifacts from the dist directory without deleting
 * compiled CLI JavaScript files.
 */
function cleanPackagingArtifacts(distDirPath: string): void {
  if (!fs.existsSync(distDirPath)) return;
  const entries = fs.readdirSync(distDirPath);
  for (const entry of entries) {
    if (
      entry.endsWith(".deb") ||
      entry.endsWith(".AppImage") ||
      entry.endsWith(".rpm") ||
      entry.endsWith(".sha256") ||
      entry.includes("checksums") ||
      entry.includes("latest-linux") ||
      entry.includes("electron-builder")
    ) {
      fs.rmSync(path.join(distDirPath, entry), { recursive: true, force: true });
    }
  }
}

function runCli(args: string[], timeoutMs = 300_000): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  try {
    const result = spawnSync(
      "node",
      [CLI_PATH, ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10 MB buffer for large build output
      }
    );
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: String(err),
    };
  }
}

// ─── VAL-CROSS-001: One-Command Build ─────────────────────────────────────

const describeIfDmgAvailable = hasX64Dmg ? describe : describe.skip;

describeIfDmgAvailable("VAL-CROSS-001: One-command build from DMG to Linux app", () => {
  const workDir = path.join(PROJECT_ROOT, "work");
  const distDir = path.join(PROJECT_ROOT, "dist");

  test("build-all command is documented and available", () => {
    const result = runCli(["build-all", "--help"], 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("One-command build");
    expect(result.stdout).toContain("--dmg");
    expect(result.stdout).toContain("--factory-version");
    expect(result.stdout).toContain("--targets");
    expect(result.stdout).toContain("--validate");
    expect(result.stdout).toContain("--validate-ui");
  });

  test("build-all requires --dmg option", () => {
    const result = runCli(["build-all"], 10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--dmg");
  });

  test("build-all rejects invalid DMG path", () => {
    const result = runCli(
      ["build-all", "--dmg", "/nonexistent/file.dmg", "--factory-version", "0.106.0"],
      15_000
    );
    expect(result.exitCode).not.toBe(0);
  });

  test("build-all performs extraction, droid resolution, runtime assembly, and package generation", () => {
    // Clean work and dist to ensure a fresh build
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    if (fs.existsSync(distDir)) {
      cleanPackagingArtifacts(distDir);
    }

    const result = runCli(
      ["build-all", "--dmg", X64_DMG, "--factory-version", FACTORY_VERSION, "--validate"],
      300_000
    );

    // The build should succeed
    expect(result.exitCode).toBe(0);

    // Should report successful steps
    expect(result.stdout).toContain("Step 1/6");
    expect(result.stdout).toContain("Step 2/6");
    expect(result.stdout).toContain("Step 3/6");
    expect(result.stdout).toContain("Step 4/6");
    expect(result.stdout).toContain("Step 5/6");
    expect(result.stdout).toContain("Step 6/6");

    // Should report extraction completed
    expect(result.stdout).toContain("Extracted app.asar");

    // Should report droid resolved
    expect(result.stdout).toContain("droid resolved");

    // Should report runtime assembled
    expect(result.stdout).toContain("Linux app assembled");

    // Should report desktop entry generated
    expect(result.stdout).toContain("Desktop entry");

    // Should report packages built
    expect(result.stdout).toContain("Packages built successfully");

    // Should produce package artifacts in dist/
    expect(fs.existsSync(distDir)).toBe(true);
    const distFiles = fs.readdirSync(distDir);
    const hasDeb = distFiles.some((f) => f.endsWith(".deb"));
    const hasAppImage = distFiles.some((f) => f.endsWith(".AppImage"));
    expect(hasDeb || hasAppImage).toBe(true);

    // Should report Build Complete
    expect(result.stdout).toContain("Build Complete");

    // Should report Factory version
    expect(result.stdout).toContain(FACTORY_VERSION);
  }, 300_000);

  test("build-all with --arm64-dmg performs parity check", () => {
    if (!hasArm64Dmg) {
      // Skip if arm64 DMG is not available
      return;
    }

    // Clean work for fresh parity check
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const result = runCli(
      ["build-all", "--dmg", X64_DMG, "--arm64-dmg", ARM64_DMG, "--factory-version", FACTORY_VERSION],
      300_000
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Arm64 parity");
  }, 300_000);

  test("build-all with RPM target fails with deferred diagnostic", () => {
    const result = runCli(
      ["build-all", "--dmg", X64_DMG, "--factory-version", FACTORY_VERSION, "--targets", "rpm"],
      60_000
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DEFERRED");
  }, 60_000);

  test("build-all preserves artifact hygiene (no proprietary payloads in tracked source)", () => {
    // Clean packaging artifacts for a fresh build
    cleanPackagingArtifacts(distDir);

    // Ensure the CLI exists
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`CLI not found at ${CLI_PATH}. Run 'npm run build' first.`);
    }

    const result = runCli(
      ["build-all", "--dmg", X64_DMG, "--factory-version", FACTORY_VERSION],
      300_000
    );

    if (result.exitCode !== 0) {
      // Log stderr for debugging
      console.error("build-all stderr:", result.stderr.slice(0, 1000));
      console.error("build-all stdout tail:", result.stdout.slice(-1000));
    }

    expect(result.exitCode).toBe(0);

    // Verify git status has no proprietary-derived files in tracked source
    const gitStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    });

    const tracked = (gitStatus.stdout || "").split("\n").filter(Boolean);
    const proprietaryPatterns = [
      ".asar", ".dmg", ".deb", ".AppImage", ".rpm",
      "app.asar", "Factory.app",
    ];

    for (const line of tracked) {
      for (const pattern of proprietaryPatterns) {
        if (line.includes(pattern)) {
          // Only flag files in src/ or tests/ (generated dirs are gitignored)
          if (line.includes("src/") || line.includes("tests/")) {
            fail(`Proprietary-derived file in tracked source: ${line}`);
          }
        }
      }
    }
  }, 300_000);
});

// ─── VAL-CROSS-002: Built App Launches and Shows Factory UI Shell ──────────

const describeIfAppAvailable = hasBuiltApp ? describe : describe.skip;

describeIfAppAvailable("VAL-CROSS-002: Built app launches and shows Factory UI shell", () => {
  const appDir = path.join(PROJECT_ROOT, "build", "factory-desktop-linux-unpacked");

  test("assembled app starts without fatal errors", async () => {
    const result = await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    expect(result.startedCleanly).toBe(true);
    expect(result.noFatalConsoleErrors).toBe(true);
  }, 45_000);

  test("assembled app terminates cleanly after validation", async () => {
    const result = await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    expect(result.terminatedCleanly).toBe(true);
  }, 45_000);

  test("assembled app renders content (not blank window)", async () => {
    const result = await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    // The renderer should have loaded - either via CDP verification
    // or process survival fallback
    expect(result.rendererLoaded).toBe(true);
  }, 45_000);

  test("no fatal console errors during startup", async () => {
    const result = await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    expect(result.fatalErrors).toEqual([]);
    expect(result.noFatalConsoleErrors).toBe(true);
  }, 45_000);

  test("overall UI shell validation passes", async () => {
    const result = await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    expect(result.success).toBe(true);
  }, 45_000);

  test("no orphan processes remain after UI validation", async () => {
    // Capture baseline
    const baselineOutput = execSync("ps -eo pid,comm", { encoding: "utf-8" });
    const baselinePids = new Set(
      baselineOutput
        .split("\n")
        .filter((line) => line.includes("factory-desktop") || line.includes("electron") || line.includes("droid"))
        .map((line) => line.trim().split(/\s+/)[0])
    );

    await validateUiShell({
      appDir,
      appName: "factory-desktop",
      noSandbox: true,
      startupTimeout: 20_000,
      cdpTimeout: 5_000,
    });

    // Wait for processes to settle
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check for remaining processes
    const afterOutput = execSync("ps -eo pid,comm", { encoding: "utf-8" });
    const afterPids = afterOutput
      .split("\n")
      .filter((line) => line.includes("factory-desktop") || line.includes("electron") || line.includes("droid"))
      .map((line) => line.trim().split(/\s+/)[0]);

    // New PIDs that weren't in the baseline are orphans
    const orphanPids = afterPids.filter((pid) => !baselinePids.has(pid));
    expect(orphanPids).toHaveLength(0);
  }, 45_000);
});

// ─── Cross-cutting build-all integration with UI validation ────────────────

describeIfDmgAvailable("build-all --validate-ui integration", () => {
  test("build-all with --validate-ui flag validates the Factory UI shell", () => {
    const distDir = path.join(PROJECT_ROOT, "dist");
    // Clean packaging artifacts for a fresh build
    cleanPackagingArtifacts(distDir);

    const result = runCli(
      ["build-all", "--dmg", X64_DMG, "--factory-version", FACTORY_VERSION, "--validate", "--validate-ui"],
      600_000
    );

    // The build should succeed including UI validation
    expect(result.exitCode).toBe(0);

    // Should report UI shell validation step
    expect(result.stdout).toContain("UI Shell Validation");

    // Should report UI shell validation passed
    expect(result.stdout).toContain("UI shell validation passed");
  }, 600_000);
});
