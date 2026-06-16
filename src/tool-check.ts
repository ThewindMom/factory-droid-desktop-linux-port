/**
 * Tool availability checks for the builder environment.
 * Verifies required external tools are present before build stages.
 */

import { execSync } from "child_process";

/** Required tool definition */
export interface RequiredTool {
  /** Command name to check */
  name: string;
  /** Human-readable description */
  description: string;
  /** Minimum version (optional) */
  minVersion?: string;
  /** How to get the version string */
  versionArg?: string;
  /** Whether the tool is required for basic operation */
  required: boolean;
}

/** Known required tools for the builder */
export const REQUIRED_TOOLS: RequiredTool[] = [
  {
    name: "7z",
    description: "7-Zip for DMG extraction",
    versionArg: "--help",
    required: true,
  },
  {
    name: "node",
    description: "Node.js runtime",
    versionArg: "--version",
    required: true,
  },
  {
    name: "npm",
    description: "npm package manager",
    versionArg: "--version",
    required: true,
  },
  {
    name: "file",
    description: "File type identification",
    versionArg: "--version",
    required: true,
  },
  {
    name: "sha256sum",
    description: "SHA-256 checksum verification",
    versionArg: "--version",
    required: true,
  },
  {
    name: "dpkg-deb",
    description: "Debian package builder",
    required: false,
  },
  {
    name: "desktop-file-validate",
    description: "Desktop entry validation",
    required: false,
  },
  {
    name: "xvfb-run",
    description: "Headless X display for Electron testing",
    required: false,
  },
  {
    name: "rpmbuild",
    description: "RPM package builder (deferred)",
    required: false,
  },
];

/** Tool check result */
export interface ToolCheckResult {
  tool: string;
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Check whether a single tool is available on the system.
 */
export function checkTool(tool: RequiredTool): ToolCheckResult {
  try {
    const versionCmd = tool.versionArg
      ? `${tool.name} ${tool.versionArg}`
      : `which ${tool.name}`;
    const output = execSync(versionCmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });

    // Extract version from first line
    const versionLine = output.trim().split("\n")[0];

    return {
      tool: tool.name,
      available: true,
      version: versionLine,
    };
  } catch (err) {
    return {
      tool: tool.name,
      available: false,
      error: String(err),
    };
  }
}

/**
 * Check all required tools and return results.
 * If any required tool is missing, the builder should fail early.
 */
export function checkAllTools(): {
  results: ToolCheckResult[];
  missing: string[];
  missingRequired: string[];
} {
  const results = REQUIRED_TOOLS.map(checkTool);
  const missing = results
    .filter((r) => !r.available)
    .map((r) => r.tool);
  const missingRequired = results
    .filter((r) => !r.available)
    .filter((r) => {
      const tool = REQUIRED_TOOLS.find((t) => t.name === r.tool);
      return tool?.required ?? false;
    })
    .map((r) => r.tool);

  return { results, missing, missingRequired };
}

/**
 * Assert that all required tools are available.
 * Throws with actionable diagnostics if any are missing.
 */
export function assertRequiredTools(): void {
  const { missingRequired } = checkAllTools();
  if (missingRequired.length > 0) {
    throw new Error(
      `Missing required tools: ${missingRequired.join(", ")}. ` +
        `Please install them before running the builder.`
    );
  }
}
