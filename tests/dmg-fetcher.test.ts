/**
 * Tests for the official Factory Desktop DMG fetcher.
 *
 * Covers URL building, version parsing, arch validation, filename building,
 * and the end-to-end fetch with an injected (no-network) downloader.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  FACTORY_DESKTOP_API,
  buildDesktopApiUrl,
  parseVersionFromRedirectUrl,
  isValidDarwinArch,
  buildDmgFilename,
  fetchDesktopDmg,
  formatDmgFetchResult,
  type DmgDownloader,
} from "../src/dmg-fetcher";

describe("dmg-fetcher constants", () => {
  it("FACTORY_DESKTOP_API points at the app.factory.ai desktop endpoint", () => {
    expect(FACTORY_DESKTOP_API).toBe("https://app.factory.ai/api/desktop");
  });
});

describe("buildDesktopApiUrl", () => {
  it("builds the arm64 endpoint URL", () => {
    expect(buildDesktopApiUrl("arm64")).toBe(
      "https://app.factory.ai/api/desktop?platform=darwin&architecture=arm64"
    );
  });

  it("builds the x64 endpoint URL", () => {
    expect(buildDesktopApiUrl("x64")).toBe(
      "https://app.factory.ai/api/desktop?platform=darwin&architecture=x64"
    );
  });
});

describe("isValidDarwinArch", () => {
  it("accepts arm64 and x64", () => {
    expect(isValidDarwinArch("arm64")).toBe(true);
    expect(isValidDarwinArch("x64")).toBe(true);
  });

  it("rejects unsupported arches served 400 by the endpoint", () => {
    expect(isValidDarwinArch("x86_64")).toBe(false);
    expect(isValidDarwinArch("amd64")).toBe(false);
    expect(isValidDarwinArch("intel")).toBe(false);
    expect(isValidDarwinArch("")).toBe(false);
  });
});

describe("parseVersionFromRedirectUrl", () => {
  it("parses version from a presigned S3 redirect URL", () => {
    const url =
      "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/" +
      "releases/0.108.0/darwin/arm64/Factory-0.108.0-arm64.dmg?X-Amz-Signature=abc";
    expect(parseVersionFromRedirectUrl(url)).toBe("0.108.0");
  });

  it("parses a three-part semver", () => {
    const url =
      "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/" +
      "releases/1.2.3/darwin/x64/Factory-1.2.3-x64.dmg";
    expect(parseVersionFromRedirectUrl(url)).toBe("1.2.3");
  });

  it("returns null when no releases path is present", () => {
    expect(parseVersionFromRedirectUrl("https://example.com/foo.dmg")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseVersionFromRedirectUrl("")).toBeNull();
  });
});

describe("buildDmgFilename", () => {
  it("builds the versioned arm64 filename", () => {
    expect(buildDmgFilename("0.108.0", "arm64")).toBe(
      "Factory-0.108.0-arm64.dmg"
    );
  });

  it("builds the versioned x64 filename", () => {
    expect(buildDmgFilename("0.106.0", "x64")).toBe("Factory-0.106.0-x64.dmg");
  });
});

describe("fetchDesktopDmg", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-fetch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("downloads, parses the version, renames to the versioned filename, and computes sha256", async () => {
    const finalUrl =
      "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/" +
      "releases/0.108.0/darwin/arm64/Factory-0.108.0-arm64.dmg?sig=abc";
    const payload = Buffer.from("fake-dmg-contents");

    const fakeDownloader: DmgDownloader = async (_apiUrl, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, payload);
      return { finalUrl, bytes: payload.length };
    };

    const result = await fetchDesktopDmg({
      arch: "arm64",
      destDir: tmpDir,
      downloader: fakeDownloader,
    });

    expect(result.success).toBe(true);
    expect(result.arch).toBe("arm64");
    expect(result.version).toBe("0.108.0");
    expect(result.downloadUrl).toBe(finalUrl);
    expect(result.bytes).toBe(payload.length);
    expect(result.dmgPath).toBe(
      path.join(tmpDir, "Factory-0.108.0-arm64.dmg")
    );
    expect(fs.existsSync(result.dmgPath)).toBe(true);

    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    expect(result.sha256).toBe(expected);
    expect(result.errors).toEqual([]);
  });

  it("warns when the version cannot be parsed from the redirect URL", async () => {
    const finalUrl = "https://example.com/some-other-host.dmg";
    const fakeDownloader: DmgDownloader = async (_apiUrl, destPath) => {
      fs.writeFileSync(destPath, Buffer.from("x"));
      return { finalUrl, bytes: 1 };
    };

    const result = await fetchDesktopDmg({
      arch: "x64",
      destDir: tmpDir,
      downloader: fakeDownloader,
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.dmgPath).toBe(path.join(tmpDir, "Factory-unknown-x64.dmg"));
  });

  it("warns on expected-version mismatch", async () => {
    const finalUrl =
      "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/" +
      "releases/0.108.0/darwin/x64/Factory-0.108.0-x64.dmg?sig=z";
    const fakeDownloader: DmgDownloader = async (_apiUrl, destPath) => {
      fs.writeFileSync(destPath, Buffer.from("x"));
      return { finalUrl, bytes: 1 };
    };

    const result = await fetchDesktopDmg({
      arch: "x64",
      destDir: tmpDir,
      expectedVersion: "0.106.0",
      downloader: fakeDownloader,
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("0.108.0");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Version mismatch.*0\.108\.0.*0\.106\.0/),
      ])
    );
  });

  it("reports failure and cleans up the partial file on download error", async () => {
    const failingDownloader: DmgDownloader = async () => {
      throw new Error("network down");
    };

    const result = await fetchDesktopDmg({
      arch: "arm64",
      destDir: tmpDir,
      downloader: failingDownloader,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.stringMatching(/DMG fetch failed: network down/),
    ]);
    expect(result.dmgPath).toBe("");
  });
});

describe("formatDmgFetchResult", () => {
  it("renders a success summary", () => {
    const out = formatDmgFetchResult({
      success: true,
      dmgPath: "/work/Factory-0.108.0-arm64.dmg",
      arch: "arm64",
      version: "0.108.0",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      downloadUrl: "https://s3.example.com/x?sig=1",
      bytes: 169815544,
      errors: [],
      warnings: [],
    });
    expect(out).toContain("DMG fetch succeeded");
    expect(out).toContain("0.108.0");
    expect(out).toContain("/work/Factory-0.108.0-arm64.dmg");
  });

  it("renders a failure summary", () => {
    const out = formatDmgFetchResult({
      success: false,
      dmgPath: "",
      arch: "x64",
      version: "",
      sha256: "",
      downloadUrl: "",
      bytes: 0,
      errors: ["DMG fetch failed: HTTP 503"],
      warnings: [],
    });
    expect(out).toContain("DMG fetch failed");
    expect(out).toContain("HTTP 503");
  });
});
