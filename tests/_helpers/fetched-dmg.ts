import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Resolve a previously-fetched official Factory Desktop DMG from the local
 * work/ directory. Returns "" when none has been fetched yet, so callers can
 * keep their `existsSync ? describe : describe.skip` guards.
 *
 * This replaces the old hardcoded `/home/thewind/Downloads/Factory-*.dmg`
 * paths: the DMG is now fetched dynamically from Factory's endpoint.
 */
export function resolveFetchedDmg(arch: "x64" | "arm64"): string {
  const workDir = path.join(REPO_ROOT, "work");
  if (!fs.existsSync(workDir)) return "";
  const re = new RegExp(`Factory-\\d+\\.\\d+\\.\\d+-${arch}\\.dmg$`);
  const match = fs.readdirSync(workDir).find((f) => re.test(f));
  return match ? path.join(workDir, match) : "";
}
