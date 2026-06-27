/**
 * About panel patch for Linux builds.
 *
 * Factory Desktop's Help menu already contains an "About Factory" entry on
 * non-darwin platforms (the menu builder gates it behind
 * `process.platform !== "darwin"`). The existing dialog shows only
 * `app.getVersion()` + Electron/Chromium/Node versions — it does NOT surface
 * the system droid CLI version, the port build SHA, or the update status
 * from the factory-update-manager daemon.
 *
 * This patch replaces the dialog's `detail:` template literal with a runtime
 * expression that reads `<app_root>/.factory-linux/build-info.json` and
 * `~/.local/state/factory-update-manager/state.json` to build a richer
 * version string. If either file is missing or unreadable, it degrades
 * gracefully to the original values — the patch never breaks the dialog.
 *
 * The regex is version-agnostic: it matches the structural shape of the
 * minified `detail:` template literal (the unique `Version: \nElectron: \n…`
 * sequence inside backticks), not a hardcoded minified string.
 */

import * as fs from "fs";
import {
  applyAsarContentPatch,
  applyRegexPatch,
  computeFileHash,
  findMainBundleFiles,
  type RegexPatchResult,
} from "./patches/asar-patcher";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AboutPanelPatchOptions {
  asarPath: string;
  skipIfPatched?: boolean;
  tolerateMissingTarget?: boolean;
}

export interface AboutPanelPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: AboutPanelNeedle[];
  errors: string[];
  warnings: string[];
}

export interface AboutPanelNeedle {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

export interface ValidateAboutPanelOptions {
  asarPath: string;
}

export interface ValidateAboutPanelResult {
  valid: boolean;
  aboutPanelPatched: boolean;
  visibleVersionChipPatched: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

const PATCH_MARKER = "/* linux-about-panel-patch */";
const CHIP_PATCH_MARKER = "/* linux-visible-version-chip-patch */";
const OLD_CHIP_STYLE_CSS =
  "position:fixed;right:12px;bottom:10px;z-index:2147483647;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:4px 8px;background:rgba(20,20,20,.78);color:rgba(255,255,255,.72);font:11px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.01em;backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;user-select:none;";
const OLD_TOP_CHIP_STYLE_CSS =
  "position:fixed;right:16px;top:44px;z-index:2147483647;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:5px 9px;background:rgba(20,20,20,.86);color:rgba(255,255,255,.78);font:11px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.01em;backdrop-filter:blur(8px);box-shadow:0 6px 18px rgba(0,0,0,.22);pointer-events:none;user-select:none;";
const CHIP_STYLE_CSS =
  "position:fixed;right:28px;top:38px;z-index:2147483647;min-width:220px;border:1px solid rgba(255,255,255,.22);border-radius:14px;padding:10px 12px;background:rgba(18,18,18,.94);color:rgba(255,255,255,.9);font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.01em;font-variant-numeric:tabular-nums;text-align:left;backdrop-filter:blur(12px);box-shadow:0 12px 32px rgba(0,0,0,.34),0 1px 0 rgba(255,255,255,.06) inset;pointer-events:auto;user-select:none;";
const CHIP_CLOSE_BUTTON_CSS =
  "position:absolute;right:6px;top:5px;width:22px;height:22px;border:0;border-radius:999px;background:transparent;color:rgba(255,255,255,.62);font:16px/22px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer;padding:0;";
const CHIP_UPDATE_BUTTON_CSS =
  "margin-top:9px;width:100%;border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:7px 10px;background:rgba(255,255,255,.92);color:rgba(18,18,18,.96);font:600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer;";
const OLD_CHIP_FACTORY_LABEL = 'const parts=["Factory "+v];';
const CHIP_FACTORY_LABEL = 'const parts=["Factory Desktop "+v];';
const OLD_CHIP_DROID_LABEL =
  'if(b.droidVersion)parts.push("Droid "+b.droidVersion);';
const CHIP_DROID_LABEL =
  'if(typeof sdv!=="undefined"&&sdv)parts.push("System Droid CLI "+sdv);else parts.push("System Droid CLI not found");';
const OLD_CHIP_TEXT_JOIN = 'const text=parts.join(" · ");';
const CHIP_TEXT_JOIN = 'const text=parts.join("\\n");';

/**
 * Regex matching the existing About Factory dialog's `detail:` template.
 *
 * The minified code is:
 *   detail:`Version: ${Y.app.getVersion()}\nElectron: ${...}\nChromium: ${...}\nNode.js: ${...}`
 *
 * After Vite minification, the `\n` escapes become literal newlines inside
 * the backtick template literal. The structural shape we anchor on:
 *
 *   detail:`Version: ${APP.getVersion()}\nElectron: ${process.versions.electron}\nChromium: ${process.versions.chrome}\nNode.js: ${process.versions.node}`
 *
 * We capture:
 *   - group 1: the app.getVersion() reference (e.g. Y.app.getVersion())
 *
 * The pattern tolerates different minified alias names for the Electron
 * module (Y, e, Ne, etc.) since `\w+\.app\.getVersion` matches any alias.
 * The `\n` in the pattern matches literal newline characters — Vite emits
 * `\n` escapes inside template literals as actual newline bytes.
 */
const ABOUT_DETAIL_REGEX =
  /detail:`Version:\s*\$\{(\w+\.app\.getVersion\(\))\}\nElectron:\s*\$\{process\.versions\.electron\}\nChromium:\s*\$\{process\.versions\.chrome\}\nNode\.js:\s*\$\{process\.versions\.node\}`/;
const VISIBLE_VERSION_CHIP_REGEX =
  /(\w+)\.webContents\.on\("did-finish-load",\(\)=>\{([^{}]*?\[window\] Renderer finished loading[^{}]*?)\}\)/;
const PATCHED_ABOUT_GET_VERSION_REGEX = /const v=(\w+\.app\.getVersion\(\));/;


/**
 * The injected runtime helper. Reads build-info.json and state.json at
 * dialog-open time, builds a rich version detail string, and falls back to
 * the original values if files are missing.
 *
 * Design notes:
 * - The main-process bundle already requires "fs" and "path" (via
 *   electron-store etc.); we re-require them defensively inside the IIFE.
 * - `process.execPath` points to the app executable; its parent dir contains
 *   `.factory-linux/build-info.json`.
 * - `process.env.XDG_STATE_HOME` or `~/.local/state` holds the daemon state.
 * - Wrapped in try/catch so a missing/unreadable file never throws.
 */
function buildInjectedDetail(appGetVersionRef: string): string {
  // The injected IIFE reads the files and returns a detail string.
  // We embed the original getVersion ref as a fallback.
  return (
    `detail:(()=>{${PATCH_MARKER}` +
    `try{` +
    // Resolve app root: process.execPath's parent (the app dir) contains
    // .factory-linux/build-info.json. In a packaged app, process.resourcesPath
    // is <app>/resources; the app root is its parent.
    `const p=require("path"),f=require("fs"),cp=require("child_process"),os=require("os");` +
    `let r=p.dirname(process.execPath);` +
    `if(f.existsSync(p.join(r,".factory-linux","build-info.json"))===false)` +
    `r=p.dirname(p.dirname(process.execPath));` +
    // Read build-info.json
    `let b={};try{b=JSON.parse(f.readFileSync(p.join(r,".factory-linux","build-info.json"),"utf-8"))}catch(e){}` +
    `let sdv=b.systemDroidVersion||"";try{const c=[p.join(os.homedir(),".local","bin","droid"),"/usr/local/bin/droid","/usr/bin/droid"];let dp="";if(process.env.FACTORY_DROID_PATH&&f.existsSync(process.env.FACTORY_DROID_PATH))dp=process.env.FACTORY_DROID_PATH;try{if(!dp)dp=cp.execFileSync("sh",["-lc","command -v droid"],{encoding:"utf-8",timeout:2000}).trim()}catch(e){}if(!dp){for(const x of c)if(f.existsSync(x)){dp=x;break}}if(dp)sdv=cp.execFileSync(dp,["--version"],{encoding:"utf-8",timeout:2500}).trim()}catch(e){}` +
    // Read state.json (updater daemon state)
    `let s={};const sd=process.env.XDG_STATE_HOME||p.join(os.homedir(),".local","state");` +
    `try{s=JSON.parse(f.readFileSync(p.join(sd,"factory-update-manager","state.json"),"utf-8"))}catch(e){}` +
    // Build version detail
    `const v=${appGetVersionRef};` +
    `let d="Version: "+v;` +
    `d+="\\nSystem Droid CLI: "+(sdv||"not found");` +
    `if(b.portBuildSha)d+="\\nPort build: "+b.portBuildSha.slice(0,7);` +
    `d+="\\nElectron: "+process.versions.electron+"\\nChromium: "+process.versions.chrome+"\\nNode.js: "+process.versions.node;` +
    // Append update status from the daemon (state.json).
    // The enum serializes snake_case (state.rs): idle, checking_upstream,
    // update_detected, downloading_dmg, preparing_workspace, building_package,
    // ready_to_install, waiting_for_app_exit, installing, installed, failed.
    // idle = no update found; installed = post-success steady state.
    `if(s.status){` +
    `const up=["update_detected","downloading_dmg","preparing_workspace","building_package","ready_to_install","waiting_for_app_exit","installing"],cv=s.candidate_version;` +
    `if(cv&&cv!==v)d+="\\n\\nUpdate available: "+cv;` +
    `else if(cv===v||s.status==="idle"||s.status==="installed")d+="\\n\\nUpdate status: up to date";` +
    `else if(up.includes(s.status))d+="\\n\\nUpdate available: pending";` +
    `else if(s.status==="failed")d+="\\n\\nUpdate check failed";` +
    `else if(s.last_check_at)d+="\\n\\nLast update check: "+new Date(s.last_check_at).toLocaleString();` +
    `}` +
    `return d}` +
    `catch(e){return"Version: "+${appGetVersionRef}+"\\nElectron: "+process.versions.electron+"\\nChromium: "+process.versions.chrome+"\\nNode.js: "+process.versions.node}})()` +
    ``
  );
}
function buildInjectedVisibleVersionChip(
  windowRef: string,
  originalHandlerBody: string,
  appGetVersionRef: string,
): string {
  return (
    `${windowRef}.webContents.on("did-finish-load",()=>{${originalHandlerBody};` +
    `(()=>{${CHIP_PATCH_MARKER}try{` +
    `const p=require("path"),f=require("fs"),cp=require("child_process"),os=require("os");` +
    `let r=p.dirname(process.execPath);` +
    `if(f.existsSync(p.join(r,".factory-linux","build-info.json"))===false)` +
    `r=p.dirname(p.dirname(process.execPath));` +
    `let b={};try{b=JSON.parse(f.readFileSync(p.join(r,".factory-linux","build-info.json"),"utf-8"))}catch(e){}` +
    `let sdv=b.systemDroidVersion||"";try{const c=[p.join(os.homedir(),".local","bin","droid"),"/usr/local/bin/droid","/usr/bin/droid"];let dp="";if(process.env.FACTORY_DROID_PATH&&f.existsSync(process.env.FACTORY_DROID_PATH))dp=process.env.FACTORY_DROID_PATH;try{if(!dp)dp=cp.execFileSync("sh",["-lc","command -v droid"],{encoding:"utf-8",timeout:2000}).trim()}catch(e){}if(!dp){for(const x of c)if(f.existsSync(x)){dp=x;break}}if(dp)sdv=cp.execFileSync(dp,["--version"],{encoding:"utf-8",timeout:2500}).trim()}catch(e){}` +
    `let remoteDaemonVersion="",remoteDaemonStale=false;try{if(process.platform==="linux"&&sdv&&f.existsSync("/proc")){for(const pid of f.readdirSync("/proc")){if(!/^\\d+$/.test(pid))continue;let cmd="";try{cmd=f.readFileSync("/proc/"+pid+"/cmdline","utf-8").replace(/\\0/g," ")}catch(e){}if(!cmd.includes("daemon")||!cmd.includes("--remote-access")||!cmd.includes("droid"))continue;try{const rv=cp.execFileSync("/proc/"+pid+"/exe",["--version"],{encoding:"utf-8",timeout:2500}).trim();if(rv&&rv!==sdv){remoteDaemonVersion=rv;remoteDaemonStale=true;break}}catch(e){}}}}catch(e){}` +
    `let s={};const sd=process.env.XDG_STATE_HOME||p.join(os.homedir(),".local","state");` +
    `try{s=JSON.parse(f.readFileSync(p.join(sd,"factory-update-manager","state.json"),"utf-8"))}catch(e){}` +
    `const v=b.factoryVersion||${appGetVersionRef};` +
    `const parts=["Factory Desktop "+v];` +
    `if(sdv)parts.push("System Droid CLI "+sdv);else parts.push("System Droid CLI not found");` +
    `const up=["update_detected","downloading_dmg","preparing_workspace","building_package","ready_to_install","waiting_for_app_exit","installing"],cv=s.candidate_version;` +
    `const desktopUpdate=!!(cv&&cv!==v),ready=s.status==="ready_to_install"||s.status==="waiting_for_app_exit";` +
    `let command="";` +
    `if(desktopUpdate){parts.push((ready?"Ready to update Desktop to ":"Desktop update available: ")+cv);command=ready?"factory-update-manager install-ready":"factory-update-manager check-now"}` +
    `else if(cv===v||s.status==="idle"||s.status==="installed")parts.push("Up to date");` +
    `else if(up.includes(s.status)){parts.push("Preparing update");command="factory-update-manager check-now"}` +
    `else if(s.status==="failed"){parts.push("Update check failed");command="factory-update-manager check-now"}` +
    `else if(s.status==="checking_upstream")parts.push("Checking for updates");` +
    `if(remoteDaemonStale){parts.push("Remote daemon "+remoteDaemonVersion+" still running");if(!command)command='pkill -f "droid daemon --remote-access"; droid daemon --remote-access'}` +
    `const payload={text:parts,command};` +
    `const js="(()=>{const d="+JSON.stringify(payload)+";if(sessionStorage.getItem('factory-linux-version-panel-hidden')==='1')return;let e=document.getElementById('factory-linux-version-chip');` +
    `if(!e){e=document.createElement('div');e.id='factory-linux-version-chip';e.setAttribute('role','status');e.setAttribute('aria-label','Factory version status');e.style.cssText='${CHIP_STYLE_CSS}';` +
    `const c=document.createElement('button');c.type='button';c.setAttribute('aria-label','Hide version status');c.textContent='×';c.style.cssText='${CHIP_CLOSE_BUTTON_CSS}';c.onclick=()=>{sessionStorage.setItem('factory-linux-version-panel-hidden','1');e.remove()};e.appendChild(c);` +
    `const body=document.createElement('div');body.id='factory-linux-version-chip-body';body.style.cssText='padding-right:18px;white-space:pre-line;';e.appendChild(body);` +
    `const code=document.createElement('code');code.id='factory-linux-version-command';code.style.cssText='display:none;margin-top:9px;padding:7px 8px;border-radius:8px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.82);font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;user-select:text;';e.appendChild(code);` +
    `const btn=document.createElement('button');btn.type='button';btn.id='factory-linux-version-update';btn.style.cssText='${CHIP_UPDATE_BUTTON_CSS}';btn.textContent='Copy update command';btn.onclick=async()=>{try{await navigator.clipboard.writeText(d.command);btn.textContent='Copied'}catch(_){btn.textContent=d.command}};e.appendChild(btn);document.body.appendChild(e)}` +
    `const body=e.querySelector('#factory-linux-version-chip-body');if(body)body.textContent=d.text.join('\\\\n');const code=e.querySelector('#factory-linux-version-command');if(code){code.textContent=d.command;code.style.display=d.command?'block':'none'}const btn=e.querySelector('#factory-linux-version-update');if(btn){btn.style.display=d.command?'block':'none';if(d.command)btn.textContent='Copy update command'}})()";` +
    `${windowRef}.webContents.executeJavaScript(js,true).catch(()=>{})` +
    `}catch(e){}})()})`
  );
}

// ─── Core Patching Functions ────────────────────────────────────────────────

export async function patchAboutPanel(
  options: AboutPanelPatchOptions,
): Promise<AboutPanelPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: AboutPanelNeedle[] = [];
  const skipIfPatched = options.skipIfPatched ?? true;

  if (!fs.existsSync(options.asarPath)) {
    return {
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      patches: [],
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  const originalHash = computeFileHash(options.asarPath);
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  if (mainBundleFiles.length === 0) {
    const message =
      "Could not find the main Vite bundle file (.vite/build/index-*.js) in the asar.";

    if (options.tolerateMissingTarget) {
      warnings.push(message + " Skipping patch (tolerateMissingTarget=true).");
      return {
        success: true,
        patched: false,
        originalHash,
        patchedHash: originalHash,
        patchCount: 0,
        patches: [],
        errors: [],
        warnings,
      };
    }

    return {
      success: false,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [message],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let totalPatchCount = 0;
  let alreadyPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (
      skipIfPatched &&
      content.includes(PATCH_MARKER) &&
      content.includes(CHIP_PATCH_MARKER)
    ) {
      let patchedContent = content;
      let migrated = false;
      const oldChipStyle = [OLD_CHIP_STYLE_CSS, OLD_TOP_CHIP_STYLE_CSS].find(
        (style) => patchedContent.includes(style),
      );
      if (oldChipStyle) {
        patchedContent = patchedContent.replace(oldChipStyle, CHIP_STYLE_CSS);
        migrated = true;
      }
      for (const [oldSnippet, newSnippet] of [
        [OLD_CHIP_FACTORY_LABEL, CHIP_FACTORY_LABEL],
        [OLD_CHIP_DROID_LABEL, CHIP_DROID_LABEL],
        [OLD_CHIP_TEXT_JOIN, CHIP_TEXT_JOIN],
      ] as const) {
        if (patchedContent.includes(oldSnippet)) {
          patchedContent = patchedContent.replace(oldSnippet, newSnippet);
          migrated = true;
        }
      }
      if (migrated) {
        try {
          await applyAsarContentPatch(
            options.asarPath,
            bundleFile,
            patchedContent,
          );
          totalPatchCount += 1;
          patches.push({
            id: "linux-visible-version-chip-prominence",
            description:
              "Make the visible frontend version/status chip prominent and " +
              "label Factory and Droid versions explicitly",
            originalSnippet: oldChipStyle ?? "legacy visible chip text",
            replacementSnippet: CHIP_STYLE_CSS,
          });
        } catch (err) {
          errors.push(
            `Failed to update visible chip prominence in ${bundleFile}: ${String(err)}`,
          );
        }
      } else {
        alreadyPatched = true;
        warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      }
      continue;
    }

    if (
      !content.includes('Version: ${') &&
      !content.includes('did-finish-load')
    ) {
      continue;
    }

    const aboutMatch = content.match(ABOUT_DETAIL_REGEX);
    const patchedAboutMatch = content.match(PATCHED_ABOUT_GET_VERSION_REGEX);
    if (
      (!aboutMatch || aboutMatch.index === undefined) &&
      (!patchedAboutMatch || patchedAboutMatch.index === undefined)
    ) {
      continue;
    }

    const appGetVersionRef = aboutMatch?.[1] ?? patchedAboutMatch?.[1] ?? "";
    let patchedContent = content;
    const pendingPatches: AboutPanelNeedle[] = [];

    const aboutResult: RegexPatchResult = applyRegexPatch(
      patchedContent,
      ABOUT_DETAIL_REGEX,
      (_full, getVersionCall) => {
        return buildInjectedDetail(getVersionCall);
      },
    );

    if (aboutResult.matched) {
      patchedContent = aboutResult.content;
      pendingPatches.push({
        id: "linux-about-panel-version",
        description:
          "Augment the About Factory dialog to show droid CLI version, " +
          "port build SHA, and update status from the updater daemon",
        originalSnippet: aboutMatch?.[0] ?? "",
        replacementSnippet:
          `detail:(runtime IIFE reading build-info.json + state.json, ` +
          `fallback: ${appGetVersionRef})`,
      });
    }

    const chipMatch = patchedContent.match(VISIBLE_VERSION_CHIP_REGEX);
    if (chipMatch && chipMatch.index !== undefined) {
      const chipResult: RegexPatchResult = applyRegexPatch(
        patchedContent,
        VISIBLE_VERSION_CHIP_REGEX,
        (_full, windowRef, originalHandlerBody) => {
          return buildInjectedVisibleVersionChip(
            windowRef,
            originalHandlerBody,
            appGetVersionRef,
          );
        },
      );

      if (chipResult.matched) {
        patchedContent = chipResult.content;
        pendingPatches.push({
          id: "linux-visible-version-chip",
          description:
            "Inject a small visible frontend version/status chip after the " +
            "renderer finishes loading",
          originalSnippet: chipMatch[0],
          replacementSnippet:
            "webContents did-finish-load handler with version chip injection",
        });
      }
    }

    if (pendingPatches.length === 0) continue;

    try {
      await applyAsarContentPatch(
        options.asarPath,
        bundleFile,
        patchedContent,
      );
    } catch (err) {
      errors.push(
        `Failed to apply patch to ${bundleFile} in asar: ${String(err)}`,
      );
      continue;
    }

    totalPatchCount += pendingPatches.length;
    patches.push(...pendingPatches);
  }

  const patchedHash = computeFileHash(options.asarPath);

  if (alreadyPatched && totalPatchCount === 0) {
    return {
      success: true,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [],
      warnings,
    };
  }

  if (errors.length > 0) {
    return {
      success: false,
      patched: totalPatchCount > 0,
      originalHash,
      patchedHash,
      patchCount: totalPatchCount,
      patches,
      errors,
      warnings,
    };
  }

  if (totalPatchCount === 0) {
    warnings.push(
      "No about panel patches were applied. The asar may already be " +
        "patched, or no About Factory detail string was found.",
    );
  }

  return {
    success: true,
    patched: totalPatchCount > 0,
    originalHash,
    patchedHash,
    patchCount: totalPatchCount,
    patches,
    errors,
    warnings,
  };
}

// ─── Validation Functions ───────────────────────────────────────────────────

export function validateAboutPanel(
  options: ValidateAboutPanelOptions,
): ValidateAboutPanelResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      aboutPanelPatched: false,
      visibleVersionChipPatched: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  let aboutPanelPatched = false;
  let visibleVersionChipPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (content.includes(PATCH_MARKER)) {
      aboutPanelPatched = true;
    }
    if (content.includes(CHIP_PATCH_MARKER)) {
      visibleVersionChipPatched = true;
    }
  }

  if (!aboutPanelPatched) {
    errors.push("About dialog version patch marker not found.");
  }
  if (!visibleVersionChipPatched) {
    errors.push("Visible frontend version chip patch marker not found.");
  }

  const valid = errors.length === 0;

  return {
    valid,
    aboutPanelPatched,
    visibleVersionChipPatched,
    errors,
    warnings,
  };
}

// ─── Formatting Functions ────────────────────────────────────────────────────

export function formatAboutPanelPatchResult(
  result: AboutPanelPatchResult,
): string {
  const lines: string[] = [
    `About Panel Patch: ${result.success ? "✓ success" : "✗ failed"}`,
    `  Patched: ${result.patched ? "yes" : "no"}`,
    `  Patch count: ${result.patchCount}`,
    `  Original hash: ${result.originalHash}`,
    `  Patched hash: ${result.patchedHash}`,
  ];

  if (result.patches.length > 0) {
    lines.push("  Needles:");
    for (const p of result.patches) {
      lines.push(`    - ${p.id}: ${p.description}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("  Errors:");
    for (const e of result.errors) lines.push(`    - ${e}`);
  }

  if (result.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const w of result.warnings) lines.push(`    - ${w}`);
  }

  return lines.join("\n");
}

export function formatAboutPanelValidationResult(
  result: ValidateAboutPanelResult,
): string {
  const lines: string[] = [
    `About Panel Validation: ${result.valid ? "✓ valid" : "✗ invalid"}`,
    `  About dialog patched: ${result.aboutPanelPatched ? "yes" : "no"}`,
    `  Visible chip patched: ${result.visibleVersionChipPatched ? "yes" : "no"}`,
  ];

  if (result.errors.length > 0) {
    lines.push("  Errors:");
    for (const e of result.errors) lines.push(`    - ${e}`);
  }

  if (result.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const w of result.warnings) lines.push(`    - ${w}`);
  }

  return lines.join("\n");
}
