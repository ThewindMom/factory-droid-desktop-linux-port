/**
 * Shared asar patching utilities for version-agnostic Linux compatibility
 * patches.
 *
 * Patches are applied to the minified Vite bundles inside Factory Desktop's
 * app.asar. Because minified variable names change between upstream versions,
 * patches must match structural patterns (not exact strings) to remain
 * version-agnostic.
 *
 * This module provides:
 * - {@link computeFileHash}: SHA-256 for integrity tracking
 * - {@link findMainBundleFiles}: locates `.vite/build/index-*.js` in an asar
 * - {@link applyAsarContentPatch}: extract → patch → rebuild an asar in-place
 * - {@link applyRegexPatch}: apply a regex replacement and report whether it
 *   matched, so callers can distinguish "no match" from "already patched"
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parseIsPackEntry } from "../asar-metadata";

/** Result of a regex-based content patch. */
export interface RegexPatchResult {
  /** Whether the regex matched and the content was modified. */
  matched: boolean;
  /** The content after replacement (unchanged if no match). */
  content: string;
  /** The matched text (empty if no match). */
  match: string;
}

/**
 * Compute the SHA-256 hash of a file.
 *
 * Used for integrity tracking before/after patching.
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Find the main Vite bundle files inside an asar.
 *
 * Factory Desktop bundles its Electron main-process code as
 * `.vite/build/index-<hash>.js`. There may be multiple files; all are
 * returned so patches can scan each one.
 *
 * @returns Array of asar-internal paths, e.g. `.vite/build/index-AbC123.js`
 */
export function findMainBundleFiles(asarPath: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const rawFiles = asar.listPackage(asarPath, { isPack: true }) as string[];
  const files = rawFiles
    .map((f) => parseIsPackEntry(f))
    .filter((f): f is string => f !== null);
  return files.filter(
    (f) => f.startsWith(".vite/build/index-") && f.endsWith(".js"),
  );
}

/**
 * Replacement for `String.replace` — either a string or a function that
 * receives the match and capture groups, mirroring the native API.
 */
export type RegexReplacement =
  | string
  | ((match: string, ...groups: string[]) => string);

/**
 * Apply a regex replacement to content.
 *
 * @returns Whether the pattern matched and the resulting content.
 */
export function applyRegexPatch(
  content: string,
  pattern: RegExp,
  replacement: RegexReplacement,
): RegexPatchResult {
  const match = content.match(pattern);
  if (!match) return { matched: false, content, match: "" };
  const patched =
    typeof replacement === "function"
      ? content.replace(pattern, replacement as (substring: string, ...args: string[]) => string)
      : content.replace(pattern, replacement);
  return {
    matched: patched !== content,
    content: patched,
    match: match[0],
  };
}

/**
 * Apply a content patch to a file inside an asar archive.
 *
 * Since @electron/asar doesn't support in-place modification, this:
 * 1. Extracts the entire asar to a temp directory
 * 2. Writes the patched file
 * 3. Rebuilds the asar from the extracted contents
 * 4. Verifies the patched file is present in the rebuilt asar
 *
 * The original asar is backed up before modification and restored on failure.
 */
export async function applyAsarContentPatch(
  asarPath: string,
  filePath: string,
  patchedContent: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");

  const tmpDir = asarPath + ".patch-tmp";
  const backupPath = asarPath + ".bak";

  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    asar.extractAll(asarPath, tmpDir);
    asar.uncache(asarPath);

    const extractedFilePath = path.join(tmpDir, filePath);
    fs.writeFileSync(extractedFilePath, patchedContent, "utf-8");

    fs.copyFileSync(asarPath, backupPath);
    fs.unlinkSync(asarPath);

    await asar.createPackageWithOptions(tmpDir, asarPath, {});
    asar.uncache(asarPath);

    // Verify the patched file exists in the rebuilt asar.
    const verifyContent = asar
      .extractFile(asarPath, filePath)
      .toString("utf-8");
    if (verifyContent.length !== patchedContent.length) {
      throw new Error(
        `Verification failed: content length mismatch in rebuilt asar ` +
          `(${verifyContent.length} vs expected ${patchedContent.length})`,
      );
    }

    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch (err) {
    if (fs.existsSync(backupPath) && !fs.existsSync(asarPath)) {
      fs.copyFileSync(backupPath, asarPath);
    }
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    throw err;
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
