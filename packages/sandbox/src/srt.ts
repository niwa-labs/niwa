/**
 * srt, Anthropic's sandbox-runtime: the process class, first.
 *
 * The adapter writes srt's settings and runs the srt CLI as its own process for each session.
 * It never calls the SandboxManager in-process: that keeps module-global state, and two sessions
 * with different specs would share it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sandbox, SandboxManifest } from "./sandbox.ts";
import { SandboxUnavailable } from "./sandbox.ts";
import type { BoxSpec } from "./spec.ts";
import { boxSpec } from "./spec.ts";
import { anchoredSpec } from "./paths.ts";
import { probe, spawnBox } from "./spawn.ts";

/** The part of srt's settings file this adapter writes. */
export interface SrtSettings {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly allowUnixSockets: readonly string[];
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
}

export interface SrtManifest extends SandboxManifest {
  readonly sandbox: "srt";
  readonly settings: SrtSettings;
}

/** srt finds its shell through PATH, so the process always has one: the system's, unless the spec lists its own. */
const SYSTEM_PATH = "/usr/bin:/bin";

function withPath(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return "PATH" in env ? env : { PATH: SYSTEM_PATH, ...env };
}

/** The srt CLI as a command: the package's own entry run by the current runtime, not found through PATH. */
function packagedCommand(): string[] | undefined {
  try {
    return [process.execPath, Bun.fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js"))];
  } catch {
    return undefined;
  }
}

export interface SrtOptions {
  /** The srt command. Default: the installed `@anthropic-ai/sandbox-runtime`. */
  readonly command?: readonly string[];
}

export function srt(options: SrtOptions = {}): Sandbox<SrtManifest> {
  const command = options.command ?? packagedCommand();
  let probed: Promise<boolean> | undefined;

  // Relative paths are read from the box's working directory, where srt is run, not from the host's.
  const manifest = (given: BoxSpec): SrtManifest => {
    const spec = anchoredSpec(given);
    return {
      sandbox: "srt",
      cwd: spec.cwd,
      env: withPath(spec.env),
      settings: {
        network: { allowedDomains: spec.net, deniedDomains: [], allowUnixSockets: spec.sockets },
        filesystem: { denyRead: spec.denyRead, allowWrite: spec.write, denyWrite: [] },
      },
    };
  };

  const wrapped = (settingsPath: string, argv: readonly string[]) => {
    if (!command) throw new SandboxUnavailable("srt", "@anthropic-ai/sandbox-runtime is not installed");
    return [...command, "--settings", settingsPath, "--", ...argv];
  };

  return {
    name: "srt",
    class: "process",
    manifest,
    available() {
      probed ??= (async () => {
        if (!command) return false;
        const dir = await mkdtemp(join(tmpdir(), "niwa-srt-probe-"));
        try {
          const path = join(dir, "settings.json");
          await writeFile(path, JSON.stringify(manifest(boxSpec({ cwd: dir })).settings));
          return await probe(wrapped(path, ["/usr/bin/true"]), dir, withPath({}));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return probed;
    },
    async launch(spec, argv, options) {
      const config = manifest(spec);
      const dir = await mkdtemp(join(tmpdir(), "niwa-srt-"));
      const cleanup = () => rm(dir, { recursive: true, force: true });
      try {
        const path = join(dir, "settings.json");
        await writeFile(path, JSON.stringify(config.settings), { mode: 0o600 });
        return spawnBox("srt", wrapped(path, argv), config.cwd, config.env, cleanup, options);
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}
