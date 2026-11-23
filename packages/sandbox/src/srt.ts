/**
 * srt, Anthropic's sandbox-runtime: the process class, first.
 *
 * The adapter writes srt's settings and runs the srt CLI as its own process for each session.
 * It never calls the SandboxManager in-process: that keeps module-global state, and two sessions
 * with different specs would share it.
 *
 * srt adds places of its own to what a spec lists, and the manifest's policy says so: the temp
 * directory it hands the process and a few places under the home are always writable, and reads
 * are open but for the spec's `closed` places, which are denied to reading and writing alike. A
 * denied place wins over anything granted inside it, so a place the spec grants inside a closed one
 * is refused rather than left unreachable.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { BoxPolicy, Sandbox, SandboxManifest } from "./sandbox.ts";
import { BoxRefused, SandboxUnavailable } from "./sandbox.ts";
import type { BoxRefusal } from "./sandbox.ts";
import type { BoxSpec } from "./spec.ts";
import { boxSpec } from "./spec.ts";
import { anchoredSpec } from "./paths.ts";
import { SYSTEM_PATH, probe, proxyCommand, spawnBox } from "./spawn.ts";

/**
 * A path as srt is to read it: the name and nothing else. A plain string is also a pattern wherever
 * it has `*`, `?` or `[`, so an entry that does not exist yet would grant its neighbours as well.
 */
export interface SrtPath {
  readonly path: string;
  readonly literal: true;
}

/** The part of srt's settings file this adapter writes. */
export interface SrtSettings {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly allowUnixSockets: readonly string[];
  };
  readonly filesystem: {
    readonly denyRead: readonly SrtPath[];
    readonly allowWrite: readonly SrtPath[];
    readonly denyWrite: readonly SrtPath[];
  };
}

export interface SrtManifest extends SandboxManifest {
  readonly sandbox: "srt";
  readonly policy: BoxPolicy;
  readonly settings: SrtSettings;
}

/**
 * What the srt process runs with: the host's, fixed. srt finds its shell and the system's tools
 * through PATH before it confines anything, so the spec's environment is not given to it.
 */
const LAUNCHER_ENV: Readonly<Record<string, string>> = { PATH: SYSTEM_PATH };

/** The command's environment: its PATH is the system's unless the spec lists its own. */
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
  /** The platform srt runs on. Default: this one. */
  readonly platform?: NodeJS.Platform;
}

const literally = (paths: readonly string[]): SrtPath[] => paths.map((path) => ({ path, literal: true }));

/** The devices srt always lets a process write. */
const SRT_DEVICES = ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"];

/** The temp directory srt gives every process, writable whatever the settings say. */
const SRT_TEMP = ["/tmp/claude", "/private/tmp/claude"];

/** Places under the home srt makes writable unless a closed place covers them. */
const SRT_HOME_WRITES = [".npm/_logs", ".claude/debug"];

function homeExpanded(path: string): string {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/** What srt will let a process reach: the spec's places, and the ones srt adds of its own. */
/** Is `path` the place `root` names, or under it? */
function covers(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function srtPolicy(spec: BoxSpec): BoxPolicy {
  const denied = spec.closed.map(homeExpanded);
  const covered = (path: string) => denied.some((root) => covers(root, path));
  const home = SRT_HOME_WRITES.map((place) => join(homedir(), place)).filter((path) => !covered(path));
  return {
    write: [...new Set([...spec.write.map(homeExpanded), ...SRT_TEMP, ...home])],
    devices: SRT_DEVICES,
    read: { except: denied },
    net: spec.net,
  };
}

export function srt(options: SrtOptions = {}): Sandbox<SrtManifest> {
  const command = options.command ?? packagedCommand();
  const platform = options.platform ?? process.platform;
  let probed: Promise<boolean> | undefined;

  // Relative paths are read from the box's working directory, where srt is run, not from the host's.
  const manifest = (given: BoxSpec): SrtManifest => {
    // SRT can enable all local bindings on macOS or isolate the whole network namespace on Linux.
    if (given.listen !== undefined) {
      throw new BoxRefused([{ code: "adapter", message: "srt cannot restrict a TCP loopback listener to the requested address and port" }], "srt");
    }
    if (given.keychainRead?.length) throw new BoxRefused([{ code: "adapter", message: "srt cannot restrict Keychain reads to the requested services" }], "srt");
    if (given.unixSocketBind.length > 0) {
      throw new BoxRefused([{ code: "adapter", message: "srt cannot restrict Unix socket bind to the requested directories" }], "srt");
    }
    const spec = anchoredSpec(given);
    const reasons: BoxRefusal[] = [];
    // On Linux srt cannot filter a socket by its path: the list is ignored, and the box would run
    // with the socket the spec promises it closed to the process.
    if (platform === "linux" && spec.sockets.length > 0) {
      reasons.push({ code: "adapter", message: "srt on Linux cannot allow a unix socket by its path" });
    }
    const closed = spec.closed.map((path) => ({ path, place: homeExpanded(path) }));
    for (const place of [spec.cwd, ...spec.read, ...spec.write, ...spec.sockets]) {
      const within = closed.find((one) => covers(one.place, homeExpanded(place)));
      if (within !== undefined) reasons.push({ code: "adapter", message: `srt cannot open ${place} inside ${within.path}, which is closed: a denied place wins over what lies in it` });
    }
    if (reasons.length > 0) throw new BoxRefused(reasons, "srt");
    return {
      sandbox: "srt",
      cwd: spec.cwd,
      env: withPath(spec.env),
      policy: srtPolicy(spec),
      settings: {
        network: { allowedDomains: spec.net, deniedDomains: [], allowUnixSockets: spec.sockets },
        filesystem: { denyRead: literally(spec.closed), allowWrite: literally(spec.write), denyWrite: literally(spec.closed) },
      },
    };
  };

  /** The wrapper's own command, up to the one it runs. */
  const wrapped = (settingsPath: string) => {
    if (!command) throw new SandboxUnavailable("srt", "@anthropic-ai/sandbox-runtime is not installed");
    return [...command, "--settings", settingsPath, "--"];
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
          return await probe("srt", wrapped(path), dir, LAUNCHER_ENV, dir);
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
        // srt runs from the directory that holds its settings: no one but this process has written there.
        return spawnBox("srt", wrapped(path), { cwd: config.cwd, env: config.env, argv: proxyCommand(spec.net, argv) }, LAUNCHER_ENV, dir, cleanup, options);
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}
