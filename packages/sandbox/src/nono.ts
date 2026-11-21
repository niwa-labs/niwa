/**
 * nono: the process class, a capability sandbox.
 *
 * nono is deny-by-default: nothing is readable or writable until it is granted. The manifest is
 * the flag list nono is run with. Writing, the network and sockets map one to one. Reading is an
 * allow-list in nono, so a `denyRead` entry needs no flag: what was never granted is already closed.
 * Carving a hole out of a granted directory cannot be said, so a `denyRead` that overlaps a place the
 * box may read or write is refused rather than weakened. So is one that a place nono grants on its own
 * (the system directories, the temp areas) covers: nono is asked, and a read it would allow is not
 * left to look closed. nono runs with a `HOME` and PATH of its own, the host's; the spec's environment is set on the command inside.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Sandbox, SandboxManifest } from "./sandbox.ts";
import { SandboxUnavailable, SandboxUnsupported } from "./sandbox.ts";
import type { BoxSpec } from "./spec.ts";
import { boxSpec } from "./spec.ts";
import { anchoredSpec } from "./paths.ts";
import { SYSTEM_PATH, probe, spawnBox } from "./spawn.ts";

/** A path as the sandbox sees it: `~` expanded, and the links of its longest existing part resolved. */
function expanded(path: string): string {
  const absolute = resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  return resolved(absolute);
}

function resolved(absolute: string): string {
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolved(parent), basename(absolute));
  }
}

/** Do two paths share a place: one is the other, or lies under it? */
function overlap(one: string, other: string): boolean {
  const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  return under(one, other) || under(other, one);
}

/**
 * What the nono process runs with: the host's, fixed. nono reads its own configuration from `HOME`
 * and finds its tools through PATH before it confines anything, so the spec's environment is not
 * given to it.
 */
function launcherEnv(): Readonly<Record<string, string>> {
  return { PATH: SYSTEM_PATH, HOME: homedir() };
}

/**
 * Where nono is started from: a place the command has no way to put files in. nono wants the
 * directory it runs in to be granted, and this is one of the system directories its default profile
 * already lets it read, so no grant is added for it.
 */
const TRUSTED_DIRECTORY = "/usr/share";

/** Would nono let the box read this path, by what it grants without being asked? `undefined` when it cannot say. */
function readable(binary: string, path: string): boolean | undefined {
  const asked = Bun.spawnSync([binary, "why", "--json", "--op", "read", "--path", path], {
    cwd: TRUSTED_DIRECTORY,
    env: { ...launcherEnv() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5_000,
  });
  try {
    const status: unknown = (JSON.parse(asked.stdout.toString()) as { status?: unknown }).status;
    return status === "allowed" ? true : status === "denied" ? false : undefined;
  } catch {
    return undefined;
  }
}

export interface NonoManifest extends SandboxManifest {
  readonly sandbox: "nono";
  /** The flags between `nono run` and the program. */
  readonly flags: readonly string[];
}

export interface NonoOptions {
  /** The nono binary. Default: `nono` found on PATH. */
  readonly binary?: string;
}

export function nono(options: NonoOptions = {}): Sandbox<NonoManifest> {
  const binary = options.binary ?? Bun.which("nono") ?? undefined;
  let probed: Promise<boolean> | undefined;
  /** What nono answered for a path, so each is asked once. */
  const memo = new Map<string, boolean | undefined>();

  const manifest = (given: BoxSpec): NonoManifest => {
    // Relative paths are read from the box's working directory, which is where nono is run: the same
    // place for the flags and for the check below.
    const spec = anchoredSpec(given);
    const granted = [spec.cwd, ...spec.read, ...spec.write].map(expanded);
    const carved = spec.denyRead.find((denied) => granted.some((place) => overlap(expanded(denied), place)));
    if (carved !== undefined) {
      throw new SandboxUnsupported("nono", `reads are an allow-list there, so ${carved} cannot be carved out of a place the box may use`);
    }
    if (binary !== undefined) {
      for (const denied of spec.denyRead) {
        const open = memo.get(denied) ?? readable(binary, expanded(denied));
        memo.set(denied, open);
        if (open !== false) {
          throw new SandboxUnsupported(
            "nono",
            `reads are an allow-list there, and ${denied} ${open ? "is inside a place it grants by default" : "could not be checked against what it grants by default"}`,
          );
        }
      }
    }
    const net = spec.net.length === 0 ? ["--block-net"] : spec.net.flatMap((host) => ["--allow-domain", host]);
    return {
      sandbox: "nono",
      cwd: spec.cwd,
      env: spec.env,
      flags: [
        "--silent",
        "--read", spec.cwd,
        ...spec.read.flatMap((path) => ["--read", path]),
        ...spec.write.flatMap((path) => ["--allow", path]),
        ...spec.sockets.flatMap((path) => ["--allow-unix-socket", path]),
        ...net,
      ],
    };
  };

  /** The wrapper's own command, up to the one it runs. */
  const wrapped = (flags: readonly string[]) => {
    if (!binary) throw new SandboxUnavailable("nono", "the nono binary is not on PATH");
    return [binary, "run", ...flags, "--"];
  };

  return {
    name: "nono",
    class: "process",
    manifest,
    available() {
      probed ??= (async () => {
        if (!binary) return false;
        const dir = await mkdtemp(join(tmpdir(), "niwa-nono-probe-"));
        try {
          const config = manifest(boxSpec({ cwd: dir }));
          return await probe("nono", wrapped(config.flags), dir, launcherEnv(), TRUSTED_DIRECTORY);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return probed;
    },
    async launch(spec, argv, options) {
      const config = manifest(spec);
      return spawnBox("nono", wrapped(config.flags), { cwd: config.cwd, env: config.env, argv }, launcherEnv(), TRUSTED_DIRECTORY, async () => {}, options);
    },
  };
}
