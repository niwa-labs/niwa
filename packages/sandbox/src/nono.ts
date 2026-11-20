/**
 * nono: the process class, a capability sandbox.
 *
 * nono is deny-by-default: nothing is readable or writable until it is granted. The manifest is
 * the flag list nono is run with. Writing, the network and sockets map one to one. Reading is an
 * allow-list in nono, so a `denyRead` entry needs no flag: what was never granted is already closed.
 * Carving a hole out of a granted directory cannot be said, so a `denyRead` that overlaps a place the
 * box may read or write is refused rather than weakened. nono also needs `HOME` in the environment; the spec lists it, since the
 * environment is only what is listed.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Sandbox, SandboxManifest } from "./sandbox.ts";
import { SandboxUnavailable, SandboxUnsupported } from "./sandbox.ts";
import type { BoxSpec } from "./spec.ts";
import { boxSpec } from "./spec.ts";
import { probe, spawnBox } from "./spawn.ts";

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

  const manifest = (spec: BoxSpec): NonoManifest => {
    const granted = [spec.cwd, ...spec.read, ...spec.write].map(expanded);
    const carved = spec.denyRead.find((denied) => granted.some((place) => overlap(expanded(denied), place)));
    if (carved !== undefined) {
      throw new SandboxUnsupported("nono", `reads are an allow-list there, so ${carved} cannot be carved out of a place the box may use`);
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

  const wrapped = (flags: readonly string[], argv: readonly string[]) => {
    if (!binary) throw new SandboxUnavailable("nono", "the nono binary is not on PATH");
    return [binary, "run", ...flags, "--", ...argv];
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
          const config = manifest(boxSpec({ cwd: dir, env: { HOME: homedir() } }));
          return await probe(wrapped(config.flags, ["/usr/bin/true"]), dir, config.env);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return probed;
    },
    async launch(spec, argv) {
      const config = manifest(spec);
      return spawnBox(wrapped(config.flags, argv), spec.cwd, config.env, async () => {});
    },
  };
}
