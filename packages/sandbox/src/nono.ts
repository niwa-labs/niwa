/**
 * nono: the process class, a capability sandbox.
 *
 * nono is deny-by-default: nothing is readable or writable until it is granted. The manifest is
 * the flag list nono is run with. Writing, the network and sockets map one to one. Reading is an
 * allow-list in nono, so a `denyRead` entry needs no flag: what was never granted is already closed.
 * Carving a hole out of a granted directory cannot be said, so a `denyRead` that overlaps a place the
 * box may read or write is refused rather than weakened, and that includes the system places the
 * profile grants: a read it would allow is not left to look closed.
 * nono runs with a `HOME` and PATH of its own, the host's; the spec's environment is set on the command inside.
 *
 * Writing is held to `write` exactly and reading to the cwd, `read` and the places a process needs to
 * run. nono's default profile also lets a process write the shared temp areas and read all of
 * `/private` (on macOS the user's own temp directory is there), so every run is given a profile of the
 * host's that is the default one without those groups, the system places named one by one. nono is
 * asked before the first launch how it resolves that profile: one that grants more than is named here
 * is not available.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Is `path` the place `root` names, or under it? */
function covers(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Do two paths share a place: one is the other, or lies under it? */
function overlap(one: string, other: string): boolean {
  return covers(one, other) || covers(other, one);
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

/**
 * The profile nono runs with: its default, less every group that lets a process read or write a place
 * the spec did not name. Those groups grant the shared temp areas (on macOS all of `/private`, which
 * holds the user's own temp directory) and the user's tools; the places a process needs to run are
 * granted again by name, and nothing else is. The groups that deny the user's credentials stay.
 */
export interface NonoProfile {
  readonly meta: { readonly name: string };
  readonly extends: "default";
  readonly groups: { readonly exclude: readonly string[] };
  readonly filesystem: { readonly read: readonly string[]; readonly write: readonly string[]; readonly write_file: readonly string[] };
}

/**
 * What a process on macOS reads to run: the system's programs, libraries and data, the link cache,
 * the time zones and the developer tools `xcode-select` points at. Not `/private` or `/var` as a whole,
 * not `/tmp`, and not `/var/folders`, where every user's temp directory is.
 */
const MACOS_READS = [
  "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec", "/usr/lib", "/usr/share", "/usr/local/bin", "/usr/local/lib",
  "/usr/local/Cellar", "/usr/local/opt", "/opt", "/nix",
  "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot/Cryptexes", "/Library", "/Applications",
  "/private/etc", "/private/var/db/dyld", "/private/var/db/timezone", "/private/var/select", "/private/var/db/xcode_select_link",
  // A path through the links at `/etc` and `/var` is matched as it is spelled, so each is named that way too.
  "/etc", "/var/db/dyld", "/var/db/timezone", "/var/select", "/var/db/xcode_select_link",
  "/dev",
] as const;

/** What nono's own Linux read group grants, kept as it is: it names no temp area. */
const LINUX_READS = [
  "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/lib", "/lib64", "/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu",
  "/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/local/lib", "/usr/local/lib64",
  "/etc/resolv.conf", "/run/systemd/resolve", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/group", "/etc/ssl",
  "/etc/pki", "/etc/ca-certificates", "/var/lib/ca-certificates", "/etc/crypto-policies", "/etc/fonts", "/etc/ld.so.cache",
  "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/localtime", "/etc/timezone", "/etc/locale.conf", "/etc/locale.gen",
  "/etc/alternatives", "/etc/os-release", "/etc/passwd", "/etc/services", "/etc/mime.types", "/etc/manpath.config",
  "/etc/man_db.conf", "/var/cache/man", "/run/systemd/userdb", "/usr/share", "/usr/share/locale", "/usr/share/locale-langpack",
  "/usr/share/zoneinfo", "/usr/share/terminfo", "/usr/share/ca-certificates", "/lib/terminfo", "/etc/terminfo", "/dev/null",
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full", "/dev/tty", "/dev/console", "/dev/stdin", "/dev/stdout",
  "/dev/stderr", "/dev/fd", "/dev/pts", "/proc/self", "/proc/cpuinfo", "/proc/meminfo", "/proc/stat", "/proc/loadavg",
  "/proc/version", "/proc/filesystems",
] as const;

/** The profile of each platform. On Linux nono's own read group is kept, so the profile names no read of its own. */
function profileFor(platform: NodeJS.Platform): NonoProfile {
  const meta = { name: "niwa-box" } as const;
  if (platform === "darwin") {
    return {
      meta,
      extends: "default",
      groups: { exclude: ["system_read_macos", "system_write_macos", "user_tools", "homebrew_macos"] },
      filesystem: { read: [...MACOS_READS], write: ["/dev"], write_file: [] },
    };
  }
  return {
    meta,
    extends: "default",
    groups: { exclude: ["system_write_linux", "user_tools", "homebrew_linux"] },
    filesystem: {
      read: [],
      write: ["/dev/fd", "/dev/pts", "/proc/self/fd"],
      write_file: ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/stdout", "/dev/stderr"],
    },
  };
}

/** Every place the profile of a platform lets a process write. */
function systemWrites(platform: NodeJS.Platform): readonly string[] {
  const profile = profileFor(platform);
  return [...profile.filesystem.write, ...profile.filesystem.write_file];
}

/** Every place the profile of a platform lets a process read, whoever grants it: the profile or a group it keeps. */
function systemReads(platform: NodeJS.Platform): readonly string[] {
  return [...(platform === "darwin" ? MACOS_READS : LINUX_READS), ...systemWrites(platform)];
}

/**
 * Does nono, resolving the profile at `path`, grant no more than the adapter says it does? A group a
 * later nono adds to its default would otherwise open places nothing here knows of, and a nono whose
 * answer cannot be read is not taken at its word either.
 */
function resolvesAsSaid(binary: string, path: string, platform: NodeJS.Platform): boolean {
  let grants: unknown;
  try {
    const shown = Bun.spawnSync([binary, "profile", "show", path, "--format", "manifest"], {
      cwd: TRUSTED_DIRECTORY,
      env: { ...launcherEnv() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    grants = (JSON.parse(shown.stdout.toString()) as { filesystem?: { grants?: unknown } }).filesystem?.grants;
  } catch {
    return false;
  }
  if (!Array.isArray(grants)) return false;
  const reads = systemReads(platform).map(expanded);
  const writes = systemWrites(platform).map(expanded);
  const within = (roots: readonly string[], place: string) => roots.some((root) => covers(root, place));
  return grants.every((grant: { access?: unknown; path?: unknown }) => {
    if (typeof grant.path !== "string") return false;
    const place = expanded(grant.path);
    if (grant.access === "read") return within(reads, place);
    if (grant.access === "write" || grant.access === "readwrite") return within(writes, place);
    return false;
  });
}

export interface NonoManifest extends SandboxManifest {
  readonly sandbox: "nono";
  /** The profile file nono is run with, put before these flags at launch. */
  readonly profile: NonoProfile;
  /** The flags between `nono run` and the program. */
  readonly flags: readonly string[];
}

export interface NonoOptions {
  /** The nono binary. Default: `nono` found on PATH. */
  readonly binary?: string;
  /** The platform nono runs on. Default: this one. */
  readonly platform?: NodeJS.Platform;
}

export function nono(options: NonoOptions = {}): Sandbox<NonoManifest> {
  const binary = options.binary ?? Bun.which("nono") ?? undefined;
  const platform = options.platform ?? process.platform;
  let probed: Promise<boolean> | undefined;
  const system = systemReads(platform).map(expanded);

  const manifest = (given: BoxSpec): NonoManifest => {
    // Relative paths are read from the box's working directory, which is where nono is run: the same
    // place for the flags and for the check below.
    const spec = anchoredSpec(given);
    // A socket is granted for reading as well, so it is a place the box may read; so is every place
    // the profile grants on its own.
    const granted = [...[spec.cwd, ...spec.read, ...spec.write, ...spec.sockets].map(expanded), ...system];
    const carved = spec.denyRead.find((denied) => granted.some((place) => overlap(expanded(denied), place)));
    if (carved !== undefined) {
      throw new SandboxUnsupported("nono", `reads are an allow-list there, so ${carved} cannot be carved out of a place the box may use`);
    }
    const net = spec.net.length === 0 ? ["--block-net"] : spec.net.flatMap((host) => ["--allow-domain", host]);
    return {
      sandbox: "nono",
      cwd: spec.cwd,
      env: spec.env,
      profile: profileFor(platform),
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

  /**
   * The wrapper's own command, up to the one it runs, and the clean-up of the profile file it names.
   * The file is the host's: written to a directory made for it, readable by this user only.
   */
  const wrapped = async (config: NonoManifest) => {
    if (!binary) throw new SandboxUnavailable("nono", "the nono binary is not on PATH");
    const dir = await mkdtemp(join(tmpdir(), "niwa-nono-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      const path = join(dir, "profile.json");
      await writeFile(path, JSON.stringify(config.profile), { mode: 0o600 });
      return { command: [binary, "run", "--profile", path, ...config.flags, "--"], profile: path, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

  return {
    name: "nono",
    class: "process",
    guarantees: { exactWrites: true, closedReads: true },
    manifest,
    available() {
      probed ??= (async () => {
        if (!binary) return false;
        const dir = await mkdtemp(join(tmpdir(), "niwa-nono-probe-"));
        let cleanup: (() => Promise<void>) | undefined;
        try {
          const wrapper = await wrapped(manifest(boxSpec({ cwd: dir })));
          cleanup = wrapper.cleanup;
          if (!resolvesAsSaid(binary, wrapper.profile, platform)) return false;
          return await probe("nono", wrapper.command, dir, launcherEnv(), TRUSTED_DIRECTORY);
        } finally {
          await cleanup?.();
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return probed;
    },
    async launch(spec, argv, options) {
      const config = manifest(spec);
      const wrapper = await wrapped(config);
      try {
        return spawnBox("nono", wrapper.command, { cwd: config.cwd, env: config.env, argv }, launcherEnv(), TRUSTED_DIRECTORY, wrapper.cleanup, options);
      } catch (error) {
        await wrapper.cleanup();
        throw error;
      }
    },
  };
}
