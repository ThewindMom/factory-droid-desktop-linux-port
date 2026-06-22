import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadAllFeatures,
  loadEnabledFeatures,
  featuresForDistro,
  type FeatureDescriptor,
} from "../src/features/loader";

function writeFeature(
  dir: string,
  id: string,
  manifest: Record<string, unknown>
): void {
  const featDir = path.join(dir, id);
  fs.mkdirSync(featDir, { recursive: true });
  fs.writeFileSync(
    path.join(featDir, "feature.json"),
    JSON.stringify(manifest)
  );
}

describe("features loader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feat-load-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when the features dir does not exist", () => {
    expect(loadAllFeatures(path.join(tmp, "nope"))).toEqual([]);
  });

  it("loads all features with a valid feature.json", () => {
    writeFeature(tmp, "alpha", {
      id: "alpha",
      name: "Alpha",
      description: "d",
      enabled: true,
    });
    writeFeature(tmp, "beta", {
      id: "beta",
      name: "Beta",
      description: "d",
      enabled: false,
    });

    const all = loadAllFeatures(tmp);
    expect(all.map((f) => f.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("loadEnabledFeatures returns only enabled features", () => {
    writeFeature(tmp, "alpha", {
      id: "alpha",
      name: "Alpha",
      description: "d",
      enabled: true,
    });
    writeFeature(tmp, "beta", {
      id: "beta",
      name: "Beta",
      description: "d",
      enabled: false,
    });
    writeFeature(tmp, "gamma", { id: "gamma", name: "Gamma", description: "d" });

    const enabled = loadEnabledFeatures(tmp);
    expect(enabled.map((f) => f.id)).toEqual(["alpha"]);
  });

  it("skips directories without a feature.json", () => {
    writeFeature(tmp, "alpha", {
      id: "alpha",
      name: "Alpha",
      description: "d",
      enabled: true,
    });
    fs.mkdirSync(path.join(tmp, "no-manifest"), { recursive: true });

    expect(loadAllFeatures(tmp).map((f) => f.id)).toEqual(["alpha"]);
  });

  it("skips the local/ directory", () => {
    writeFeature(tmp, "alpha", {
      id: "alpha",
      name: "Alpha",
      description: "d",
      enabled: true,
    });
    writeFeature(tmp, "local/secret", {
      id: "secret",
      name: "Secret",
      description: "d",
      enabled: true,
    });

    expect(loadAllFeatures(tmp).map((f) => f.id)).toEqual(["alpha"]);
  });

  it("featuresForDistro filters by distro id, with empty distros matching all", () => {
    const features: FeatureDescriptor[] = [
      {
        id: "any",
        name: "Any",
        description: "d",
        dir: "",
        readmePath: "",
        enabled: true,
      },
      {
        id: "arch-only",
        name: "Arch",
        description: "d",
        dir: "",
        readmePath: "",
        enabled: true,
        distros: ["arch"],
      },
    ];

    expect(featuresForDistro(features, "arch").map((f) => f.id).sort()).toEqual([
      "any",
      "arch-only",
    ]);
    expect(featuresForDistro(features, "debian").map((f) => f.id)).toEqual([
      "any",
    ]);
  });

  it("resolves the on-disk dir and readmePath", () => {
    writeFeature(tmp, "alpha", {
      id: "alpha",
      name: "Alpha",
      description: "d",
      enabled: true,
    });
    const [alpha] = loadAllFeatures(tmp);
    expect(alpha.dir).toBe(path.join(tmp, "alpha"));
    expect(alpha.readmePath).toBe(path.join(tmp, "alpha", "README.md"));
  });
});
