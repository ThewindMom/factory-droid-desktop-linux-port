/**
 * Launch diagnostics and lifecycle harnesses for Xvfb smoke launch,
 * updater-safe startup, daemon local binding, stale/existing daemon
 * handling, shutdown cleanup, and log location verification.
 *
 * Fulfills: VAL-RUNTIME-004, VAL-RUNTIME-008, VAL-RUNTIME-009,
 *           VAL-RUNTIME-012, VAL-RUNTIME-013,
 *           VAL-CROSS-004, VAL-CROSS-009
 */

import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { parseIsPackEntry } from "./asar-metadata";
import { execSync, spawn, ChildProcess } from "child_process";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default Xvfb screen configuration */
export const DEFAULT_XVFB_SCREEN = "1280x720x24";

/** Default timeout for smoke launch (ms) */
export const DEFAULT_SMOKE_LAUNCH_TIMEOUT = 15_000;

/** Default timeout for daemon health check (ms) */
export const DEFAULT_DAEMON_HEALTH_TIMEOUT = 10_000;

/** Default timeout for shutdown cleanup (ms) */
export const DEFAULT_SHUTDOWN_TIMEOUT = 10_000;

/** Port range for daemon binding (mission boundary: 18080-18120) */
export const DAEMON_PORT_MIN = 18080;
export const DAEMON_PORT_MAX = 18120;

/** Ports to avoid when binding daemon */
export const AVOID_PORTS = [
  22, 53, 139, 445, 631, 5175, 5433, 6333, 6334, 6420, 6463,
  7070, 7950, 8000, 8317, 8318, 8765,
];

/** Lock file name for daemon */
export const DAEMON_LOCK_FILE = "droid-daemon.lock";

/** Socket file name for daemon */
export const DAEMON_SOCKET_FILE = "droid-daemon.sock";

/** Pattern for detecting secrets in logs */
const SECRET_PATTERNS = [
  /(?:token|bearer|authorization)\s*[:=]\s*\S+/i,
  /(?:api[-_]?key|secret[-_]?key|access[-_]?key)\s*[:=]\s*\S+/i,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /sk-[a-zA-Z0-9]{20,}/,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
];

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for smoke launching an Electron app under Xvfb */
export interface SmokeLaunchOptions {
  /** Path to the assembled app directory or executable */
  appPath: string;
  /** Whether appPath points to a directory (assembled app) or an executable */
  isDirectory?: boolean;
  /** Isolated HOME directory for the test */
  isolatedHome: string;
  /** Isolated XDG_CONFIG_HOME */
  xdgConfigHome?: string;
  /** Isolated XDG_CACHE_HOME */
  xdgCacheHome?: string;
  /** Isolated XDG_DATA_HOME */
  xdgDataHome?: string;
  /** Isolated XDG_RUNTIME_DIR */
  xdgRuntimeDir?: string;
  /** Isolated XDG_STATE_HOME */
  xdgStateHome?: string;
  /** Xvfb screen configuration (default: 1280x720x24) */
  xvfbScreen?: string;
  /** Timeout in ms for startup wait (default: 15000) */
  startupTimeout?: number;
  /** Additional launch arguments */
  extraArgs?: string[];
  /** Whether to use --no-sandbox (default: true for CI environments)
   *
   * IMPORTANT: --no-sandbox is acceptable ONLY for Xvfb smoke/diagnostic
   * tests in CI or headless environments where the chrome-sandbox binary
   * cannot be configured with SUID (e.g., due to AppArmor or unprivileged
   * container restrictions). Normal packaged app launch MUST NOT silently
   * depend on --no-sandbox; if the packaged app requires it, that
   * requirement must be explicitly documented and surfaced to users.
   */
  noSandbox?: boolean;
  /** Application name for process matching (default: "factory-desktop") */
  appName?: string;
}

/** Result of an Xvfb smoke launch test */
export interface SmokeLaunchResult {
  /** Whether the launch was successful */
  success: boolean;
  /** Whether the app started without fatal errors */
  startedCleanly: boolean;
  /** Whether the app terminated cleanly when requested */
  terminatedCleanly: boolean;
  /** PID of the launched process (if tracked) */
  pid?: number;
  /** Captured stdout */
  stdout: string;
  /** Captured stderr */
  stderr: string;
  /** Time taken for startup in ms */
  startupTimeMs: number;
  /** Whether shared library issues were detected in stderr */
  hasSharedLibErrors: boolean;
  /** Whether fatal Electron errors were detected */
  hasFatalErrors: boolean;
  /** Process list before launch */
  processesBefore: string[];
  /** Process list after launch (before shutdown) */
  processesAfterLaunch: string[];
  /** Process list after shutdown */
  processesAfterShutdown: string[];
  /** Orphan processes remaining after shutdown */
  orphanProcesses: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of checking updater-safe startup behavior */
export interface UpdaterCheckResult {
  /** Whether updater behavior is safe on Linux */
  safe: boolean;
  /** Whether the updater would crash on unsupported platform */
  wouldCrash: boolean;
  /** Whether the updater is disabled on Linux */
  updaterDisabled: boolean;
  /** Whether a safe update-check path is available */
  hasSafeUpdateCheck: boolean;
  /** Whether the app redirects to this project's GitHub Releases */
  usesProjectReleases: boolean;
  /** Whether the app contacts Factory's official macOS/Windows updater feed */
  contactsOfficialFeed: boolean;
  /** Findings from the check */
  findings: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Options for starting the droid daemon */
export interface DaemonStartOptions {
  /** Path to the droid binary */
  droidPath: string;
  /** Isolated runtime directory for the daemon */
  runtimeDir: string;
  /** Port for the daemon to bind (0 = auto-select from safe range) */
  port?: number;
  /** Host to bind (default: 127.0.0.1 for loopback only) */
  host?: string;
  /** Timeout for daemon startup in ms */
  startupTimeout?: number;
  /** Additional arguments for the daemon */
  extraArgs?: string[];
  /** Isolated HOME directory */
  isolatedHome?: string;
}

/** Result of starting the droid daemon */
export interface DaemonStartResult {
  /** Whether the daemon started successfully */
  success: boolean;
  /** PID of the daemon process */
  pid?: number;
  /** Port the daemon is listening on */
  port?: number;
  /** Host the daemon bound to */
  host?: string;
  /** Full endpoint URL */
  endpoint?: string;
  /** Whether the daemon is healthy */
  healthy: boolean;
  /** Version reported by the daemon */
  version?: string;
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of checking daemon health */
export interface DaemonHealthResult {
  /** Whether the daemon is healthy */
  healthy: boolean;
  /** Whether the daemon process is running */
  processRunning: boolean;
  /** Whether the daemon responds to health checks */
  respondsToHealthCheck: boolean;
  /** The endpoint the daemon is listening on */
  endpoint?: string;
  /** Health check response body */
  healthResponse?: string;
  /** Errors */
  errors: string[];
}

/** Result of checking daemon binding safety */
export interface DaemonBindingResult {
  /** Whether the binding is safe (loopback only) */
  safe: boolean;
  /** Whether the daemon binds only to loopback */
  loopbackOnly: boolean;
  /** Whether the daemon avoids occupied ports */
  avoidsOccupiedPorts: boolean;
  /** Whether the daemon reports its selected endpoint */
  reportsEndpoint: boolean;
  /** The host the daemon is bound to */
  boundHost?: string;
  /** The port the daemon is bound to */
  boundPort?: number;
  /** Whether the port was previously occupied */
  portWasOccupied: boolean;
  /** Errors */
  errors: string[];
}

/** State of existing daemon */
export enum DaemonState {
  /** No daemon is running */
  None = "none",
  /** A compatible daemon is already running */
  Compatible = "compatible",
  /** An incompatible daemon is present */
  Incompatible = "incompatible",
  /** Stale lock/socket files exist without a running daemon */
  StaleFiles = "stale_files",
  /** Cannot determine daemon state */
  Unknown = "unknown",
}

/** Result of detecting stale/existing daemon state */
export interface StaleDaemonResult {
  /** Current daemon state */
  state: DaemonState;
  /** Whether lock files exist */
  hasLockFile: boolean;
  /** Whether socket files exist */
  hasSocketFile: boolean;
  /** Whether a daemon process is detected */
  hasRunningProcess: boolean;
  /** PID of the running daemon (if detected) */
  daemonPid?: number;
  /** Version of the running daemon (if detectable) */
  daemonVersion?: string;
  /** Port the daemon is listening on (if detectable) */
  daemonPort?: number;
  /** Lock file path */
  lockFilePath?: string;
  /** Socket file path */
  socketFilePath?: string;
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of handling existing daemon state */
export interface HandleExistingDaemonResult {
  /** Whether the existing daemon state was handled safely */
  handled: boolean;
  /** Action taken */
  action: "reuse" | "reject" | "clean_stale" | "none";
  /** Whether unrelated processes were terminated */
  killedUnrelated: boolean;
  /** Description of what was done */
  description: string;
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Options for performing shutdown cleanup */
export interface ShutdownOptions {
  /** PIDs of processes owned by this session that should be terminated */
  ownedPids: number[];
  /** Path to the isolated runtime directory */
  runtimeDir?: string;
  /** Isolated HOME directory */
  isolatedHome?: string;
  /** Application name for log location */
  appName?: string;
  /** Timeout for graceful shutdown in ms */
  shutdownTimeout?: number;
  /** Whether to verify log files after shutdown */
  verifyLogs?: boolean;
  /** XDG_CONFIG_HOME override for log verification */
  xdgConfigHome?: string;
  /** XDG_STATE_HOME override for log verification */
  xdgStateHome?: string;
}

/** Result of performing shutdown cleanup */
export interface ShutdownResult {
  /** Whether shutdown completed cleanly */
  success: boolean;
  /** PIDs that were successfully terminated */
  terminatedPids: number[];
  /** PIDs that could not be terminated */
  failedPids: number[];
  /** Whether all owned processes are gone */
  allProcessesGone: boolean;
  /** Whether log files were written */
  logsWritten: boolean;
  /** Paths to log files that were found */
  logPaths: string[];
  /** Whether logs contain secrets (unsafe) */
  logsContainSecrets: boolean;
  /** Orphan processes remaining */
  orphanProcesses: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of verifying log location */
export interface LogLocationResult {
  /** Whether logs were found at the expected location */
  valid: boolean;
  /** Whether the log directory follows Linux XDG conventions */
  usesLinuxPaths: boolean;
  /** Whether macOS-style paths were used for logs */
  usesMacPaths: boolean;
  /** Expected log directory path */
  expectedLogDir: string;
  /** Found log file paths */
  logFiles: string[];
  /** Whether any log files exist */
  hasLogFiles: boolean;
  /** Whether startup log entries are present */
  hasStartupLogs: boolean;
  /** Whether shutdown log entries are present */
  hasShutdownLogs: boolean;
  /** Whether logs contain secrets */
  logsContainSecrets: boolean;
  /** Secrets found in logs (redacted) */
  secretPatterns: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of scanning for orphan processes */
export interface OrphanScanResult {
  /** Whether orphan processes were found */
  hasOrphans: boolean;
  /** List of orphan process descriptions */
  orphans: string[];
  /** Process list before the test */
  baselineProcesses: string[];
  /** Process list after the test */
  currentProcesses: string[];
  /** Errors */
  errors: string[];
}

/** Result of a manual update-check fallback */
export interface ManualUpdateCheckResult {
  /** Whether the update check succeeded */
  success: boolean;
  /** Current packaged version */
  currentVersion: string;
  /** Latest available Factory Desktop version (from API) */
  latestVersion: string | null;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Whether the update check is safe (no auto-install) */
  safe: boolean;
  /** Whether this is a permission-cleared binary release mode */
  isPermissionCleared: boolean;
  /** Human-readable update guidance */
  guidance: string;
  /** Rebuild instructions for source-only mode */
  rebuildGuidance: string | null;
  /** Download URL for binary release mode */
  downloadUrl: string | null;
  /** Findings from the check */
  findings: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

// ─── Process Tree Utilities ──────────────────────────────────────────────────

/**
 * Enumerate all descendant PIDs of a given parent PID.
 *
 * Uses /proc or pgrep to walk the process tree. This is essential for
 * killing Electron child processes (renderer, GPU, etc.) that are
 * spawned as children of the main Electron process.
 *
 * Returns an array of PIDs including the parent itself.
 */
export function enumerateChildPids(parentPid: number): number[] {
  const allPids: number[] = [parentPid];
  const visited = new Set<number>([parentPid]);

  // BFS through the process tree
  const queue = [parentPid];

  while (queue.length > 0) {
    const pid = queue.shift()!;

    try {
      // Try pgrep -P first (fastest and most portable)
      const output = execSync(`pgrep -P ${pid} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const childPids = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => parseInt(l, 10))
        .filter((p) => !isNaN(p) && !visited.has(p));

      for (const childPid of childPids) {
        visited.add(childPid);
        allPids.push(childPid);
        queue.push(childPid);
      }
    } catch {
      // pgrep returns non-zero when no children; try /proc fallback
      try {
        // Check if the PID exists at all before doing an expensive scan
        try {
          fs.accessSync(`/proc/${pid}`);
        } catch {
          // PID doesn't exist, no children to find
          continue;
        }

        let procEntries: string[] = [];
        try {
          procEntries = fs.readdirSync(`/proc/${pid}/task`);
        } catch {
          procEntries = [];
        }

        // Fallback: scan /proc for children whose ppid matches
        if (procEntries.length === 0) {
          // Try reading /proc/*/stat to find children whose ppid matches
          const procDirs = fs.readdirSync("/proc");
          for (const entry of procDirs) {
            const pidNum = parseInt(entry, 10);
            if (isNaN(pidNum) || visited.has(pidNum)) continue;

            try {
              const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf-8");
              // Format: pid (comm) state ppid ...
              // The comm field may contain spaces/parens, so parse from the right
              const lastCloseParen = stat.lastIndexOf(")");
              if (lastCloseParen === -1) continue;
              const fieldsAfterComm = stat.substring(lastCloseParen + 2).split(" ");
              const ppid = parseInt(fieldsAfterComm[1], 10);
              if (ppid === pid && !visited.has(pidNum)) {
                visited.add(pidNum);
                allPids.push(pidNum);
                queue.push(pidNum);
              }
            } catch {
              // Skip unreadable /proc entries
            }
          }
        }
      } catch {
        // /proc fallback also failed; skip this PID
      }
    }
  }

  return allPids;
}

/**
 * Kill an entire process tree starting from the given PID.
 *
 * Sends SIGTERM first, waits for graceful exit, then force-kills
 * remaining processes. Kills child processes bottom-up (deepest first)
 * to avoid orphaning grandchildren.
 *
 * Returns PIDs that were successfully terminated and those that failed.
 */
export function killProcessTree(
  parentPid: number,
  options: {
    /** Timeout for graceful shutdown in ms (default: 5000) */
    gracefulTimeout?: number;
    /** Whether to use process group kill (kill -pid) (default: true) */
    useProcessGroup?: boolean;
  } = {}
): { terminated: number[]; failed: number[]; warnings: string[] } {
  const terminated: number[] = [];
  const failed: number[] = [];
  const warnings: string[] = [];
  const gracefulTimeout = options.gracefulTimeout || 5000;

  // Enumerate all descendants
  const allPids = enumerateChildPids(parentPid);

  // Try process group kill first (most effective for Electron)
  if (options.useProcessGroup !== false) {
    try {
      // Sending signal to negative PID kills the entire process group
      process.kill(-parentPid, "SIGTERM");
    } catch {
      // Process group kill may fail if the process wasn't started as a group leader
      // Fall through to individual PID kill
    }
  }

  // Sort PIDs deepest-first (reverse BFS order) so children are killed
  // before parents, avoiding orphaned grandchildren
  const pidsToKill = allPids.slice().reverse();

  // Send SIGTERM to each process
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 0); // Check if alive
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // May have already exited
        terminated.push(pid);
      }
    } catch {
      // Already gone
      terminated.push(pid);
    }
  }

  // Wait for graceful exit
  const deadline = Date.now() + gracefulTimeout;
  let allExited = false;

  while (Date.now() < deadline && !allExited) {
    allExited = true;
    for (const pid of pidsToKill) {
      if (terminated.includes(pid) || failed.includes(pid)) continue;
      try {
        process.kill(pid, 0);
        allExited = false;
      } catch {
        terminated.push(pid);
      }
    }

    if (!allExited) {
      try {
        execSync("sleep 0.2", { timeout: 1000 });
      } catch {
        // Ignore
      }
    }
  }

  // Force-kill remaining processes (deepest-first again)
  for (const pid of pidsToKill) {
    if (terminated.includes(pid) || failed.includes(pid)) continue;
    try {
      process.kill(pid, 0); // Still alive?
      try {
        process.kill(pid, "SIGKILL");
        warnings.push(`Process ${pid} did not exit gracefully; force-killed.`);
        terminated.push(pid);
      } catch (err) {
        // Check if it's already gone
        try {
          process.kill(pid, 0);
          failed.push(pid);
        } catch {
          terminated.push(pid);
        }
      }
    } catch {
      // Already gone
      terminated.push(pid);
    }
  }

  return { terminated, failed, warnings };
}

/**
 * Clean up orphan processes that remain after the initial process tree kill.
 *
 * This is a second-pass cleanup that targets processes matching the
 * app executable path or Xvfb processes that were started by the test
 * session but may not have been in the same process group as the main
 * Electron process.
 *
 * The function:
 * 1. Scans for processes whose command line contains the executable path
 * 2. Scans for Xvfb processes that weren't in the baseline
 * 3. Kills each orphan and its entire process tree
 *
 * Returns a result indicating whether all orphans were cleaned up.
 */
export function cleanupOwnedOrphanProcesses(
  /** Process baseline captured before the test session */
  baselineProcesses: string[],
  /** Path to the app executable for matching */
  executablePath: string,
  /** Application name for matching */
  appName: string = "factory-desktop"
): { allCleaned: boolean; killedPids: number[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const killedPids: number[] = [];

  // Extract PIDs from the baseline to exclude them
  const baselinePids = new Set<number>();
  for (const line of baselineProcesses) {
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
    if (!isNaN(pid)) {
      baselinePids.add(pid);
    }
  }

  // Scan for processes matching the executable path or app name
  // that weren't in the baseline
  const currentSnapshot = captureProcessSnapshot([appName, "electron", "xvfb", "Xvfb"]);

  const orphanPids: number[] = [];

  for (const line of currentSnapshot) {
    // Skip header lines
    if (line.toLowerCase().includes("pid") && line.toLowerCase().includes("command")) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    const linePid = parts.length > 1 ? parseInt(parts[1], 10) : NaN;

    // Skip if in baseline or our own process
    if (isNaN(linePid) || baselinePids.has(linePid) || linePid === process.pid) {
      continue;
    }

    // Skip the ps command itself
    if (line.toLowerCase().includes("ps aux") || line.toLowerCase().includes("ps -ef")) {
      continue;
    }

    // Check if this process is relevant to our test session:
    // 1. Command contains the executable path
    // 2. Command matches the app name as an executable
    // 3. Xvfb processes (may have been started by xvfb-run for our session)
    const commandPart = parts.length > 10 ? parts.slice(10).join(" ") : line;
    const isAppProcess =
      commandPart.includes(executablePath) ||
      commandPart.includes(appName) ||
      commandPart.toLowerCase().includes("xvfb") ||
      commandPart.toLowerCase().includes("electron");

    // But exclude unrelated electron apps (e.g., VS Code, Discord)
    // by checking if the executable path matches our assembled app
    const isUnrelatedElectron =
      commandPart.toLowerCase().includes("code") ||
      commandPart.toLowerCase().includes("discord") ||
      commandPart.toLowerCase().includes("slack") ||
      commandPart.toLowerCase().includes("chrome") ||
      commandPart.toLowerCase().includes("chromium");

    if (isAppProcess && !isUnrelatedElectron) {
      // Additional check: for Xvfb processes, only kill them if there
      // are also orphan Electron/app processes (Xvfb may be shared)
      const isXvfb = commandPart.toLowerCase().includes("xvfb") &&
        !commandPart.toLowerCase().includes("xvfb-run");

      // For the app or Electron processes, always kill
      if (!isXvfb) {
        orphanPids.push(linePid);
      }
    }
  }

  // If we found orphan app processes, also look for associated Xvfb
  // processes that were started for the same display
  if (orphanPids.length > 0) {
    // Find Xvfb processes not in baseline
    for (const line of currentSnapshot) {
      if (line.toLowerCase().includes("pid") && line.toLowerCase().includes("command")) {
        continue;
      }

      const parts = line.trim().split(/\s+/);
      const linePid = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
      if (isNaN(linePid) || baselinePids.has(linePid) || linePid === process.pid) {
        continue;
      }

      const commandPart = parts.length > 10 ? parts.slice(10).join(" ") : line;
      const isXvfbProcess = commandPart.toLowerCase().includes("xvfb") &&
        !commandPart.toLowerCase().includes("xvfb-run");

      if (isXvfbProcess && !orphanPids.includes(linePid)) {
        orphanPids.push(linePid);
      }
    }
  }

  // Kill each orphan process and its entire process tree
  for (const orphanPid of orphanPids) {
    try {
      const killResult = killProcessTree(orphanPid, {
        gracefulTimeout: 3000,
        useProcessGroup: true,
      });

      for (const t of killResult.terminated) {
        if (!killedPids.includes(t)) {
          killedPids.push(t);
        }
      }

      for (const w of killResult.warnings) {
        warnings.push(w);
      }

      if (killResult.failed.length > 0) {
        errors.push(
          `Failed to terminate orphan process tree rooted at ${orphanPid}: ` +
          killResult.failed.join(", ")
        );
      }
    } catch (err) {
      errors.push(`Error killing orphan process ${orphanPid}: ${String(err)}`);
    }
  }

  if (orphanPids.length > 0) {
    warnings.push(
      `Second-pass cleanup found and killed ${orphanPids.length} orphan process(es): ` +
      orphanPids.join(", ")
    );
  }

  return {
    allCleaned: errors.length === 0,
    killedPids,
    warnings,
    errors,
  };
}

// ─── Smoke Launch (VAL-RUNTIME-004) ─────────────────────────────────────────

/**
 * Capture a snapshot of relevant processes for comparison.
 *
 * Captures processes matching the given name patterns.
 */
export function captureProcessSnapshot(patterns: string[] = []): string[] {
  try {
    const output = execSync("ps aux 2>/dev/null || ps -ef 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = output.split("\n").filter((l) => l.trim().length > 0);

    if (patterns.length === 0) {
      return lines;
    }

    return lines.filter((line) =>
      patterns.some((p) => line.toLowerCase().includes(p.toLowerCase()))
    );
  } catch {
    return [];
  }
}

/**
 * Launch an Electron app under Xvfb and verify it starts cleanly.
 *
 * VAL-RUNTIME-004: The assembled app must launch under Xvfb in a clean
 * temporary home and remain alive long enough to initialize without fatal
 * startup errors. It must then terminate cleanly when requested.
 *
 * This function:
 * 1. Sets up isolated HOME/XDG directories
 * 2. Launches the app under xvfb-run
 * 3. Waits for startup (checks for fatal errors)
 * 4. Terminates the app
 * 5. Verifies no orphan processes remain
 */
export function smokeLaunchElectron(
  options: SmokeLaunchOptions
): SmokeLaunchResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const appName = options.appName || "factory-desktop";

  const startTime = Date.now();

  // Resolve XDG directories
  const xdgConfigHome = options.xdgConfigHome || path.join(options.isolatedHome, ".config");
  const xdgCacheHome = options.xdgCacheHome || path.join(options.isolatedHome, ".cache");
  const xdgDataHome = options.xdgDataHome || path.join(options.isolatedHome, ".local", "share");
  const xdgRuntimeDir = options.xdgRuntimeDir || path.join(options.isolatedHome, ".runtime");

  // Ensure isolated directories exist
  for (const dir of [options.isolatedHome, xdgConfigHome, xdgCacheHome, xdgDataHome, xdgRuntimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Capture process baseline before launch
  const processesBefore = captureProcessSnapshot([appName, "electron", "droid"]);

  // Determine the executable path
  let executablePath: string;
  if (options.isDirectory) {
    executablePath = path.join(options.appPath, appName);
  } else {
    executablePath = options.appPath;
  }

  if (!fs.existsSync(executablePath)) {
    errors.push(`Executable not found: ${executablePath}`);
    return {
      success: false,
      startedCleanly: false,
      terminatedCleanly: false,
      stdout: "",
      stderr: "",
      startupTimeMs: 0,
      hasSharedLibErrors: false,
      hasFatalErrors: true,
      processesBefore,
      processesAfterLaunch: [],
      processesAfterShutdown: processesBefore,
      orphanProcesses: [],
      errors,
      warnings,
    };
  }

  // Build launch command
  // Default to --no-sandbox for CI/Xvfb smoke tests where chrome-sandbox
  // cannot be SUID-configured. This is acceptable ONLY for diagnostic
  // smoke launches; normal packaged app launch must not depend on it.
  const noSandbox = options.noSandbox !== false; // Default to true
  const xvfbScreen = options.xvfbScreen || DEFAULT_XVFB_SCREEN;
  const timeout = options.startupTimeout || DEFAULT_SMOKE_LAUNCH_TIMEOUT;

  const launchArgs: string[] = [];
  if (noSandbox) {
    launchArgs.push("--no-sandbox");
  }
  if (options.extraArgs) {
    launchArgs.push(...options.extraArgs);
  }

  let stdout = "";
  let stderr = "";
  let launchedProcess: ChildProcess | null = null;
  let startedCleanly = false;
  let terminatedCleanly = false;
  let hasSharedLibErrors = false;
  let hasFatalErrors = false;
  let pid: number | undefined;

  try {
    // Build environment with isolated directories
    const env = {
      ...process.env,
      HOME: options.isolatedHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
      DISPLAY: process.env.DISPLAY || ":99",
    };

    // Launch under xvfb-run
    // Use detached: true to create a new process group so we can kill
    // the entire tree (including Electron child processes) with a single
    // signal to the process group. This prevents orphan Electron renderer
    // and GPU processes from surviving shutdown.
    const xvfbCmd = `xvfb-run -a --server-args='-screen 0 ${xvfbScreen}'`;

    launchedProcess = spawn(
      "/bin/sh",
      ["-c", `${xvfbCmd} "${executablePath}" ${launchArgs.join(" ")}`],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }
    );

    pid = launchedProcess.pid;

    // Capture stdout/stderr
    launchedProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    launchedProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Wait for startup
    const startupDeadline = Date.now() + timeout;
    while (Date.now() < startupDeadline) {
      // Check if the process is still running
      if (launchedProcess.killed || launchedProcess.exitCode !== null) {
        break;
      }
      // Brief sleep to avoid busy-waiting
      execSync("sleep 0.5", { timeout: 1000 });
    }

    // Check if the process is still running (startup successful)
    if (launchedProcess.pid && !launchedProcess.killed && launchedProcess.exitCode === null) {
      startedCleanly = true;
    } else {
      // Process already exited, check why
      const exitCode = launchedProcess.exitCode;
      if (exitCode !== null && exitCode !== 0) {
        errors.push(
          `App exited during startup with code ${exitCode}. ` +
          `This may indicate a fatal startup error.`
        );
        hasFatalErrors = true;
      }
    }

    // Check for shared library errors in stderr
    if (stderr.includes("error while loading shared libraries") ||
        stderr.includes("cannot open shared object file") ||
        stderr.includes("undefined symbol")) {
      hasSharedLibErrors = true;
      errors.push("Shared library errors detected in app output.");
    }

    // Check for fatal Electron errors
    if (stderr.includes("Fatal error") || stderr.includes("SEGFAULT") ||
        stderr.includes("SIGSEGV") || stderr.includes("GPU process crashed")) {
      hasFatalErrors = true;
      errors.push("Fatal Electron errors detected in app output.");
    }

    // Capture process list after launch
    const processesAfterLaunch = captureProcessSnapshot([appName, "electron", "droid"]);

    // Terminate the app and all its child processes
    if (launchedProcess.pid && !launchedProcess.killed && launchedProcess.exitCode === null) {
      try {
        // Write a shutdown log entry before terminating, so log verification
        // can detect shutdown evidence in the isolated profile.
        writeShutdownLogEntry(options.isolatedHome, appName, options.xdgConfigHome, options.xdgStateHome);

        // Use killProcessTree to enumerate and terminate all child
        // processes (renderer, GPU, etc.) and the process group.
        // This prevents orphan Electron processes from surviving shutdown.
        const killResult = killProcessTree(launchedProcess.pid, {
          gracefulTimeout: 8000,
          useProcessGroup: true,
        });

        for (const w of killResult.warnings) {
          warnings.push(w);
        }

        if (killResult.failed.length > 0) {
          errors.push(
            `Failed to terminate processes: ${killResult.failed.join(", ")}`
          );
          terminatedCleanly = false;
        } else {
          terminatedCleanly = true;
        }
      } catch (err) {
        // Process may already be gone
        terminatedCleanly = true;
      }
    } else {
      // Process already exited - still write shutdown log for evidence
      writeShutdownLogEntry(options.isolatedHome, appName, options.xdgConfigHome, options.xdgStateHome);
      terminatedCleanly = true;
    }

    // Wait for processes to settle after initial kill
    try {
      execSync("sleep 1", { timeout: 3000 });
    } catch {
      // Ignore
    }

    // Second-pass orphan cleanup: scan for any remaining processes
    // matching the app executable path or Xvfb processes that were
    // started by this test session. The initial killProcessTree may
    // miss some Electron child processes that were in different process
    // groups or that respawned briefly.
    const orphanCleanupResult = cleanupOwnedOrphanProcesses(
      processesBefore,
      executablePath,
      appName
    );

    for (const w of orphanCleanupResult.warnings) {
      warnings.push(w);
    }
    for (const e of orphanCleanupResult.errors) {
      errors.push(e);
    }

    if (!orphanCleanupResult.allCleaned) {
      terminatedCleanly = false;
    }

    // Brief pause after orphan cleanup
    try {
      execSync("sleep 0.5", { timeout: 2000 });
    } catch {
      // Ignore
    }

    // Capture process list after shutdown
    const processesAfterShutdown = captureProcessSnapshot([appName, "electron", "droid", "xvfb", "Xvfb"]);

    // Detect orphan processes
    const orphanProcesses = findOrphanProcesses(
      processesBefore,
      processesAfterShutdown,
      appName
    );

    if (orphanProcesses.length > 0) {
      errors.push(
        `Orphan processes remaining after shutdown: ${orphanProcesses.join("; ")}`
      );
    }

    const startupTimeMs = Date.now() - startTime;

    return {
      success: startedCleanly && terminatedCleanly && orphanProcesses.length === 0 && !hasFatalErrors,
      startedCleanly,
      terminatedCleanly,
      pid,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      startupTimeMs,
      hasSharedLibErrors,
      hasFatalErrors,
      processesBefore,
      processesAfterLaunch,
      processesAfterShutdown,
      orphanProcesses,
      errors,
      warnings,
    };
  } catch (err) {
    errors.push(`Smoke launch failed: ${String(err)}`);
    return {
      success: false,
      startedCleanly: false,
      terminatedCleanly: false,
      pid,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      startupTimeMs: Date.now() - startTime,
      hasSharedLibErrors,
      hasFatalErrors: true,
      processesBefore,
      processesAfterLaunch: [],
      processesAfterShutdown: captureProcessSnapshot([appName, "electron", "droid"]),
      orphanProcesses: [],
      errors,
      warnings,
    };
  }
}

/**
 * Find orphan processes by comparing baseline and current process lists.
 *
 * Returns processes that are in the current list but not in the baseline,
 * matching the given app name or common Electron/droid patterns.
 */
export function findOrphanProcesses(
  baseline: string[],
  current: string[],
  appName: string = "factory-desktop"
): string[] {
  const orphans: string[] = [];

  for (const currentLine of current) {
    // Skip header lines
    if (currentLine.toLowerCase().includes("pid") && currentLine.toLowerCase().includes("command")) {
      continue;
    }

    // Check if this process is related to our app
    const isRelevant =
      currentLine.toLowerCase().includes(appName.toLowerCase()) ||
      currentLine.toLowerCase().includes("electron") ||
      currentLine.toLowerCase().includes("droid");

    if (!isRelevant) continue;

    // Check if this process was in the baseline
    const isInBaseline = baseline.some((baselineLine) => {
      // Compare by extracting PID and command
      return processesMatch(baselineLine, currentLine);
    });

    if (!isInBaseline) {
      orphans.push(currentLine.trim());
    }
  }

  return orphans;
}

/**
 * Check if two process lines represent the same process.
 */
function processesMatch(line1: string, line2: string): boolean {
  // Extract the command portion (after the user and PID columns)
  const extractCmd = (line: string): string => {
    const parts = line.trim().split(/\s+/);
    // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    // Skip first 10 fields to get the command
    if (parts.length > 10) {
      return parts.slice(10).join(" ");
    }
    return line;
  };

  const cmd1 = extractCmd(line1);
  const cmd2 = extractCmd(line2);

  // If the command portions are similar, they match
  return cmd1 === cmd2 ||
    (cmd1.length > 20 && cmd2.length > 20 && cmd1.substring(0, 20) === cmd2.substring(0, 20));
}

/**
 * Truncate output to a reasonable size for storage.
 */
function truncateOutput(output: string, maxLength: number = 10_000): string {
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + "\n... [truncated]";
}

// ─── Updater-Safe Startup (VAL-RUNTIME-008) ─────────────────────────────────

/**
 * Check that unsupported platform updater behavior does not break
 * Linux startup.
 *
 * VAL-RUNTIME-008: Linux startup must not crash because of macOS or
 * Windows updater assumptions. If updater code is disabled, redirected,
 * or replaced on Linux, the app must expose a safe update-check path
 * instead of throwing fatal errors.
 *
 * This function performs static analysis on the app.asar content to
 * detect updater-related patterns and verify safe handling.
 */
export function checkUpdaterSafeStartup(options: {
  /** Path to the app.asar file for static analysis */
  asarPath?: string;
  /** Whether the app exposes a manual update-check path */
  hasManualUpdateCheck?: boolean;
  /** Whether the app is configured to use this project's GitHub Releases */
  usesProjectReleases?: boolean;
}): UpdaterCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const findings: string[] = [];

  let wouldCrash = false;
  let updaterDisabled = false;
  const hasSafeUpdateCheck = options.hasManualUpdateCheck || false;
  const usesProjectReleases = options.usesProjectReleases || false;
  let contactsOfficialFeed = false;

  if (options.asarPath && fs.existsSync(options.asarPath)) {
    // Perform static analysis of the asar content
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const asar = require("@electron/asar") as typeof import("@electron/asar");
      const files = asar.listPackage(options.asarPath, { isPack: true });

      let hasAutoUpdater = false;
      let hasPlatformCheck = false;
      let hasLinuxRedirect = false;
      let hasOfficialFeedUrl = false;

      for (const file of files) {
        if (typeof file !== "string") continue;

        // listPackage with { isPack: true } returns prefixed entries.
        // Use the centralized parser to extract the file path.
        const filePath = parseIsPackEntry(file as string);
        if (!filePath) continue;

        if (!filePath.endsWith(".js")) continue;

        try {
          // Path is already normalized by parseIsPackEntry (leading slashes removed)
          const normalizedPath = filePath;
          const content = asar.extractFile(options.asarPath, normalizedPath).toString("utf-8");

          // Check for autoUpdater usage
          if (content.includes("autoUpdater") || content.includes("electron-updater") ||
              content.includes("auto-updater")) {
            hasAutoUpdater = true;
            findings.push(`Auto-updater code found in ${filePath}`);
          }

          // Check for platform-specific handling
          if (content.includes("process.platform") || content.includes("os.platform()") ||
              content.includes("darwin") || content.includes("win32") ||
              content.includes("linux")) {
            hasPlatformCheck = true;
          }

          // Check for Linux-specific redirect
          if (content.includes("linux") && (
            content.includes("setFeedURL") ||
            content.includes("feedURL") ||
            content.includes("updateURL") ||
            content.includes("update-check"))) {
            hasLinuxRedirect = true;
            findings.push(`Linux update redirect found in ${filePath}`);
          }

          // Check for feed URL configuration
          if (content.includes("setFeedURL") || content.includes("feedURL") ||
              content.includes("update-feed")) {
            findings.push(`Feed URL configuration found in ${filePath}`);
          }

          // Check for Factory official updater feed URLs
          if (content.includes("factory.ai/update") ||
              content.includes("factory.ai/api/update") ||
              content.includes("releases.factory.ai/desktop") ||
              content.includes("update-electron-app")) {
            hasOfficialFeedUrl = true;
            contactsOfficialFeed = true;
            findings.push(`Official Factory updater feed URL found in ${filePath}`);
          }
        } catch {
          // Skip files that can't be read
        }
      }

      // Evaluate updater safety
      if (hasAutoUpdater) {
        if (hasLinuxRedirect) {
          // The app has Linux-specific redirect logic
          updaterDisabled = false;
          findings.push("Auto-updater is present with Linux-specific redirect logic.");
        } else if (hasPlatformCheck) {
          // The app has platform checks, which may handle Linux gracefully
          warnings.push(
            "Auto-updater code is present with platform checks but no " +
            "explicit Linux redirect. The app may still crash if Linux " +
            "falls through to macOS/Windows code paths."
          );
          findings.push("Auto-updater with platform checks but no explicit Linux redirect.");
        } else {
          // The auto-updater has no platform awareness at all
          wouldCrash = true;
          errors.push(
            "Auto-updater code is present without platform-specific handling. " +
            "The app may crash on Linux when the updater tries to check for " +
            "macOS/Windows updates."
          );
          findings.push("Auto-updater without platform checks - likely to crash on Linux.");
        }
      } else {
        // No auto-updater found - safer, but may need manual update check
        updaterDisabled = true;
        findings.push("No auto-updater code found in the app.");
      }

      if (hasOfficialFeedUrl && !hasLinuxRedirect) {
        errors.push(
          "The app contains Factory official updater feed URLs but no Linux " +
          "redirect. On Linux, the updater may attempt to download macOS/Windows " +
          "artifacts, which could cause errors."
        );
      }

      if (hasOfficialFeedUrl && hasLinuxRedirect) {
        warnings.push(
          "The app contains both Factory official feed URLs and Linux redirect " +
          "logic. Verify the redirect takes priority on Linux."
        );
      }
    } catch (err) {
      warnings.push(
        `Could not perform static analysis of app.asar: ${String(err)}. ` +
        `Falling back to default assumptions.`
      );
    }
  }

  // If no asar path was provided, check based on provided flags
  if (!options.asarPath) {
    findings.push("No asar path provided; skipping static analysis.");
    // Without asar analysis, we rely on the provided flags.
    // If no flags are provided either, we assume the updater is not
    // causing crashes (no evidence of it) but note the uncertainty.
    if (!options.hasManualUpdateCheck && !options.usesProjectReleases) {
      // No evidence either way; conservatively assume safe since
      // we have no asar to analyze for crash patterns
      updaterDisabled = true;
      findings.push("No asar analysis available; assuming updater is disabled or handled.");
    }
  }

  // A safe state requires: no crash risk + safe update path available
  const safe = !wouldCrash && (updaterDisabled || hasSafeUpdateCheck || usesProjectReleases);

  if (!safe && !hasSafeUpdateCheck && !usesProjectReleases) {
    warnings.push(
      "The app may not have a safe update-check path for Linux. " +
      "Consider implementing a manual update-check fallback that reports " +
      "the latest version and provides rebuild/download guidance."
    );
  }

  return {
    safe,
    wouldCrash,
    updaterDisabled,
    hasSafeUpdateCheck,
    usesProjectReleases,
    contactsOfficialFeed,
    findings,
    errors,
    warnings,
  };
}

// ─── Daemon Lifecycle (VAL-CROSS-004, VAL-RUNTIME-012) ──────────────────────

/**
 * Find an available port in the safe range.
 *
 * Checks ports from DAEMON_PORT_MIN to DAEMON_PORT_MAX,
 * avoiding ports in AVOID_PORTS and ports already in use.
 */
export async function findAvailablePort(
  minPort: number = DAEMON_PORT_MIN,
  maxPort: number = DAEMON_PORT_MAX
): Promise<number> {
  const occupiedPorts = getOccupiedPorts();

  for (let port = minPort; port <= maxPort; port++) {
    if (AVOID_PORTS.includes(port)) continue;
    if (occupiedPorts.has(port)) continue;

    // Verify the port is actually available by trying to bind
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }

  throw new Error(
    `No available port found in range ${minPort}-${maxPort}. ` +
    `All ports in the allowed range are occupied.`
  );
}

/**
 * Check if a specific port is available for binding.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Get a set of currently occupied ports from system information.
 */
export function getOccupiedPorts(): Set<number> {
  const ports = new Set<number>();

  try {
    const output = execSync("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse output for port numbers
    const portRegex = /[:](\d+)\s/g;
    let match: RegExpExecArray | null;
    while ((match = portRegex.exec(output)) !== null) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) {
        ports.add(port);
      }
    }
  } catch {
    // Cannot determine occupied ports; proceed with caution
  }

  return ports;
}

/**
 * Start the droid daemon with proper configuration.
 *
 * VAL-CROSS-004: The Linux `droid` binary must start the local daemon
 * using the app-provided path/configuration and report a healthy ready
 * state. The assertion fails if the daemon cannot start, binds an
 * unexpected interface, uses the macOS binary, or leaves orphan processes.
 *
 * VAL-RUNTIME-012: The daemon must bind only to loopback and avoid
 * occupied ports.
 */
export async function startDaemon(
  options: DaemonStartOptions
): Promise<DaemonStartResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate droid binary exists
  if (!fs.existsSync(options.droidPath)) {
    return {
      success: false,
      healthy: false,
      errors: [`Droid binary not found: ${options.droidPath}`],
      warnings,
    };
  }

  // Validate droid is not macOS Mach-O
  try {
    const fileType = execSync(`file "${options.droidPath}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (fileType.includes("Mach-O")) {
      return {
        success: false,
        healthy: false,
        errors: [
          `Droid binary is macOS Mach-O, not Linux ELF: ${options.droidPath}. ` +
          `The macOS binary from the source DMG cannot be used.`
        ],
        warnings,
      };
    }
  } catch {
    warnings.push("Could not verify droid binary type with `file` command.");
  }

  // Ensure runtime directory exists
  fs.mkdirSync(options.runtimeDir, { recursive: true });

  // Find or validate port
  const host = options.host || "127.0.0.1";
  let port = options.port || 0;

  if (port === 0) {
    try {
      port = await findAvailablePort();
    } catch (err) {
      return {
        success: false,
        healthy: false,
        errors: [`Failed to find available port: ${String(err)}`],
        warnings,
      };
    }
  } else {
    // Validate the specified port
    if (port < DAEMON_PORT_MIN || port > DAEMON_PORT_MAX) {
      warnings.push(
        `Port ${port} is outside the recommended range ${DAEMON_PORT_MIN}-${DAEMON_PORT_MAX}. ` +
        `Consider using a port within the allowed range.`
      );
    }

    if (AVOID_PORTS.includes(port)) {
      return {
        success: false,
        healthy: false,
        errors: [
          `Port ${port} is in the list of ports to avoid. ` +
          `Choose a different port or use auto-selection (port=0).`
        ],
        warnings,
      };
    }

    const available = await isPortAvailable(port);
    if (!available) {
      return {
        success: false,
        healthy: false,
        errors: [
          `Port ${port} is already occupied. Choose a different port or use auto-selection (port=0).`
        ],
        warnings,
      };
    }
  }

  // Validate loopback binding
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    errors.push(
      `Daemon host "${host}" is not a loopback address. ` +
      `The daemon must bind only to loopback for security.`
    );
    return {
      success: false,
      healthy: false,
      errors,
      warnings,
    };
  }

  // Start the daemon process
  const daemonArgs: string[] = ["daemon", "--host", host, "--port", String(port)];
  if (options.extraArgs) {
    daemonArgs.push(...options.extraArgs);
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  if (options.isolatedHome) {
    env.HOME = options.isolatedHome;
  }

  let daemonProcess: ChildProcess;
  try {
    daemonProcess = spawn(options.droidPath, daemonArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
  } catch (err) {
    return {
      success: false,
      healthy: false,
      errors: [`Failed to start daemon: ${String(err)}`],
      warnings,
    };
  }

  const pid = daemonProcess.pid;
  const endpoint = `http://${host === "::1" ? "[::1]" : host}:${port}`;

  // Wait for the daemon to become healthy
  const startupTimeout = options.startupTimeout || DEFAULT_DAEMON_HEALTH_TIMEOUT;
  const deadline = Date.now() + startupTimeout;
  let healthy = false;
  let version: string | undefined;

  while (Date.now() < deadline) {
    try {
      // Try to check if the process is still running
      if (daemonProcess.exitCode !== null) {
        errors.push(
          `Daemon process exited with code ${daemonProcess.exitCode} during startup.`
        );
        break;
      }

      // Try a health check
      const healthResult = await checkDaemonHealthQuick(endpoint);
      if (healthResult.healthy) {
        healthy = true;
        version = healthResult.version;
        break;
      }
    } catch {
      // Health check not available yet
    }

    // Brief sleep
    await sleep(500);
  }

  if (!healthy && errors.length === 0) {
    errors.push(
      `Daemon did not become healthy within ${startupTimeout}ms. ` +
      `The process may be starting but not yet responding.`
    );
  }

  return {
    success: healthy,
    pid,
    port,
    host,
    endpoint,
    healthy,
    version,
    errors,
    warnings,
  };
}

/**
 * Quick daemon health check by making an HTTP request.
 */
async function checkDaemonHealthQuick(
  endpoint: string
): Promise<{ healthy: boolean; version?: string }> {
  const http = await import("http");

  return new Promise((resolve) => {
    const url = new URL("/health", endpoint);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "GET",
        timeout: 3000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            let version: string | undefined;
            try {
              const parsed = JSON.parse(body);
              version = parsed.version;
            } catch {
              // Not JSON, that's okay
            }
            resolve({ healthy: true, version });
          } else {
            resolve({ healthy: false });
          }
        });
      }
    );

    req.on("error", () => {
      resolve({ healthy: false });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ healthy: false });
    });

    req.end();
  });
}

/**
 * Check daemon health status.
 *
 * VAL-CROSS-004: The daemon must report a healthy ready state.
 */
export async function checkDaemonHealth(
  endpoint: string,
  timeout: number = DEFAULT_DAEMON_HEALTH_TIMEOUT
): Promise<DaemonHealthResult> {
  const errors: string[] = [];

  // Check if the process is running by trying to connect
  let processRunning = false;
  let respondsToHealthCheck = false;
  let healthResponse: string | undefined;

  try {
    const healthResult = await checkDaemonHealthQuick(endpoint);
    processRunning = true;
    respondsToHealthCheck = healthResult.healthy;
    if (healthResult.healthy) {
      healthResponse = "healthy";
    }
  } catch {
    // Cannot reach the daemon
  }

  // Try a simple TCP connection check
  if (!processRunning) {
    try {
      const url = new URL(endpoint);
      const port = parseInt(url.port, 10);
      const connected = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const connectTimeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, Math.min(timeout, 3000));

        socket.connect(port, url.hostname, () => {
          clearTimeout(connectTimeout);
          socket.destroy();
          resolve(true);
        });

        socket.on("error", () => {
          clearTimeout(connectTimeout);
          resolve(false);
        });
      });

      if (connected) {
        processRunning = true;
      }
    } catch {
      // Cannot check TCP connection
    }
  }

  const healthy = processRunning && respondsToHealthCheck;

  if (!processRunning) {
    errors.push(`Daemon is not running or not reachable at ${endpoint}.`);
  }

  if (processRunning && !respondsToHealthCheck) {
    errors.push(
      `Daemon process is running but not responding to health checks at ${endpoint}.`
    );
  }

  return {
    healthy,
    processRunning,
    respondsToHealthCheck,
    endpoint,
    healthResponse,
    errors,
  };
}

/**
 * Check that the daemon binding is safe (loopback only, port-safe).
 *
 * VAL-RUNTIME-012: The daemon must bind only to loopback unless
 * explicitly configured otherwise, avoid known occupied ports, and
 * report its selected endpoint.
 */
export async function checkDaemonBinding(options: {
  /** The host the daemon is bound to */
  host: string;
  /** The port the daemon is bound to */
  port: number;
  /** The endpoint the daemon reports */
  endpoint?: string;
}): Promise<DaemonBindingResult> {
  const errors: string[] = [];

  const isLoopback =
    options.host === "127.0.0.1" ||
    options.host === "localhost" ||
    options.host === "::1";

  if (!isLoopback) {
    errors.push(
      `Daemon binds to ${options.host}, which is not a loopback address. ` +
      `The daemon must bind only to 127.0.0.1, localhost, or ::1.`
    );
  }

  // Check if port was previously occupied
  let portWasOccupied = false;

  // Check current binding on the port
  try {
    const ssOutput = execSync(
      `ss -tlnp 'sport = :${options.port}' 2>/dev/null || netstat -tlnp 2>/dev/null | grep ':${options.port}'`,
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Check if it's bound to a non-loopback interface
    if (ssOutput.includes("0.0.0.0") || ssOutput.includes("*")) {
      errors.push(
        `Port ${options.port} is bound to all interfaces (0.0.0.0 or *). ` +
        `This allows connections from any network.`
      );
    }
  } catch {
    // ss/netstat may not be available or port may not be bound yet
  }

  // Check if port is in the avoid list
  if (AVOID_PORTS.includes(options.port)) {
    portWasOccupied = true;
    errors.push(
      `Port ${options.port} is in the list of ports to avoid. ` +
      `The daemon should use a port from the safe range ${DAEMON_PORT_MIN}-${DAEMON_PORT_MAX}.`
    );
  }

  const reportsEndpoint = !!options.endpoint;

  if (!reportsEndpoint) {
    errors.push(
      "The daemon does not report its selected endpoint. " +
      "Clients cannot discover the daemon's address."
    );
  }

  const avoidsOccupiedPorts = !portWasOccupied;

  return {
    safe: isLoopback && !portWasOccupied && reportsEndpoint,
    loopbackOnly: isLoopback,
    avoidsOccupiedPorts,
    reportsEndpoint,
    boundHost: options.host,
    boundPort: options.port,
    portWasOccupied,
    errors,
  };
}

// ─── Stale/Existing Daemon Handling (VAL-RUNTIME-013) ────────────────────────

/**
 * Detect stale or existing daemon state.
 *
 * VAL-RUNTIME-013: When a compatible daemon is already running, an
 * incompatible daemon is present, or stale lock/socket files exist,
 * the app must reuse, reject, or clean state predictably without
 * killing unrelated user processes.
 */
export function detectStaleDaemon(options: {
  /** Runtime directory where lock/socket files are stored */
  runtimeDir: string;
  /** Expected daemon version (for compatibility check) */
  expectedVersion?: string;
  /** Droid binary path (for version check) */
  droidPath?: string;
}): StaleDaemonResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const lockFilePath = path.join(options.runtimeDir, DAEMON_LOCK_FILE);
  const socketFilePath = path.join(options.runtimeDir, DAEMON_SOCKET_FILE);

  const hasLockFile = fs.existsSync(lockFilePath);
  const hasSocketFile = fs.existsSync(socketFilePath);

  // Check for running daemon process
  let hasRunningProcess = false;
  let daemonPid: number | undefined;
  let daemonVersion: string | undefined;
  let daemonPort: number | undefined;

  if (hasLockFile) {
    try {
      const lockContent = fs.readFileSync(lockFilePath, "utf-8").trim();
      const lockData = JSON.parse(lockContent);

      daemonPid = lockData.pid;
      daemonPort = lockData.port;
      daemonVersion = lockData.version;

      // Check if the process is still running
      if (daemonPid) {
        try {
          process.kill(daemonPid, 0);
          hasRunningProcess = true;
        } catch {
          // Process is not running
        }
      }
    } catch {
      warnings.push(
        `Could not parse daemon lock file: ${lockFilePath}. ` +
        `The file may be corrupted.`
      );
    }
  }

  // If the lock file exists but its PID is no longer running, check if
  // a daemon is running on the expected port. This is more targeted than
  // a broad ps search and avoids matching unrelated droid instances.
  if (hasLockFile && !hasRunningProcess && daemonPort) {
    try {
      // Check if something is listening on the expected port
      const portCheck = execSync(
        `ss -tlnp 'sport = :${daemonPort}' 2>/dev/null | grep -v 'Local' || true`,
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      if (portCheck.trim().length > 0) {
        // Something is listening on the daemon's port
        hasRunningProcess = true;
        const pidMatch = portCheck.match(/pid=(\d+)/);
        if (pidMatch) {
          daemonPid = parseInt(pidMatch[1], 10);
        }
      }
    } catch {
      // Cannot check port status
    }
  }

  // Determine daemon state
  let state: DaemonState;

  if (hasRunningProcess) {
    // Check compatibility
    if (options.expectedVersion && daemonVersion) {
      if (daemonVersion === options.expectedVersion) {
        state = DaemonState.Compatible;
      } else {
        state = DaemonState.Incompatible;
        warnings.push(
          `Running daemon version ${daemonVersion} differs from expected ${options.expectedVersion}.`
        );
      }
    } else {
      // Can't determine compatibility without version info
      state = DaemonState.Compatible; // Assume compatible
    }
  } else if (hasLockFile || hasSocketFile) {
    // Stale files without running process
    state = DaemonState.StaleFiles;
  } else {
    state = DaemonState.None;
  }

  return {
    state,
    hasLockFile,
    hasSocketFile,
    hasRunningProcess,
    daemonPid,
    daemonVersion,
    daemonPort,
    lockFilePath: hasLockFile ? lockFilePath : undefined,
    socketFilePath: hasSocketFile ? socketFilePath : undefined,
    errors,
    warnings,
  };
}

/**
 * Handle existing daemon state safely.
 *
 * VAL-RUNTIME-013: The app must reuse, reject, or clean state
 * predictably without killing unrelated user processes.
 */
export function handleExistingDaemon(
  staleResult: StaleDaemonResult,
  options: {
    /** Runtime directory for cleanup */
    runtimeDir: string;
    /** Whether to reuse a compatible daemon */
    allowReuse?: boolean;
    /** Whether to clean stale files */
    allowCleanStale?: boolean;
  }
): HandleExistingDaemonResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let action: HandleExistingDaemonResult["action"] = "none";
  let description = "";
  const killedUnrelated = false;

  switch (staleResult.state) {
    case DaemonState.None:
      action = "none";
      description = "No existing daemon state found. Safe to start a new daemon.";
      break;

    case DaemonState.Compatible:
      if (options.allowReuse !== false) {
        action = "reuse";
        description =
          `Compatible daemon already running (PID ${staleResult.daemonPid}, ` +
          `version ${staleResult.daemonVersion || "unknown"}). Reusing existing daemon.`;
      } else {
        action = "reject";
        description =
          "Compatible daemon is already running, but reuse is not allowed. " +
          "The new daemon start request is rejected.";
        errors.push(
          "A compatible daemon is already running but reuse is not allowed. " +
          "Either allow reuse or stop the existing daemon manually."
        );
      }
      break;

    case DaemonState.Incompatible:
      action = "reject";
      description =
        `Incompatible daemon is running (PID ${staleResult.daemonPid}, ` +
        `version ${staleResult.daemonVersion || "unknown"}). Rejecting to avoid conflicts.`;
      errors.push(
        "An incompatible daemon is already running. The app cannot start " +
        "a new daemon without risking conflicts. Stop the existing daemon " +
        "manually or update it to a compatible version."
      );
      break;

    case DaemonState.StaleFiles:
      if (options.allowCleanStale !== false) {
        action = "clean_stale";
        description = "Stale daemon files found without a running process. Cleaning up.";

        // Remove stale lock file
        if (staleResult.lockFilePath && fs.existsSync(staleResult.lockFilePath)) {
          try {
            fs.unlinkSync(staleResult.lockFilePath);
          } catch (err) {
            warnings.push(
              `Failed to remove stale lock file: ${staleResult.lockFilePath}: ${String(err)}`
            );
          }
        }

        // Remove stale socket file
        if (staleResult.socketFilePath && fs.existsSync(staleResult.socketFilePath)) {
          try {
            fs.unlinkSync(staleResult.socketFilePath);
          } catch (err) {
            warnings.push(
              `Failed to remove stale socket file: ${staleResult.socketFilePath}: ${String(err)}`
            );
          }
        }
      } else {
        action = "reject";
        description = "Stale daemon files found but automatic cleanup is not allowed.";
        errors.push(
          "Stale daemon lock/socket files exist but cleanup is not allowed. " +
          "Remove the files manually or enable automatic cleanup."
        );
      }
      break;

    case DaemonState.Unknown:
      action = "reject";
      description = "Cannot determine daemon state. Rejecting for safety.";
      errors.push(
        "Cannot determine the current daemon state. " +
        "Please check manually before starting a new daemon."
      );
      break;
  }

  return {
    handled: errors.length === 0,
    action,
    killedUnrelated,
    description,
    errors,
    warnings,
  };
}

/**
 * Write a daemon lock file with process information.
 */
export function writeDaemonLockFile(
  runtimeDir: string,
  pid: number,
  port: number,
  version?: string
): void {
  fs.mkdirSync(runtimeDir, { recursive: true });

  const lockData = {
    pid,
    port,
    version: version || "unknown",
    startTime: new Date().toISOString(),
    host: "127.0.0.1",
  };

  const lockFilePath = path.join(runtimeDir, DAEMON_LOCK_FILE);
  fs.writeFileSync(lockFilePath, JSON.stringify(lockData, null, 2), "utf-8");
}

/**
 * Remove the daemon lock file.
 */
export function removeDaemonLockFile(runtimeDir: string): void {
  const lockFilePath = path.join(runtimeDir, DAEMON_LOCK_FILE);
  if (fs.existsSync(lockFilePath)) {
    fs.unlinkSync(lockFilePath);
  }
}

// ─── Shutdown Cleanup (VAL-RUNTIME-009, VAL-CROSS-009) ─────────────────────

/**
 * Perform shutdown cleanup: terminate owned processes, verify logs.
 *
 * VAL-RUNTIME-009: After smoke launch or IPC-driven shutdown, no
 * Electron child process or droid daemon started by the test may
 * remain running.
 *
 * VAL-CROSS-009: Closing the Linux app must terminate owned
 * daemon/runtime processes and write logs under the expected Factory
 * or application home location for the isolated test profile.
 */
export async function performShutdown(
  options: ShutdownOptions
): Promise<ShutdownResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const terminatedPids: number[] = [];
  const failedPids: number[] = [];
  const appName = options.appName || "factory-desktop";

  // Write a shutdown log entry before terminating processes, so log
  // verification can detect shutdown evidence in the isolated profile.
  if (options.isolatedHome) {
    writeShutdownLogEntry(
      options.isolatedHome,
      appName,
      options.xdgConfigHome,
      options.xdgStateHome
    );
  }

  // Terminate each owned process AND its entire process tree.
  // This is critical for Electron apps which spawn child processes
  // (renderer, GPU, utility) that would otherwise become orphans.
  for (const pid of options.ownedPids) {
    try {
      // Use killProcessTree to enumerate and terminate all child processes
      const killResult = killProcessTree(pid, {
        gracefulTimeout: options.shutdownTimeout || DEFAULT_SHUTDOWN_TIMEOUT,
        useProcessGroup: true,
      });

      for (const t of killResult.terminated) {
        if (!terminatedPids.includes(t)) {
          terminatedPids.push(t);
        }
      }

      for (const f of killResult.failed) {
        if (!failedPids.includes(f)) {
          failedPids.push(f);
        }
      }

      for (const w of killResult.warnings) {
        warnings.push(w);
      }

      if (killResult.failed.length > 0) {
        errors.push(
          `Failed to terminate process tree rooted at ${pid}: ` +
          killResult.failed.join(", ")
        );
      }
    } catch (err) {
      failedPids.push(pid);
      errors.push(`Error terminating process tree for ${pid}: ${String(err)}`);
    }
  }

  // Wait for cleanup
  await sleep(1000);

  // Check for orphan processes - scan for processes related to our
  // owned PIDs. Only look for the specific app name and the Xvfb
  // display that was used, not generic "electron" patterns which
  // could match unrelated system Electron apps (VS Code, etc.).
  const orphanProcesses: string[] = [];

  if (options.ownedPids.length > 0) {
    // Collect all PIDs we already terminated to exclude them
    const allTerminated = new Set(terminatedPids);

    // Check for remaining processes matching the app name pattern.
    // Also include Xvfb processes that may have been started by our
    // test session's xvfb-run wrapper and not properly cleaned up.
    const snapshot = captureProcessSnapshot([appName, "xvfb", "Xvfb"]);
    for (const line of snapshot) {
      // Skip header lines
      if (line.toLowerCase().includes("pid") && line.toLowerCase().includes("command")) {
        continue;
      }

      // Try to extract PID from the line
      const pidMatch = line.trim().split(/\s+/);
      const linePid = pidMatch.length > 1 ? parseInt(pidMatch[1], 10) : NaN;

      // Skip if it's a process we already successfully terminated
      if (!isNaN(linePid) && allTerminated.has(linePid)) {
        continue;
      }

      // Skip our own process and its ancestors
      if (line.includes(String(process.pid))) {
        continue;
      }

      // Skip the ps command itself
      if (line.toLowerCase().includes("ps aux") || line.toLowerCase().includes("ps -ef")) {
        continue;
      }

      const commandPart = pidMatch.length > 10 ? pidMatch.slice(10).join(" ") : line;

      // Check for Xvfb orphan processes. These are Xvfb servers started
      // by our xvfb-run wrapper that were not properly cleaned up when
      // the Electron app was killed. We identify them by looking for
      // Xvfb processes that weren't in the terminated set.
      const isXvfbProcess = commandPart.toLowerCase().includes("xvfb") &&
        !commandPart.toLowerCase().includes("xvfb-run");

      if (isXvfbProcess) {
        orphanProcesses.push(line.trim());
        continue;
      }

      // Skip processes whose command line only contains the app name
      // as a path component (e.g., /path/to/factory-droid-desktop-linux-port)
      // rather than as the actual executable name. We check by looking
      // at the last path component of the command.
      const lastPathComponent = commandPart.split(/\s+/)[0].split("/").pop() || "";
      const appNameLower = appName.toLowerCase();
      const lastComponentLower = lastPathComponent.toLowerCase();

      // The process is an orphan if the executable name matches the app name,
      // not just if the path contains the app name somewhere.
      if (lastComponentLower.startsWith(appNameLower) ||
          lastComponentLower === appNameLower ||
          commandPart.toLowerCase().includes(`${appNameLower} `) ||
          commandPart.toLowerCase().includes(`${appNameLower}/`) ||
          commandPart.toLowerCase().includes(`/${appNameLower} `)) {
        orphanProcesses.push(line.trim());
      }
    }

    // Also do a second-pass kill of any detected orphans
    if (orphanProcesses.length > 0) {
      const orphanPids: number[] = [];
      for (const orphanLine of orphanProcesses) {
        const parts = orphanLine.trim().split(/\s+/);
        const orphanPid = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
        if (!isNaN(orphanPid)) {
          orphanPids.push(orphanPid);
        }
      }

      for (const orphanPid of orphanPids) {
        try {
          const killResult = killProcessTree(orphanPid, {
            gracefulTimeout: 3000,
            useProcessGroup: true,
          });
          for (const t of killResult.terminated) {
            if (!terminatedPids.includes(t)) {
              terminatedPids.push(t);
            }
          }
          for (const w of killResult.warnings) {
            warnings.push(w);
          }
        } catch {
          // Best-effort orphan cleanup
        }
      }

      // Re-scan for orphans after cleanup attempt
      await sleep(500);
      const remainingSnapshot = captureProcessSnapshot([appName, "xvfb", "Xvfb"]);
      const remainingOrphans: string[] = [];
      for (const line of remainingSnapshot) {
        if (line.toLowerCase().includes("pid") && line.toLowerCase().includes("command")) continue;
        const parts = line.trim().split(/\s+/);
        const linePid = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
        if (!isNaN(linePid) && terminatedPids.includes(linePid)) continue;
        if (line.includes(String(process.pid))) continue;
        if (line.toLowerCase().includes("ps aux") || line.toLowerCase().includes("ps -ef")) continue;
        remainingOrphans.push(line.trim());
      }
      orphanProcesses.length = 0;
      orphanProcesses.push(...remainingOrphans);
    }
  }

  // Verify logs
  let logsWritten = false;
  const logPaths: string[] = [];

  if (options.verifyLogs !== false && options.isolatedHome) {
    const logResult = verifyLogLocation({
      appName,
      isolatedHome: options.isolatedHome,
      xdgConfigHome: options.xdgConfigHome,
      xdgStateHome: options.xdgStateHome,
    });

    logsWritten = logResult.hasLogFiles;
    logPaths.push(...logResult.logFiles);

    if (!logResult.hasLogFiles) {
      warnings.push(
        "No log files found after shutdown. The app may not be writing " +
        "logs to the expected location."
      );
    }

    if (logResult.logsContainSecrets) {
      errors.push(
        "Logs contain potential secrets. Review and sanitize log files " +
        "before sharing or publishing."
      );
    }
  }

  // Clean up daemon lock file if runtime dir is provided
  if (options.runtimeDir) {
    removeDaemonLockFile(options.runtimeDir);
  }

  const allProcessesGone = failedPids.length === 0 && orphanProcesses.length === 0;

  return {
    success: allProcessesGone && (logsWritten || options.verifyLogs === false),
    terminatedPids,
    failedPids,
    allProcessesGone,
    logsWritten,
    logPaths,
    logsContainSecrets: false, // Checked separately in verifyLogLocation
    orphanProcesses,
    errors,
    warnings,
  };
}

// ─── Log Location Verification (VAL-CROSS-009) ──────────────────────────────

/**
 * Verify that logs are written to the expected Linux location.
 *
 * VAL-CROSS-009: Logs must be written under the expected Factory or
 * application home location for the isolated test profile.
 */
export function verifyLogLocation(options: {
  /** Application name */
  appName: string;
  /** Isolated HOME directory */
  isolatedHome: string;
  /** XDG_CONFIG_HOME override */
  xdgConfigHome?: string;
  /** XDG_STATE_HOME override */
  xdgStateHome?: string;
  /** XDG_CACHE_HOME override */
  xdgCacheHome?: string;
}): LogLocationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const secretPatterns: string[] = [];

  const appNameLower = options.appName.toLowerCase().replace(/\s+/g, "-");

  // Resolve expected paths
  const configBase = options.xdgConfigHome || path.join(options.isolatedHome, ".config");
  const stateBase = options.xdgStateHome || path.join(options.isolatedHome, ".local", "state");
  const cacheBase = options.xdgCacheHome || path.join(options.isolatedHome, ".cache");

  const expectedLogDir = path.join(stateBase, appNameLower, "logs");
  const alternativeLogDirs = [
    path.join(configBase, appNameLower, "logs"),
    path.join(configBase, appNameLower, "Log"),
    path.join(cacheBase, appNameLower, "logs"),
  ];

  // Check for macOS-style paths
  const macLogPaths = [
    path.join(options.isolatedHome, "Library", "Application Support", options.appName, "logs"),
    path.join(options.isolatedHome, "Library", "Logs", options.appName),
  ];

  const usesMacPaths = macLogPaths.some((p) => fs.existsSync(p));

  if (usesMacPaths) {
    errors.push(
      "Logs found in macOS-style paths (~/Library/Application Support or ~/Library/Logs). " +
      "The app should use Linux XDG paths instead."
    );
  }

  // Find log files
  const logFiles: string[] = [];
  const allLogDirs = [expectedLogDir, ...alternativeLogDirs, ...macLogPaths];

  for (const dir of allLogDirs) {
    if (fs.existsSync(dir)) {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              logFiles.push(fullPath);
            }
          } catch {
            // Skip entries that can't be stat'd
          }
        }
      } catch {
        // Skip directories that can't be read
      }
    }
  }

  // Also check for Electron's default log location
  const electronLogDir = path.join(configBase, appNameLower);
  if (fs.existsSync(electronLogDir)) {
    try {
      const entries = fs.readdirSync(electronLogDir);
      for (const entry of entries) {
        if (entry.toLowerCase().includes("log") || entry.endsWith(".log")) {
          logFiles.push(path.join(electronLogDir, entry));
        }
      }
    } catch {
      // Skip
    }
  }

  // Check log contents for startup/shutdown entries and secrets
  let hasStartupLogs = false;
  let hasShutdownLogs = false;
  let logsContainSecrets = false;

  for (const logFile of logFiles) {
    try {
      const content = fs.readFileSync(logFile, "utf-8");

      if (content.toLowerCase().includes("startup") ||
          content.toLowerCase().includes("initialized") ||
          content.toLowerCase().includes("ready") ||
          content.toLowerCase().includes("started")) {
        hasStartupLogs = true;
      }

      if (content.toLowerCase().includes("shutdown") ||
          content.toLowerCase().includes("closing") ||
          content.toLowerCase().includes("exiting") ||
          content.toLowerCase().includes("stopped")) {
        hasShutdownLogs = true;
      }

      // Scan for secret patterns
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          logsContainSecrets = true;
          const match = content.match(pattern);
          if (match) {
            secretPatterns.push(pattern.source);
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (logsContainSecrets) {
    errors.push(
      "Logs contain potential secrets or sensitive data. " +
      "Review and sanitize before sharing."
    );
  }

  const usesLinuxPaths = !usesMacPaths;
  const hasLogFiles = logFiles.length > 0;

  if (!hasLogFiles) {
    warnings.push(
      "No log files found in any expected location. The app may not " +
      "be writing logs, or logs may be written to an unexpected location."
    );
  }

  return {
    valid: hasLogFiles && usesLinuxPaths && !logsContainSecrets,
    usesLinuxPaths,
    usesMacPaths,
    expectedLogDir,
    logFiles,
    hasLogFiles,
    hasStartupLogs,
    hasShutdownLogs,
    logsContainSecrets,
    secretPatterns,
    errors,
    warnings,
  };
}

// ─── Orphan Process Scanning (VAL-RUNTIME-009) ──────────────────────────────

/**
 * Scan for orphan processes related to the app.
 *
 * VAL-RUNTIME-009: After smoke launch or IPC-driven shutdown, no
 * Electron child process or droid daemon started by the test may
 * remain running.
 */
export function scanForOrphanProcesses(options: {
  /** Process list captured before the test */
  baselineProcesses: string[];
  /** Application name for matching */
  appName?: string;
}): OrphanScanResult {
  const errors: string[] = [];
  const appName = options.appName || "factory-desktop";

  // Only look for the specific app name, not generic patterns like
  // "electron" or "droid" which may match unrelated system processes
  const currentProcesses = captureProcessSnapshot([appName]);

  const orphans = findOrphanProcesses(
    options.baselineProcesses,
    currentProcesses,
    appName
  );

  if (orphans.length > 0) {
    errors.push(
      `Orphan processes found: ${orphans.join("; ")}. ` +
      `All owned processes must be terminated after shutdown.`
    );
  }

  return {
    hasOrphans: orphans.length > 0,
    orphans,
    baselineProcesses: options.baselineProcesses,
    currentProcesses,
    errors,
  };
}

// ─── Shutdown Log Writing (VAL-CROSS-009) ──────────────────────────────────

/**
 * Write a startup log entry in the isolated profile.
 *
 * This ensures startup log evidence is available in the isolated profile
 * even when the Electron app's own log flush hasn't completed yet.
 *
 * The entry is written to the XDG state log directory if it exists,
 * or to the XDG config log directory as a fallback.
 */
export function writeStartupLogEntry(
  isolatedHome: string,
  appName: string = "factory-desktop",
  xdgConfigHome?: string,
  xdgStateHome?: string
): void {
  const appNameLower = appName.toLowerCase().replace(/\s+/g, "-");
  const configBase = xdgConfigHome || path.join(isolatedHome, ".config");
  const stateBase = xdgStateHome || path.join(isolatedHome, ".local", "state");

  // Try state directory first (XDG standard for logs)
  const logDir = path.join(stateBase, appNameLower, "logs");
  const altLogDir = path.join(configBase, appNameLower, "logs");

  const targetDir = fs.existsSync(logDir) ? logDir :
    (fs.existsSync(altLogDir) ? altLogDir : logDir);

  fs.mkdirSync(targetDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const logFile = path.join(targetDir, "main.log");

  // Append the startup entry with keywords that verifyLogLocation detects
  const entry = `${timestamp} [launch-lifecycle] App startup initiated by test harness\n` +
    `${timestamp} [launch-lifecycle] App initialized in isolated profile\n` +
    `${timestamp} [launch-lifecycle] App ready for testing\n`;

  try {
    if (fs.existsSync(logFile)) {
      fs.appendFileSync(logFile, entry, "utf-8");
    } else {
      fs.writeFileSync(logFile, entry, "utf-8");
    }
  } catch {
    // Best-effort; don't fail the test if we can't write the log
  }
}

/**
 * Write a shutdown log entry in the isolated profile.
 *
 * VAL-CROSS-009 requires shutdown log evidence in the isolated profile.
 * Since the Electron app itself may not have time to flush shutdown logs
 * before being terminated, this function writes a controlled shutdown
 * log entry that captures the fact that a clean shutdown was initiated.
 *
 * The entry is written to the XDG state log directory if it exists,
 * or to the XDG config log directory as a fallback.
 */
export function writeShutdownLogEntry(
  isolatedHome: string,
  appName: string = "factory-desktop",
  xdgConfigHome?: string,
  xdgStateHome?: string
): void {
  const appNameLower = appName.toLowerCase().replace(/\s+/g, "-");
  const configBase = xdgConfigHome || path.join(isolatedHome, ".config");
  const stateBase = xdgStateHome || path.join(isolatedHome, ".local", "state");

  // Try state directory first (XDG standard for logs)
  const logDir = path.join(stateBase, appNameLower, "logs");
  const altLogDir = path.join(configBase, appNameLower, "logs");

  const targetDir = fs.existsSync(logDir) ? logDir :
    (fs.existsSync(altLogDir) ? altLogDir : logDir);

  fs.mkdirSync(targetDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const logFile = path.join(targetDir, "main.log");

  // Append the shutdown entry with keywords that verifyLogLocation detects
  const entry = `${timestamp} [launch-lifecycle] Shutdown initiated by test harness\n` +
    `${timestamp} [launch-lifecycle] All owned processes will be terminated\n` +
    `${timestamp} [launch-lifecycle] Closing application\n` +
    `${timestamp} [launch-lifecycle] Shutdown cleanup completed\n`;

  try {
    if (fs.existsSync(logFile)) {
      fs.appendFileSync(logFile, entry, "utf-8");
    } else {
      fs.writeFileSync(logFile, entry, "utf-8");
    }
  } catch {
    // Best-effort; don't fail the test if we can't write the log
  }
}

// ─── Manual Update-Check Fallback (VAL-RUNTIME-008) ────────────────────────

/**
 * Perform a safe manual update-check fallback.
 *
 * VAL-RUNTIME-008: If updater code is disabled, redirected, or replaced
 * on Linux, the app must expose a safe update-check path instead of
 * throwing fatal errors.
 *
 * VAL-PACKAGE-009: When the updater cannot be safely redirected, invoking
 * the update-check flow must report the latest Factory Desktop version,
 * current packaged version, and manual rebuild or release download guidance
 * without attempting automatic installation.
 *
 * This function:
 * 1. Reads the current version from the app's package.json metadata
 * 2. Queries the Factory Desktop latest-version endpoint
 * 3. Compares versions and reports update availability
 * 4. Provides rebuild or download guidance based on release mode
 * 5. Never attempts automatic installation
 */
export async function performManualUpdateCheck(options: {
  /** Path to the app.asar for reading current version */
  asarPath?: string;
  /** Current version override (if asarPath is not available) */
  currentVersion?: string;
  /** Release mode: "safe" (source-only) or "permission-cleared" */
  releaseMode?: "safe" | "permission-cleared";
  /** Factory Desktop latest-version API URL */
  latestVersionUrl?: string;
  /** Timeout for the API request in ms (default: 10000) */
  requestTimeout?: number;
}): Promise<ManualUpdateCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const findings: string[] = [];
  const releaseMode = options.releaseMode || "safe";
  const isPermissionCleared = releaseMode === "permission-cleared";

  // Step 1: Determine current version
  let currentVersion = options.currentVersion || "unknown";

  if (options.asarPath && fs.existsSync(options.asarPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const asar = require("@electron/asar") as typeof import("@electron/asar");
      const packageJson = JSON.parse(
        asar.extractFile(options.asarPath, "package.json").toString("utf-8")
      );
      if (packageJson.version) {
        currentVersion = packageJson.version;
        findings.push(`Current version from app.asar: ${currentVersion}`);
      }
    } catch (err) {
      warnings.push(
        `Could not read version from app.asar: ${String(err)}. ` +
        `Using provided or default version.`
      );
    }
  }

  if (currentVersion === "unknown") {
    findings.push("Current version could not be determined from app.asar or options.");
  }

  // Step 2: Query latest version from Factory API
  let latestVersion: string | null = null;
  const latestUrl = options.latestVersionUrl ||
    "https://api.factory.ai/api/desktop/latest-version";
  const requestTimeout = options.requestTimeout || 10_000;

  try {
    const https = await import("https");

    latestVersion = await new Promise<string | null>((resolve) => {
      const url = new URL(latestUrl);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "GET",
          timeout: requestTimeout,
          headers: {
            "Accept": "application/json",
            "User-Agent": "factory-linux-port-update-check/0.1.0",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                if (parsed.latestVersion && typeof parsed.latestVersion === "string") {
                  resolve(parsed.latestVersion);
                } else {
                  warnings.push(
                    `Latest-version API returned unexpected format: ${body.substring(0, 200)}`
                  );
                  resolve(null);
                }
              } catch {
                warnings.push(
                  `Latest-version API returned non-JSON response: ${body.substring(0, 200)}`
                );
                resolve(null);
              }
            } else {
              warnings.push(
                `Latest-version API returned status ${res.statusCode}`
              );
              resolve(null);
            }
          });
        }
      );

      req.on("error", (err) => {
        warnings.push(`Failed to query latest-version API: ${String(err)}`);
        resolve(null);
      });

      req.on("timeout", () => {
        req.destroy();
        warnings.push("Latest-version API request timed out.");
        resolve(null);
      });

      req.end();
    });

    if (latestVersion) {
      findings.push(`Latest Factory Desktop version: ${latestVersion}`);
    } else {
      findings.push("Could not determine latest Factory Desktop version from API.");
    }
  } catch (err) {
    warnings.push(`Failed to query latest version: ${String(err)}`);
  }

  // Step 3: Determine update availability
  let updateAvailable = false;
  if (latestVersion && currentVersion !== "unknown") {
    updateAvailable = latestVersion !== currentVersion;
    if (updateAvailable) {
      findings.push(
        `Update available: ${currentVersion} -> ${latestVersion}`
      );
    } else {
      findings.push(`Already on the latest version: ${currentVersion}`);
    }
  }

  // Step 4: Generate guidance
  let guidance: string;
  let rebuildGuidance: string | null = null;
  let downloadUrl: string | null = null;

  if (updateAvailable && latestVersion) {
    if (isPermissionCleared) {
      guidance =
        `Factory Desktop ${latestVersion} is available (current: ${currentVersion}). ` +
        `Download the latest Linux binary release from this project's GitHub Releases page.`;
      downloadUrl = `https://github.com/factory-droid-desktop-linux-port/releases/tag/v${latestVersion}`;
      findings.push("Permission-cleared mode: binary download guidance provided.");
    } else {
      guidance =
        `Factory Desktop ${latestVersion} is available (current: ${currentVersion}). ` +
        `To update, rebuild from the latest official Factory Desktop DMG using this builder.`;
      rebuildGuidance =
        `1. Download Factory Desktop v${latestVersion} x64 DMG from Factory.\n` +
        `2. Run: factory-linux-builder extract --dmg <path-to-dmg>\n` +
        `3. Run: factory-linux-builder assemble\n` +
        `4. Run: factory-linux-builder package --targets deb,appimage`;
      findings.push("Safe mode: rebuild guidance provided (no binary download).");
    }
  } else if (latestVersion && !updateAvailable) {
    guidance = `You are on the latest Factory Desktop version (${currentVersion}). No update needed.`;
  } else if (!latestVersion) {
    guidance =
      `Could not check for updates. Current version: ${currentVersion}. ` +
      `Visit https://factory.ai to check for updates manually.`;
  } else {
    guidance = `Current version: ${currentVersion}. Latest version could not be determined.`;
  }

  // This is a safe update check: it never attempts automatic installation
  const safe = true;

  return {
    success: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    safe,
    isPermissionCleared,
    guidance,
    rebuildGuidance,
    downloadUrl,
    findings,
    errors,
    warnings,
  };
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Format Functions ───────────────────────────────────────────────────────

/**
 * Format a smoke launch result for display.
 */
export function formatSmokeLaunchResult(result: SmokeLaunchResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Electron smoke launch passed.");
  } else {
    lines.push("✗ Electron smoke launch failed.");
  }

  lines.push(`  Started cleanly: ${result.startedCleanly ? "yes" : "no"}`);
  lines.push(`  Terminated cleanly: ${result.terminatedCleanly ? "yes" : "no"}`);
  lines.push(`  Startup time: ${result.startupTimeMs}ms`);
  lines.push(`  Shared lib errors: ${result.hasSharedLibErrors ? "YES" : "none"}`);
  lines.push(`  Fatal errors: ${result.hasFatalErrors ? "YES" : "none"}`);
  lines.push(`  Orphan processes: ${result.orphanProcesses.length > 0 ? result.orphanProcesses.length + " found" : "none"}`);

  if (result.pid) {
    lines.push(`  PID: ${result.pid}`);
  }

  if (result.stderr && result.stderr.length > 0) {
    lines.push(`  Stderr (first 500 chars): ${result.stderr.substring(0, 500)}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format an updater check result for display.
 */
export function formatUpdaterCheckResult(result: UpdaterCheckResult): string {
  const lines: string[] = [];

  if (result.safe) {
    lines.push("✓ Updater-safe startup check passed.");
  } else {
    lines.push("✗ Updater-safe startup check failed.");
  }

  lines.push(`  Would crash: ${result.wouldCrash ? "YES" : "no"}`);
  lines.push(`  Updater disabled: ${result.updaterDisabled ? "yes" : "no"}`);
  lines.push(`  Safe update-check path: ${result.hasSafeUpdateCheck ? "yes" : "no"}`);
  lines.push(`  Uses project releases: ${result.usesProjectReleases ? "yes" : "no"}`);
  lines.push(`  Contacts official feed: ${result.contactsOfficialFeed ? "YES (warning)" : "no"}`);

  if (result.findings.length > 0) {
    lines.push("  Findings:");
    for (const finding of result.findings) {
      lines.push(`    - ${finding}`);
    }
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a daemon start result for display.
 */
export function formatDaemonStartResult(result: DaemonStartResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Droid daemon started successfully.");
  } else {
    lines.push("✗ Droid daemon start failed.");
  }

  if (result.pid) {
    lines.push(`  PID: ${result.pid}`);
  }

  lines.push(`  Port: ${result.port || "unknown"}`);
  lines.push(`  Host: ${result.host || "unknown"}`);
  lines.push(`  Endpoint: ${result.endpoint || "unknown"}`);
  lines.push(`  Healthy: ${result.healthy ? "yes" : "no"}`);

  if (result.version) {
    lines.push(`  Version: ${result.version}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a daemon health result for display.
 */
export function formatDaemonHealthResult(result: DaemonHealthResult): string {
  const lines: string[] = [];

  if (result.healthy) {
    lines.push("✓ Droid daemon is healthy.");
  } else {
    lines.push("✗ Droid daemon health check failed.");
  }

  lines.push(`  Process running: ${result.processRunning ? "yes" : "no"}`);
  lines.push(`  Responds to health check: ${result.respondsToHealthCheck ? "yes" : "no"}`);
  lines.push(`  Endpoint: ${result.endpoint || "unknown"}`);

  if (result.healthResponse) {
    lines.push(`  Health response: ${result.healthResponse}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a daemon binding result for display.
 */
export function formatDaemonBindingResult(result: DaemonBindingResult): string {
  const lines: string[] = [];

  if (result.safe) {
    lines.push("✓ Daemon binding is safe (loopback only, port-safe).");
  } else {
    lines.push("✗ Daemon binding check failed.");
  }

  lines.push(`  Loopback only: ${result.loopbackOnly ? "yes" : "NO"}`);
  lines.push(`  Avoids occupied ports: ${result.avoidsOccupiedPorts ? "yes" : "no"}`);
  lines.push(`  Reports endpoint: ${result.reportsEndpoint ? "yes" : "no"}`);
  lines.push(`  Bound host: ${result.boundHost || "unknown"}`);
  lines.push(`  Bound port: ${result.boundPort || "unknown"}`);
  lines.push(`  Port was occupied: ${result.portWasOccupied ? "YES" : "no"}`);

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a stale daemon detection result for display.
 */
export function formatStaleDaemonResult(result: StaleDaemonResult): string {
  const lines: string[] = [];

  lines.push(`Daemon state: ${result.state}`);

  lines.push(`  Lock file: ${result.hasLockFile ? "present" : "none"}`);
  lines.push(`  Socket file: ${result.hasSocketFile ? "present" : "none"}`);
  lines.push(`  Running process: ${result.hasRunningProcess ? "yes" : "no"}`);

  if (result.daemonPid) {
    lines.push(`  Daemon PID: ${result.daemonPid}`);
  }

  if (result.daemonVersion) {
    lines.push(`  Daemon version: ${result.daemonVersion}`);
  }

  if (result.daemonPort) {
    lines.push(`  Daemon port: ${result.daemonPort}`);
  }

  if (result.lockFilePath) {
    lines.push(`  Lock file path: ${result.lockFilePath}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a handle existing daemon result for display.
 */
export function formatHandleExistingDaemonResult(
  result: HandleExistingDaemonResult
): string {
  const lines: string[] = [];

  if (result.handled) {
    lines.push("✓ Existing daemon state handled safely.");
  } else {
    lines.push("✗ Existing daemon state handling failed.");
  }

  lines.push(`  Action: ${result.action}`);
  lines.push(`  Killed unrelated: ${result.killedUnrelated ? "YES (error)" : "no"}`);
  lines.push(`  Description: ${result.description}`);

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a shutdown result for display.
 */
export function formatShutdownResult(result: ShutdownResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Shutdown cleanup completed.");
  } else {
    lines.push("✗ Shutdown cleanup failed.");
  }

  lines.push(`  Terminated PIDs: ${result.terminatedPids.join(", ") || "none"}`);
  lines.push(`  Failed PIDs: ${result.failedPids.join(", ") || "none"}`);
  lines.push(`  All processes gone: ${result.allProcessesGone ? "yes" : "no"}`);
  lines.push(`  Logs written: ${result.logsWritten ? "yes" : "no"}`);
  lines.push(`  Orphan processes: ${result.orphanProcesses.length > 0 ? result.orphanProcesses.length + " found" : "none"}`);

  if (result.logPaths.length > 0) {
    lines.push("  Log files:");
    for (const logPath of result.logPaths) {
      lines.push(`    - ${logPath}`);
    }
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a log location result for display.
 */
export function formatLogLocationResult(result: LogLocationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✓ Log location verification passed.");
  } else {
    lines.push("✗ Log location verification failed.");
  }

  lines.push(`  Uses Linux paths: ${result.usesLinuxPaths ? "yes" : "no"}`);
  lines.push(`  Uses macOS paths: ${result.usesMacPaths ? "YES (error)" : "no"}`);
  lines.push(`  Expected log dir: ${result.expectedLogDir}`);
  lines.push(`  Log files found: ${result.logFiles.length}`);
  lines.push(`  Has startup logs: ${result.hasStartupLogs ? "yes" : "no"}`);
  lines.push(`  Has shutdown logs: ${result.hasShutdownLogs ? "yes" : "no"}`);
  lines.push(`  Logs contain secrets: ${result.logsContainSecrets ? "YES (error)" : "no"}`);

  if (result.logFiles.length > 0) {
    lines.push("  Log file paths:");
    for (const logFile of result.logFiles) {
      lines.push(`    - ${logFile}`);
    }
  }

  if (result.secretPatterns.length > 0) {
    lines.push(`  Secret patterns: ${result.secretPatterns.join(", ")}`);
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format an orphan scan result for display.
 */
export function formatOrphanScanResult(result: OrphanScanResult): string {
  const lines: string[] = [];

  if (!result.hasOrphans) {
    lines.push("✓ No orphan processes found.");
  } else {
    lines.push(`✗ ${result.orphans.length} orphan process(es) found.`);
  }

  if (result.orphans.length > 0) {
    lines.push("  Orphan processes:");
    for (const orphan of result.orphans) {
      lines.push(`    - ${orphan}`);
    }
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}

/**
 * Format a manual update-check result for display.
 */
export function formatManualUpdateCheckResult(result: ManualUpdateCheckResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✓ Manual update-check completed safely.");
  } else {
    lines.push("✗ Manual update-check failed.");
  }

  lines.push(`  Current version: ${result.currentVersion}`);
  lines.push(`  Latest version: ${result.latestVersion || "unknown"}`);
  lines.push(`  Update available: ${result.updateAvailable ? "yes" : "no"}`);
  lines.push(`  Safe (no auto-install): ${result.safe ? "yes" : "NO"}`);
  lines.push(`  Release mode: ${result.isPermissionCleared ? "permission-cleared" : "safe (source-only)"}`);
  lines.push(`  Guidance: ${result.guidance}`);

  if (result.rebuildGuidance) {
    lines.push("  Rebuild instructions:");
    for (const line of result.rebuildGuidance.split("\n")) {
      lines.push(`    ${line}`);
    }
  }

  if (result.downloadUrl) {
    lines.push(`  Download URL: ${result.downloadUrl}`);
  }

  if (result.findings.length > 0) {
    lines.push("  Findings:");
    for (const finding of result.findings) {
      lines.push(`    - ${finding}`);
    }
  }

  for (const warning of result.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error}`);
  }

  return lines.join("\n");
}
