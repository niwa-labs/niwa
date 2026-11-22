/**
 * Finding installed harnesses and proposing instances.
 *
 * Niwa can find the harnesses installed on a machine and propose instances of them; the owner
 * confirms. This module does the finding and nothing else: it looks for the binary of each
 * kind, asks that binary for its version, and checks that the directory the harness keeps its
 * state in is there.
 *
 * What comes out is a proposal, not an instance. An instance has an id and a machine,
 * and both are the owner's to give: niwa says what it found
 * and stops there. A kind that is not installed is named in `missing`, with the reason — the
 * absence of a proposal must not read as "there is none".
 *
 * Finding a binary does not run it. The PATH is scanned for a file that is there and may be
 * run, and only the binary that was found is asked for its version: with a deadline, and with
 * a cap on what it may say.
 *
 * The record of a proposal and the action that writes it are the sessions module's
 * (`sessions/discover.ts`): this module only finds.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { z } from "zod";

import { BundledProgramSchema } from "./bundled.ts";
import { HarnessBinarySchema, HarnessKindSchema } from "./instance.ts";
import type { HarnessBinary, HarnessKind } from "./instance.ts";
import type { HarnessKindDefinition } from "./index.ts";

/** How long one version probe waits for its answer. */
const VERSION_TIMEOUT_MS = 2_000;
/** How many bytes one version probe may read. */
const VERSION_OUTPUT_CAP_BYTES = 4 * 1024;
/** The version of a binary that did not say its version. */
const UNKNOWN_VERSION = "unknown";

/**
 * How a kind is found on a machine.
 *
 * A kind declares this beside the defaults it already has: the program that runs it, the
 * environment variable that points at that program, and the directory the installation keeps
 * its state in.
 */
export const HarnessDetectionSchema = z.object({
  /** The program that runs the kind. Absent when the kind is a library and not a program. */
  binary: z.string().min(1).optional(),
  /**
   * The program niwa ships for the kind, run by the runtime that runs niwa, as the kind found it
   * (`findBundled`). It stands where the binary does when the environment does not point
   * elsewhere: it is not looked for on the PATH.
   */
  bundled: BundledProgramSchema.optional(),
  /**
   * The environment variable that points at the binary. It wins over the PATH.
   *
   * Absent means the rule: the name of the kind in capitals, then `_BIN`.
   */
  envVar: z.string().min(1).optional(),
  /** The directory the installation keeps its state in. `~` is the home of the user. */
  home: z.string().min(1),
  /** An environment variable naming the parent of the state directory. Empty values use `home`. */
  homeFromEnv: z.object({
    variable: z.string().min(1),
    subdirectory: z.string().min(1),
  }).optional(),
  /** The major version of the executable when the kind speaks only one major protocol. */
  majorVersion: z.number().int().positive().optional(),
});
export type HarnessDetection = z.output<typeof HarnessDetectionSchema>;

/**
 * An installation as it was found.
 *
 * It is not an instance: the id and the machine are the owner's, and a proposal
 * that filled them in would be inventing them.
 */
export const HarnessProposalSchema = z.object({
  /** The kind of the installation. */
  kind: HarnessKindSchema,
  /** The program that runs it, when the kind has one. */
  binary: HarnessBinarySchema.optional(),
  /** The directory the installation keeps its state in. */
  home: z.string().min(1),
});
export type HarnessProposal = z.output<typeof HarnessProposalSchema>;

/** A kind that is not installed, and why it is not. */
export const HarnessMissingSchema = z.object({
  kind: HarnessKindSchema,
  reason: z.string().min(1),
});
export type HarnessMissing = z.output<typeof HarnessMissingSchema>;

/** What the finding found: the installations that are there, and the kinds that are not. */
export interface HarnessDiscoveryResult {
  readonly proposals: readonly HarnessProposal[];
  readonly missing: readonly HarnessMissing[];
}

/** The environment the finding looks in: the PATH, the home, and the overrides of the binaries. */
export type DiscoverEnv = Readonly<Record<string, string | undefined>>;

/**
 * The environment variable that points at the binary of a kind: the name of the kind in
 * capitals, with its dashes turned into underscores, then `_BIN`.
 *
 * `claude-code` → `CLAUDE_CODE_BIN`.
 */
export function binaryEnvVarOf(kind: HarnessKind): string {
  return `${String(kind).toUpperCase().replaceAll("-", "_")}_BIN`;
}

/**
 * Find the installed harnesses of the given kinds.
 *
 * Every kind that says how it is found is looked for; a kind that does not say is named in
 * `missing`. The kinds are looked at one after another, and the order of the answer is the
 * order of the kinds.
 */
export async function discover(
  kinds: readonly HarnessKindDefinition[],
  env: DiscoverEnv,
): Promise<HarnessDiscoveryResult> {
  const proposals: HarnessProposal[] = [];
  const missing: HarnessMissing[] = [];
  for (const kind of kinds) {
    const found = await discoverKind(kind, env);
    if (found.proposal !== undefined) {
      proposals.push(found.proposal);
    } else {
      missing.push({ kind: kind.kind, reason: found.reason });
    }
  }
  return { proposals, missing };
}

/** What one kind turned out to be: an installation, or the reason it is not there. */
type Found =
  | { readonly proposal: HarnessProposal }
  | { readonly proposal?: undefined; readonly reason: string };

/** Look for one kind: its binary, its version and its home. */
async function discoverKind(kind: HarnessKindDefinition, env: DiscoverEnv): Promise<Found> {
  const detection = kind.detect;
  if (detection === undefined) {
    return { reason: "the kind does not say how it is found" };
  }
  const homeFromEnv = detection.homeFromEnv;
  const base = homeFromEnv === undefined ? undefined : env[homeFromEnv.variable];
  const home = homeFromEnv !== undefined && base
    ? resolve(base, homeFromEnv.subdirectory)
    : homeOf(detection.home, env);

  if (detection.binary === undefined && detection.bundled === undefined) {
    // A kind that is a library has no binary: the home is all there is to find.
    if (!(await isDirectory(home))) return { reason: `the home "${home}" is not there` };
    return { proposal: { kind: kind.kind, home } };
  }

  const envVar = detection.envVar ?? binaryEnvVarOf(kind.kind);
  const override = await findOverride(envVar, env);
  let binary: HarnessBinary;
  if (override === undefined && detection.bundled !== undefined) {
    const program = detection.bundled;
    if (program.path === undefined) {
      return { reason: `the bundled program "${program.package}" is not installed and ${envVar} points at nothing that is there` };
    }
    binary = { path: program.path, version: program.version ?? UNKNOWN_VERSION };
  } else {
    const path = override ?? (detection.binary === undefined ? undefined : await findOnPath(detection.binary, env));
    if (path === undefined) {
      return { reason: `the binary "${detection.binary}" is not on the PATH and ${envVar} points at nothing that is there` };
    }
    binary = { path, version: (await readVersion(path, env)) ?? UNKNOWN_VERSION };
  }
  if (detection.majorVersion !== undefined && majorVersionOf(binary.version) !== detection.majorVersion) {
    return { reason: `the binary "${binary.path}" reports "${binary.version}". This kind requires version ${detection.majorVersion}.x` };
  }
  if (!(await isDirectory(home))) return { reason: `the home "${home}" is not there` };
  return { proposal: { kind: kind.kind, binary, home } };
}

/** The major in either a bare version or a program's version line, such as `opencode v2.3.2`. */
function majorVersionOf(version: string): number | undefined {
  const major = /(?:^|\s)v?(\d+)\.\d+\.\d+\b/.exec(version)?.[1];
  return major === undefined ? undefined : Number(major);
}

/** The home of the installation: `~` is the home of the user, as the environment says it. */
function homeOf(home: string, env: DiscoverEnv): string {
  const root = env["HOME"] ?? homedir();
  if (home === "~") return root;
  if (home.startsWith("~/")) return join(root, home.slice(2));
  return home;
}

/** The binary the environment points at, when it is there and may be run. */
async function findOverride(envVar: string, env: DiscoverEnv): Promise<string | undefined> {
  const override = env[envVar];
  return override !== undefined && override !== "" && (await isExecutable(override)) ? override : undefined;
}

/**
 * Find the binary of a kind on the PATH.
 *
 * Nothing is run to find it: the directories of the PATH are scanned for a file that is there
 * and may be run.
 */
async function findOnPath(name: string, env: DiscoverEnv): Promise<string | undefined> {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Is that a file that may be run? */
async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is that a directory? */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ask a binary for its version.
 *
 * The probe is bounded: it waits two seconds and reads four kilobytes, and a binary that
 * says more or takes longer is stopped. `undefined` means the binary did not answer — it is
 * there, but it did not say what it is.
 */
function readVersion(binary: string, env: DiscoverEnv): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv(env),
    });
    let out = "";
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (version: string | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(version);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      const room = VERSION_OUTPUT_CAP_BYTES - bytes;
      if (room <= 0) return;
      out += chunk.toString("utf8", 0, room);
      bytes += Math.min(chunk.length, room);
      if (chunk.length >= room) {
        // It has said enough: the rest is not read, and the probe stops.
        child.kill("SIGKILL");
        finish(firstLine(out));
      }
    });
    child.on("error", () => finish(undefined));
    // A binary that failed did not give a version, whatever it printed.
    child.on("close", (code) => finish(code === 0 ? firstLine(out) : undefined));
  });
}

/** The first line that has something on it. */
function firstLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

/** The environment a probe runs in: the environment of the process, with the found one over it. */
function childEnv(env: DiscoverEnv): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[name] = value;
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  return merged;
}
