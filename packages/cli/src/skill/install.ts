/**
 * The skill niwa ships for the agents that use it: the text, its stamp, and putting it on disk.
 *
 * The text is `SKILL.md` beside this file. A file niwa installs ends with a stamp line,
 * `<!-- niwa skill <version> <sha> -->`, where the sha is that of the text above it. The stamp
 * says whether a file on disk is niwa's current text, an older text of niwa's, or something a
 * person edited: niwa overwrites the first two and leaves the third alone unless it is forced.
 *
 * This module knows nothing of harnesses: it is given the directories of skills.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The version of the package this skill ships in: read from the `package.json` that sits two
 * directories above this file, by path, so the skill depends on no import of it.
 */
function versionOfPackage(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const version = manifest !== null && typeof manifest === "object" ? (manifest as { version?: unknown }).version : undefined;
  if (typeof version !== "string") throw new Error("package.json has no version: the skill cannot be stamped");
  return version;
}

const VERSION = versionOfPackage();

/** The name of the skill: its directory under a skills root. */
export const SKILL_NAME = "niwa";

/** The text of the skill, as it ships: one trailing newline. */
export function skillText(): string {
  const text = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
  return `${text.trimEnd()}\n`;
}

/** The stamp of a text: the version of niwa and a short hash of the text. */
function stampOf(text: string): string {
  return `<!-- niwa skill ${VERSION} ${shaOf(text)} -->`;
}

function shaOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The file niwa installs: the text, then its stamp as the last line. */
export function installedText(): string {
  const text = skillText();
  return `${text}${stampOf(text)}\n`;
}

/** The file of the skill under a skills root. */
export function skillFile(root: string): string {
  return join(root, SKILL_NAME, "SKILL.md");
}

/**
 * How a skill file stands.
 *
 * - `absent`: there is no file;
 * - `current`: niwa's own, of the text this niwa ships;
 * - `stale`: niwa's own, of another text (an older niwa);
 * - `modified`: not as niwa wrote it: edited by hand, or never niwa's (no stamp, or a stamp that
 *   does not match the text above it).
 */
export type SkillState = "absent" | "current" | "stale" | "modified";

const STAMP = /^<!-- niwa skill (\S+) ([0-9a-f]{16}) -->$/;

/** How the file at `path` stands. */
export function stateOf(path: string): SkillState {
  if (!existsSync(path)) return "absent";
  const content = readFileSync(path, "utf8").trimEnd();
  const cut = content.lastIndexOf("\n");
  const match = STAMP.exec(content.slice(cut + 1));
  if (match === null || cut === -1) return "modified";
  const text = `${content.slice(0, cut).trimEnd()}\n`;
  if (shaOf(text) !== match[2]) return "modified";
  return content === installedText().trimEnd() ? "current" : "stale";
}

/** What putting the skill at a path did, or would do. */
export type InstallOutcome = "written" | "unchanged" | "skipped";

/**
 * Put the skill at `path`: an absent or niwa's own file is written (a current one is left as it
 * is), an edited one is written only when forced. With `dryRun` nothing is touched.
 */
export function installSkill(path: string, opts: { force: boolean; dryRun: boolean }): InstallOutcome {
  const state = stateOf(path);
  if (state === "current") return "unchanged";
  if (state === "modified" && !opts.force) return "skipped";
  if (!opts.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installedText());
  }
  return "written";
}

/** What taking the skill away at a path did, or would do. */
export type UninstallOutcome = "removed" | "absent" | "skipped";

/**
 * Take the skill away at `path`, and its directory when that is then empty. An edited file goes
 * only when forced.
 */
export function uninstallSkill(path: string, opts: { force: boolean; dryRun: boolean }): UninstallOutcome {
  const state = stateOf(path);
  if (state === "absent") return "absent";
  if (state === "modified" && !opts.force) return "skipped";
  if (!opts.dryRun) {
    rmSync(path);
    try {
      rmdirSync(dirname(path));
    } catch {
      // The directory holds something else: it is not niwa's to remove.
    }
  }
  return "removed";
}
