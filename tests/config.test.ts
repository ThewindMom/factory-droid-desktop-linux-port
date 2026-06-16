/**
 * Tests for configuration and release mode resolution.
 */

import * as path from "path";
import {
  ReleaseMode,
  resolveReleaseMode,
  canPublishBinaries,
  resolveDirs,
  DEFAULT_RELEASE_MODE,
  GENERATED_DIRS,
} from "../src/config";

describe("resolveReleaseMode", () => {
  it("defaults to safe mode", () => {
    expect(resolveReleaseMode()).toBe(ReleaseMode.Safe);
  });

  it("resolves 'safe' string", () => {
    expect(resolveReleaseMode("safe")).toBe(ReleaseMode.Safe);
  });

  it("resolves 'permission-cleared' string", () => {
    expect(resolveReleaseMode("permission-cleared")).toBe(
      ReleaseMode.PermissionCleared
    );
  });

  it("is case-insensitive", () => {
    expect(resolveReleaseMode("Safe")).toBe(ReleaseMode.Safe);
    expect(resolveReleaseMode("PERMISSION-CLEARED")).toBe(
      ReleaseMode.PermissionCleared
    );
  });

  it("trims whitespace", () => {
    expect(resolveReleaseMode("  safe  ")).toBe(ReleaseMode.Safe);
  });

  it("throws for invalid mode", () => {
    expect(() => resolveReleaseMode("invalid")).toThrow(/Invalid release mode/);
  });
});

describe("canPublishBinaries", () => {
  it("refuses in safe mode", () => {
    expect(canPublishBinaries(ReleaseMode.Safe)).toBe(false);
  });

  it("allows in permission-cleared mode", () => {
    expect(canPublishBinaries(ReleaseMode.PermissionCleared)).toBe(true);
  });
});

describe("resolveDirs", () => {
  it("returns absolute paths for all generated directories", () => {
    const dirs = resolveDirs("/tmp/test-project");
    for (const dirName of GENERATED_DIRS) {
      expect(dirs[dirName]).toContain(dirName);
      expect(path.isAbsolute(dirs[dirName])).toBe(true);
    }
  });

  it("all generated directories are in GENERATED_DIRS", () => {
    const dirs = resolveDirs("/tmp/test");
    const dirNames = Object.keys(dirs) as Array<keyof typeof dirs>;
    expect(dirNames.sort()).toEqual(
      Array.from(GENERATED_DIRS).sort()
    );
  });
});

describe("default configuration", () => {
  it("default release mode is safe", () => {
    expect(DEFAULT_RELEASE_MODE).toBe(ReleaseMode.Safe);
  });

  it("generated dirs include work, build, dist", () => {
    expect(GENERATED_DIRS).toContain("work");
    expect(GENERATED_DIRS).toContain("build");
    expect(GENERATED_DIRS).toContain("dist");
  });
});
