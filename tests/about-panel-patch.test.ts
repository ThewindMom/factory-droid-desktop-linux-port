/**
 * Tests for the about-panel patch.
 *
 * Validates that the about-panel patch correctly augments the "About Factory"
 * dialog's detail template literal to read build-info.json and state.json at
 * runtime, and degrades gracefully when files are missing.
 */

import {
  patchAboutPanel,
  validateAboutPanel,
  formatAboutPanelPatchResult,
} from "../src/about-panel-patch";

// ─── Minified code samples from real Factory Desktop 0.114.3 asar ──────────

/**
 * The exact About Factory detail string from Factory Desktop 0.114.3.
 * Vite minification converts `\n` escapes to actual newline characters inside
 * backtick template literals. The alias `Y` = require("electron").
 */
const ABOUT_DETAIL_0_114_3 =
  'detail:`Version: ${Y.app.getVersion()}\n' +
  'Electron: ${process.versions.electron}\n' +
  'Chromium: ${process.versions.chrome}\n' +
  'Node.js: ${process.versions.node}`';

/**
 * A variant with a different minified alias (e.g. `e` instead of `Y`).
 */
const ABOUT_DETAIL_ALT_ALIAS =
  'detail:`Version: ${e.app.getVersion()}\n' +
  'Electron: ${process.versions.electron}\n' +
  'Chromium: ${process.versions.chrome}\n' +
  'Node.js: ${process.versions.node}`';

// ─── Version-agnostic regex matching ──────────────────────────────────────

const ABOUT_DETAIL_REGEX =
  /detail:`Version:\s*\$\{(\w+\.app\.getVersion\(\))\}\nElectron:\s*\$\{process\.versions\.electron\}\nChromium:\s*\$\{process\.versions\.chrome\}\nNode\.js:\s*\$\{process\.versions\.node\}`/;

describe("about-panel-patch version-agnostic matching", () => {
  it("matches Factory 0.114.3 About detail pattern", () => {
    expect(ABOUT_DETAIL_0_114_3).toMatch(ABOUT_DETAIL_REGEX);
  });

  it("extracts the getVersion reference (alias Y)", () => {
    const match = ABOUT_DETAIL_0_114_3.match(ABOUT_DETAIL_REGEX);
    expect(match?.[1]).toBe("Y.app.getVersion()");
  });

  it("matches alternative alias names", () => {
    expect(ABOUT_DETAIL_ALT_ALIAS).toMatch(ABOUT_DETAIL_REGEX);
    const match = ABOUT_DETAIL_ALT_ALIAS.match(ABOUT_DETAIL_REGEX);
    expect(match?.[1]).toBe("e.app.getVersion()");
  });

  it("does not match without the Node.js line", () => {
    const noNode =
      'detail:`Version: ${Y.app.getVersion()}\n' +
      'Electron: ${process.versions.electron}\n' +
      'Chromium: ${process.versions.chrome}`';
    expect(noNode).not.toMatch(ABOUT_DETAIL_REGEX);
  });
});

// ─── patchAboutPanel ──────────────────────────────────────────────────────

describe("patchAboutPanel", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("fs");
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("returns error when asar not found", async () => {
    const result = await patchAboutPanel({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("returns success with tolerateMissingTarget when no bundles found", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-" + Date.now();
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "placeholder.txt"), "test");
    const asarPath = path.join(tmpDir, "test.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({
      asarPath,
      tolerateMissingTarget: true,
    });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(false);
  });

  it("patches a bundle containing the About Factory detail string", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-patch-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    // Write a minimal bundle containing both the About Factory dialog and
    // the renderer did-finish-load hook used for the visible version chip.
    const bundleContent =
      'function gu(){const e=process.platform==="darwin";' +
      'const s=[{label:"Help",submenu:[{label:"About Factory",click:()=>{' +
      ABOUT_DETAIL_0_114_3 +
      '}}]}];Y.Menu.setApplicationMenu(Y.Menu.buildFromTemplate(s))}' +
      'function createWindow(){_t.webContents.on("did-finish-load",()=>{me("[window] Renderer finished loading")})}';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      bundleContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(2);
    expect(result.errors).toEqual([]);

    // Verify the patched content
    const patchedContent = asar
      .extractFile(asarPath, ".vite/build/index-AbCdEfGh.js")
      .toString("utf-8");

    // Should contain the PATCH_MARKER
    expect(patchedContent).toContain("/* linux-about-panel-patch */");

    // Should NOT contain the original detail template literal
    expect(patchedContent).not.toContain("detail:`Version: ${Y.app.getVersion()}");

    // Should contain the runtime IIFE
    expect(patchedContent).toContain("detail:(()=>{");

    // Should also inject the visible frontend chip.
    expect(patchedContent).toContain("/* linux-visible-version-chip-patch */");
    expect(patchedContent).toContain("factory-linux-version-chip");
    expect(patchedContent).toContain("role','status");
    expect(patchedContent).toContain("pointer-events:auto");
    expect(patchedContent).toContain("Factory Desktop");
    expect(patchedContent).toContain("System Droid CLI");
    expect(patchedContent).toContain("System Droid CLI not found");
    expect(patchedContent).toContain("top:38px");
    expect(patchedContent).toContain("min-width:220px");
    expect(patchedContent).toContain("white-space:pre-line");
    expect(patchedContent).toContain("factory-linux-version-update");
    expect(patchedContent).toContain("Copy update command");
    expect(patchedContent).toContain("factory-linux-version-command");
    expect(patchedContent).toContain("Hide version status");
    expect(patchedContent).toContain("sessionStorage");
    expect(patchedContent).toContain("navigator.clipboard.writeText");
    expect(patchedContent).toContain(String.raw`body.textContent=d.text.join('\\n')`);
    expect(patchedContent).not.toContain(String.raw`body.textContent=d.text.join('\n')`);
    expect(patchedContent).toContain("const render=()=>{try{");
    expect(patchedContent).toContain("__factoryLinuxVersionChipTimer");
    expect(patchedContent).toContain("setInterval(render,5000)");
    const rendererJsExpression = patchedContent.match(
      /const js=([\s\S]*?);_t\.webContents\.executeJavaScript/,
    )?.[1];
    expect(rendererJsExpression).toBeDefined();
    const rendererJs = Function(
      "payload",
      `const js=${rendererJsExpression}; return js;`,
    )({ text: ["Factory Desktop 0.116.1", "System Droid CLI 0.159.1"], command: "" });
    expect(() => Function("d", rendererJs)).not.toThrow();
    const separatorLiteral = rendererJs.match(/d\.text\.join\(([^)]*)\)/)?.[1];
    expect(separatorLiteral).toBeDefined();
    const renderedText = Function(
      `return ["Factory Desktop 0.116.1","System Droid CLI 0.159.1"].join(${separatorLiteral});`,
    )();
    expect(renderedText).toBe("Factory Desktop 0.116.1\nSystem Droid CLI 0.159.1");
    expect(patchedContent).toContain("install-ready");
    expect(patchedContent).toContain("check-now");
    expect(patchedContent).toContain("Remote daemon");
    expect(patchedContent).toContain("droid daemon --remote-access");
    expect(patchedContent).not.toContain("process.kill(Number(pid)");
    // Regression: candidate_version equal to current version must not render
    // as an update. Both About dialog and visible chip use cv !== v guards.
    expect(patchedContent).toContain("cv&&cv!==v");
    expect(patchedContent).toContain("cv===v");
  });

  it("skips already-patched bundles", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-skip-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    // Write a fully patched bundle (About dialog + visible chip).
    const patchedContent =
      'function gu(){const s=[{label:"About Factory",click:()=>{' +
      'detail:(()=>{/* linux-about-panel-patch */try{const p=require("path")}})()' +
      '}}]}];Y.Menu.setApplicationMenu(Y.Menu.buildFromTemplate(s))}' +
      'function createWindow(){_t.webContents.on("did-finish-load",()=>{/* linux-visible-version-chip-patch */try{}})}';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      patchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(false);
    expect(result.patchCount).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("already patched")]),
    );
  });

  it("migrates already-patched legacy chips to the prominent top panel", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-migrate-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const oldChipStyle =
      "position:fixed;right:12px;bottom:10px;z-index:2147483647;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:4px 8px;background:rgba(20,20,20,.78);color:rgba(255,255,255,.72);font:11px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.01em;backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;user-select:none;";
    const oldTopChipStyle =
      "position:fixed;right:16px;top:44px;z-index:2147483647;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:5px 9px;background:rgba(20,20,20,.86);color:rgba(255,255,255,.78);font:11px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.01em;backdrop-filter:blur(8px);box-shadow:0 6px 18px rgba(0,0,0,.22);pointer-events:none;user-select:none;";
    const oldChipText =
      'const parts=["Factory "+v];if(b.droidVersion)parts.push("Droid "+b.droidVersion);const text=parts.join(" · ");';
    const patchedContent =
      'function gu(){detail:(()=>{/* linux-about-panel-patch */try{const v=Y.app.getVersion();return v}catch(e){}})()}' +
      `function createWindow(){_t.webContents.on("did-finish-load",()=>{/* linux-visible-version-chip-patch */${oldChipText}e.style.cssText='${oldChipStyle}';})}`;
    fs.writeFileSync(
      path.join(buildDir, "index-OldChipPosition.js"),
      patchedContent,
    );
    const topPatchedContent =
      'function gu(){detail:(()=>{/* linux-about-panel-patch */try{const v=Y.app.getVersion();return v}catch(e){}})()}' +
      `function createWindow(){_t.webContents.on("did-finish-load",()=>{/* linux-visible-version-chip-patch */${oldChipText}e.style.cssText='${oldTopChipStyle}';})}`;
    fs.writeFileSync(
      path.join(buildDir, "index-OldTopChipPosition.js"),
      topPatchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(2);
    expect(result.patches[0]?.id).toBe("linux-visible-version-chip-prominence");

    const migratedContent = asar
      .extractFile(asarPath, ".vite/build/index-OldChipPosition.js")
      .toString("utf-8");
    const migratedTopContent = asar
      .extractFile(asarPath, ".vite/build/index-OldTopChipPosition.js")
      .toString("utf-8");

    expect(migratedContent).not.toContain("bottom:10px");
    expect(migratedContent).toContain("top:38px");
    expect(migratedContent).toContain("min-width:220px");
    expect(migratedContent).toContain("Factory Desktop");
    expect(migratedContent).toContain("System Droid CLI");
    expect(migratedContent).not.toContain('parts.join(" · ")');
    expect(migratedTopContent).not.toContain("top:44px");
    expect(migratedTopContent).toContain("top:38px");
    expect(migratedTopContent).toContain("min-width:220px");
    expect(migratedTopContent).toContain("Factory Desktop");
    expect(migratedTopContent).toContain("System Droid CLI");
  });

  it("adds the visible chip to bundles that already have only the About patch", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-partial-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const partiallyPatchedContent =
      'function gu(){const s=[{label:"About Factory",click:()=>{' +
      'detail:(()=>{/* linux-about-panel-patch */try{const v=Y.app.getVersion();return v}catch(e){}})()' +
      '}}]}];Y.Menu.setApplicationMenu(Y.Menu.buildFromTemplate(s))}' +
      'function createWindow(){_t.webContents.on("did-finish-load",()=>{me("[window] Renderer finished loading")})}';
    fs.writeFileSync(
      path.join(buildDir, "index-PartiallyPatched.js"),
      partiallyPatchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(1);

    const patchedContent = asar
      .extractFile(asarPath, ".vite/build/index-PartiallyPatched.js")
      .toString("utf-8");

    expect(patchedContent).toContain("/* linux-about-panel-patch */");
    expect(patchedContent).toContain("/* linux-visible-version-chip-patch */");
    expect(patchedContent).toContain("factory-linux-version-chip");
  });

  it("patches with alternative alias names", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-alt-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const bundleContent =
      'function gu(){const s=[{label:"About Factory",click:()=>{' +
      ABOUT_DETAIL_ALT_ALIAS +
      '}}]}];e.Menu.setApplicationMenu(e.Menu.buildFromTemplate(s))}';
    fs.writeFileSync(
      path.join(buildDir, "index-XyZwVuTs.js"),
      bundleContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(1);

    const patchedContent = asar
      .extractFile(asarPath, ".vite/build/index-XyZwVuTs.js")
      .toString("utf-8");

    expect(patchedContent).toContain("/* linux-about-panel-patch */");
    // Should use the alternative alias in the IIFE
    expect(patchedContent).toContain("e.app.getVersion()");
  });
});

// ─── validateAboutPanel ───────────────────────────────────────────────────

describe("validateAboutPanel", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("fs");
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("returns error when asar not found", () => {
    const result = validateAboutPanel({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.aboutPanelPatched).toBe(false);
    expect(result.visibleVersionChipPatched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("detects patched asar", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-val-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const patchedContent =
      '/* linux-about-panel-patch */ detail:(()=>{try{...}})()' +
      '/* linux-visible-version-chip-patch */';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      patchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = validateAboutPanel({ asarPath });
    expect(result.valid).toBe(true);
    expect(result.aboutPanelPatched).toBe(true);
    expect(result.visibleVersionChipPatched).toBe(true);
  });

  it("detects unpatched asar", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-unp-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const unpatchedContent =
      'detail:`Version: ${Y.app.getVersion()}\nElectron: ${process.versions.electron}`';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      unpatchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = validateAboutPanel({ asarPath });
    expect(result.valid).toBe(false);
    expect(result.aboutPanelPatched).toBe(false);
    expect(result.visibleVersionChipPatched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("About dialog version patch marker not found"),
        expect.stringContaining("Visible frontend version chip patch marker not found"),
      ]),
    );
  });
});

// ─── Formatting ──────────────────────────────────────────────────────────

describe("formatAboutPanelPatchResult", () => {
  it("formats a successful result", () => {
    const result = {
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 1,
      patches: [
        {
          id: "linux-about-panel-version",
          description: "test description",
          originalSnippet: "original",
          replacementSnippet: "replacement",
        },
      ],
      errors: [],
      warnings: [],
    };
    const formatted = formatAboutPanelPatchResult(result);
    expect(formatted).toContain("✓ success");
    expect(formatted).toContain("Patch count: 1");
    expect(formatted).toContain("test description");
  });

  it("formats a failed result", () => {
    const result = {
      success: false,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: ["test error"],
      warnings: [],
    };
    const formatted = formatAboutPanelPatchResult(result);
    expect(formatted).toContain("✗ failed");
    expect(formatted).toContain("test error");
  });
});
