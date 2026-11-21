/**
 * command.ts — `niwa skill`: print the skill niwa ships, and install it for the agents that read it.
 *
 * Nothing here talks to a host: the skill is a file of niwa's own, so these commands work with
 * no host up. Where each kind of harness reads skills from is declared by the kind
 * (its skill roots); this command only asks, and is given the list of kinds by
 * whoever runs it: a client knows no harness.
 *
 *     niwa skill                                  print the text
 *     niwa skill install --harness <kind>[,<kind>...]|all [--project [<dir>]] [--dry-run] [--force]
 *     niwa skill status [--harness ...] [--project [<dir>]]
 *     niwa skill uninstall --harness ... [--project [<dir>]] [--dry-run] [--force]
 *
 * Kinds that read the same directory give one file: the paths are deduplicated.
 */

import { resolve } from "node:path";

import { installSkill, skillFile, skillText, stateOf, uninstallSkill } from "./install.ts";
import type { CliResult } from "../index.ts";

export const SKILL_USAGE =
  "niwa skill [install|status|uninstall] --harness <kind>[,<kind>...]|all [--project [<dir>]] [--dry-run] [--force]";

/** The directories of skills a kind reads: the user's (given the home of the user), and the project's (relative to the project). */
export interface SkillRoots {
  readonly user: (home: string) => string;
  readonly project: string;
}

/** A kind of harness that reads skills, and where. */
export interface SkillKind {
  readonly kind: string;
  readonly roots: SkillRoots;
}

/** Where a run of the command is: the home of the user and the working directory. */
export interface SkillContext {
  readonly home: string;
  readonly cwd: string;
}

interface Options {
  readonly kinds: readonly string[] | undefined;
  readonly project: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
}

/** One directory of skills, and the kinds that read it. */
interface Target {
  readonly file: string;
  readonly kinds: string[];
}

/** Run `niwa skill ...`: `args` is what follows the word `skill`, `kinds` the kinds that read skills. */
export function runSkill(args: readonly string[], context: SkillContext, kinds: readonly SkillKind[]): CliResult {
  const [sub, ...rest] = args;
  if (sub === undefined) return { output: skillText().trimEnd(), code: 0 };
  if (sub !== "install" && sub !== "status" && sub !== "uninstall") {
    return fail(`there is no "niwa skill ${sub}"; usage: ${SKILL_USAGE}`);
  }
  try {
    const options = optionsOf(rest, context, kinds);
    if (options.kinds === undefined && sub !== "status") {
      return fail(`niwa skill ${sub} needs --harness <kind>[,<kind>...]|all; kinds: ${knownKinds(kinds)}`);
    }
    const targets = targetsOf(options, context, kinds);
    return sub === "status" ? status(targets) : sub === "install" ? install(targets, options) : uninstall(targets, options);
  } catch (error) {
    if (error instanceof SkillUsageError) return fail(error.message);
    throw error;
  }
}

class SkillUsageError extends Error {
  override name = "SkillUsageError";
}

function fail(message: string): CliResult {
  return { output: message, code: 1 };
}

function knownKinds(kinds: readonly SkillKind[]): string {
  return kinds.map((entry) => entry.kind).join(", ");
}

function optionsOf(args: readonly string[], context: SkillContext, known: readonly SkillKind[]): Options {
  let kinds: string[] | undefined;
  let project: string | undefined;
  let dryRun = false;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--harness") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new SkillUsageError("--harness needs a kind, a list of kinds, or all");
      index += 1;
      kinds = kindsOf(value, known);
    } else if (argument === "--project") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        index += 1;
        project = resolve(context.cwd, value);
      } else {
        project = context.cwd;
      }
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--force") {
      force = true;
    } else {
      throw new SkillUsageError(`unexpected argument "${String(argument)}"; usage: ${SKILL_USAGE}`);
    }
  }
  return { kinds, project, dryRun, force };
}

/** The kinds a `--harness` value names: `all`, or a list; one that reads no skills is refused. */
function kindsOf(value: string, known: readonly SkillKind[]): string[] {
  const named = value.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "");
  if (named.length === 0) throw new SkillUsageError("--harness needs a kind, a list of kinds, or all");
  if (named.includes("all")) return known.map((entry) => entry.kind);
  for (const kind of named) {
    if (!known.some((entry) => entry.kind === kind)) {
      throw new SkillUsageError(
        `no skill root is declared for the harness kind "${kind}"; kinds with one: ${knownKinds(known)}. ` +
          `Paste the output of "niwa skill" into its instructions instead.`,
      );
    }
  }
  return named;
}

/** The files the options name, one per directory, with the kinds that read it. */
function targetsOf(options: Options, context: SkillContext, known: readonly SkillKind[]): Target[] {
  const wanted = options.kinds ?? known.map((entry) => entry.kind);
  const byFile = new Map<string, Target>();
  for (const entry of known) {
    if (!wanted.includes(entry.kind)) continue;
    const root = options.project === undefined ? entry.roots.user(context.home) : resolve(options.project, entry.roots.project);
    const file = skillFile(root);
    const existing = byFile.get(file);
    if (existing === undefined) byFile.set(file, { file, kinds: [entry.kind] });
    else existing.kinds.push(entry.kind);
  }
  return [...byFile.values()];
}

function status(targets: readonly Target[]): CliResult {
  const lines = targets.map((target) => `${stateOf(target.file)} ${target.file} (${target.kinds.join(", ")})`);
  return { output: lines.join("\n"), code: 0 };
}

function install(targets: readonly Target[], options: Options): CliResult {
  let code = 0;
  const lines = targets.map((target) => {
    const outcome = installSkill(target.file, options);
    if (outcome === "skipped") {
      code = 1;
      return `skipped ${target.file}: edited by hand; --force overwrites it`;
    }
    if (outcome === "unchanged") return `unchanged ${target.file}`;
    return options.dryRun ? `would write ${target.file}` : target.file;
  });
  return { output: lines.join("\n"), code };
}

function uninstall(targets: readonly Target[], options: Options): CliResult {
  let code = 0;
  const lines = targets.map((target) => {
    const outcome = uninstallSkill(target.file, options);
    if (outcome === "skipped") {
      code = 1;
      return `skipped ${target.file}: edited by hand; --force removes it`;
    }
    if (outcome === "absent") return `absent ${target.file}`;
    return `${options.dryRun ? "would remove" : "removed"} ${target.file}`;
  });
  return { output: lines.join("\n"), code };
}
