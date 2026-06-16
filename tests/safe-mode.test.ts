/**
 * Tests for safe mode / publish guard (VAL-PACKAGE-011).
 *
 * VAL-PACKAGE-011: In default safe mode, publish/release commands must
 * refuse to upload built .deb, AppImage, extracted payloads, or update
 * metadata that implies binary artifact availability. The assertion fails
 * if proprietary-derived artifacts can be published without explicit
 * permission-cleared mode.
 */

import {
  checkPublishAllowed,
  enforceSafeMode,
  describeReleaseMode,
} from "../src/safe-mode";
import { ReleaseMode, DEFAULT_RELEASE_MODE } from "../src/config";

describe("safe mode defaults", () => {
  it("default release mode is safe", () => {
    expect(DEFAULT_RELEASE_MODE).toBe(ReleaseMode.Safe);
  });

  it("safe mode description mentions source-only", () => {
    const desc = describeReleaseMode(ReleaseMode.Safe);
    expect(desc).toContain("Safe");
    expect(desc).toContain("refused");
  });

  it("permission-cleared mode description mentions publishing", () => {
    const desc = describeReleaseMode(ReleaseMode.PermissionCleared);
    expect(desc).toContain("Permission-cleared");
    expect(desc).toContain("published");
  });
});

describe("checkPublishAllowed", () => {
  describe("safe mode (default)", () => {
    it("refuses .deb artifacts", () => {
      const result = checkPublishAllowed(
        "dist/factory-desktop_0.106.0_amd64.deb",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
      expect(result.reason!.toLowerCase()).toContain("safe mode");
      expect(result.reason).toContain("permission-cleared");
    });

    it("refuses AppImage artifacts", () => {
      const result = checkPublishAllowed(
        "dist/factory-desktop-0.106.0-x86_64.AppImage",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
      expect(result.reason!.toLowerCase()).toContain("safe mode");
    });

    it("refuses .rpm artifacts", () => {
      const result = checkPublishAllowed(
        "dist/factory-desktop-0.106.0.x86_64.rpm",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
    });

    it("refuses .asar artifacts", () => {
      const result = checkPublishAllowed(
        "work/app.asar",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
    });

    it("refuses downloaded droid binary", () => {
      const result = checkPublishAllowed(
        "work/droid",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
    });

    it("refuses update metadata (latest-linux.yml)", () => {
      const result = checkPublishAllowed(
        "dist/latest-linux.yml",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("update metadata");
    });

    it("allows non-binary source files", () => {
      const result = checkPublishAllowed(
        "src/cli.ts",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(true);
    });

    it("allows markdown files", () => {
      const result = checkPublishAllowed(
        "README.md",
        ReleaseMode.Safe
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("permission-cleared mode", () => {
    it("allows .deb artifacts", () => {
      const result = checkPublishAllowed(
        "dist/factory-desktop_0.106.0_amd64.deb",
        ReleaseMode.PermissionCleared
      );
      expect(result.allowed).toBe(true);
    });

    it("allows AppImage artifacts", () => {
      const result = checkPublishAllowed(
        "dist/factory-desktop-0.106.0-x86_64.AppImage",
        ReleaseMode.PermissionCleared
      );
      expect(result.allowed).toBe(true);
    });

    it("allows update metadata", () => {
      const result = checkPublishAllowed(
        "dist/latest-linux.yml",
        ReleaseMode.PermissionCleared
      );
      expect(result.allowed).toBe(true);
    });
  });
});

describe("enforceSafeMode", () => {
  it("throws in safe mode when binary artifacts are present", () => {
    const artifacts = [
      "dist/factory-desktop_0.106.0_amd64.deb",
      "dist/factory-desktop-0.106.0-x86_64.AppImage",
    ];

    expect(() => {
      enforceSafeMode(artifacts, ReleaseMode.Safe);
    }).toThrow(/Publish refused in safe mode/);
  });

  it("does not throw in safe mode when only source files are present", () => {
    const artifacts = ["src/cli.ts", "package.json"];

    expect(() => {
      enforceSafeMode(artifacts, ReleaseMode.Safe);
    }).not.toThrow();
  });

  it("does not throw in permission-cleared mode for binary artifacts", () => {
    const artifacts = [
      "dist/factory-desktop_0.106.0_amd64.deb",
      "dist/factory-desktop-0.106.0-x86_64.AppImage",
    ];

    expect(() => {
      enforceSafeMode(artifacts, ReleaseMode.PermissionCleared);
    }).not.toThrow();
  });

  it("error message mentions permission-cleared flag", () => {
    const artifacts = ["dist/test.deb"];

    try {
      enforceSafeMode(artifacts, ReleaseMode.Safe);
      fail("Expected an error to be thrown");
    } catch (err) {
      expect(String(err)).toContain("permission-cleared");
    }
  });
});
