/**
 * nono: the process class, a capability sandbox.
 *
 * nono is deny-by-default: nothing is readable or writable until it is granted. The manifest is
 * the flag list nono is run with. Writing, the network and sockets map one to one; a path that is a
 * file is granted as a file, since nono takes a directory flag only for a directory. Reading is an
 * allow-list in nono, so a `closed` entry needs no flag: what was never granted is already closed,
 * and a place granted inside a closed one stays granted. Carving a hole out of a granted directory
 * cannot be said, so a `closed` place inside a place the box may read or write is refused rather
 * than weakened, and that includes the system places the profile grants: a read it would allow is
 * not left to look closed.
 * nono runs with a `HOME` and PATH of its own, the host's; the spec's environment is set on the command inside.
 *
 * Writing is held to `write` exactly and reading to the cwd, `read` and the places a process needs to
 * run. nono's default profile also lets a process write the shared temp areas and read all of
 * `/private` (on macOS the user's own temp directory is there), so every run is given a profile of the
 * host's that is the default one without those groups, the system places named one by one. nono is
 * asked before the first launch how it resolves that profile: one that grants more than is named here
 * is not available.
 */

import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { BoxPolicy, Sandbox, SandboxManifest } from "./sandbox.ts";
import { BoxRefused, SandboxUnavailable, socketBindRefusals } from "./sandbox.ts";
import type { BoxSpec } from "./spec.ts";
import { boxSpec } from "./spec.ts";
import { anchoredSpec } from "./paths.ts";
import { SYSTEM_PATH, probe, proxyCommand, spawnBox } from "./spawn.ts";

/** A path with a leading `~` made the home directory, and otherwise as it is spelled. */
function homeExpanded(path: string): string {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/** A path as the sandbox sees it: `~` expanded, and the links of its longest existing part resolved. */
function expanded(path: string): string {
  return resolved(homeExpanded(path));
}

const distinct = (paths: readonly string[]): string[] => [...new Set(paths)];

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

/** Is the place at this path a file? A path that is not there is taken for a directory to be made. */
function isFile(path: string): boolean {
  try {
    return statSync(homeExpanded(path)).isFile();
  } catch {
    return false;
  }
}

/** The flag that grants a path for reading, or for reading and writing: a file's flag for a file. */
function grant(path: string, mode: "read" | "write"): string[] {
  const file = isFile(path);
  if (mode === "read") return [file ? "--read-file" : "--read", path];
  return [file ? "--allow-file" : "--allow", path];
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
  readonly command_policies?: ReturnType<typeof keychainPolicy>;
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

/** Bun's os.userInfo() can use the environment instead of the effective UID. */
function keychainAccount(): string {
  const id = Bun.spawnSync(["/usr/bin/id", "-un"], {
    cwd: TRUSTED_DIRECTORY, env: { PATH: SYSTEM_PATH }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000,
  });
  const account = id.stdout.toString().trim();
  if (id.exitCode !== 0 || account.length === 0 || /[\x00-\x1f\x7f]/u.test(account)) {
    throw new BoxRefused([{ code: "adapter", message: "nono cannot resolve the current macOS Keychain account" }], "nono");
  }
  return account;
}

function keychainPolicy(services: readonly string[], account: string) {
  return {
    commands: {
      security: {
        executable: "/usr/bin/security",
        from: {
          session: {
            sandbox: { keychain_access: "read" },
            invocation_policy: {
              default: "deny",
              allow: services.map((service) => ({
                argv: { exact: ["find-generic-password", "-a", account, "-w", "-s", service] },
              })),
            },
          },
        },
      },
    },
  };
}

export interface NonoManifest extends SandboxManifest {
  readonly sandbox: "nono";
  readonly policy: BoxPolicy;
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

const UNIX_SOCKET_DIR_BIND = "--allow-unix-socket-dir-bind";

function checkedBindDirs(spec: BoxSpec, platform: NodeJS.Platform): string[] {
  if (spec.unixSocketBind.length === 0) return [];
  if (platform !== "darwin") {
    throw new BoxRefused([{ code: "adapter", message: `nono on ${platform} cannot guarantee direct-child Unix socket bind permissions` }], "nono");
  }
  const writable = spec.write.map(expanded);
  return distinct(spec.unixSocketBind.map(expanded)).map((dir) => {
    let directory = false;
    try {
      directory = statSync(dir).isDirectory();
    } catch {
      // nono must be able to resolve the directory before starting the command.
    }
    if (!directory) {
      throw new BoxRefused([{ code: "adapter", message: `Unix socket bind requires an existing directory: ${dir}` }], "nono");
    }
    // nono's flag implies a filesystem write grant. Require that access independently.
    if (!writable.some((root) => covers(root, dir))) {
      throw new BoxRefused([{ code: "adapter", message: `Unix socket bind directory ${dir} requires a separate filesystem write grant` }], "nono");
    }
    return dir;
  });
}

export function nono(options: NonoOptions = {}): Sandbox<NonoManifest> {
  const binary = options.binary ?? Bun.which("nono") ?? undefined;
  const platform = options.platform ?? process.platform;
  let probed: Promise<boolean> | undefined;
  let supportsSocketBind: boolean | undefined;
  let accountName: string | undefined;
  const system = systemReads(platform).map(expanded);

  const manifest = (given: BoxSpec): NonoManifest => {
    // macOS opens all addresses and ports for a listen grant; Linux can match the port only.
    if (given.listen !== undefined) {
      throw new BoxRefused([{ code: "adapter", message: "nono cannot restrict a TCP loopback listener to the requested address and port" }], "nono");
    }
    // Relative paths are read from the box's working directory, which is where nono is run: the same
    // place for the flags and for the check below.
    const spec = anchoredSpec(given);
    const services = distinct(spec.keychainRead ?? []);
    if (services.length > 0 && platform !== "darwin") throw new BoxRefused([{ code: "adapter", message: "Keychain requires macOS" }], "nono");
    const account = services.length === 0 ? undefined : (accountName ??= keychainAccount());
    const bindDirs = checkedBindDirs(spec, platform);
    // A socket is granted for reading as well, so it is a place the box may read; so is every place
    // the profile grants on its own.
    const granted = [
      ...[spec.cwd, ...spec.read, ...spec.write, ...spec.sockets].map((place) => ({ place: expanded(place), by: place })),
      ...[...system, ...systemWrites(platform).map(expanded)].map((place) => ({ place, by: `${place} (a system place every box uses)` })),
    ];
    const carved = spec.closed.flatMap((closed) => {
      const boundary = expanded(closed);
      const inside = granted.find(({ place }) => covers(place, boundary) || covers(boundary, place));
      if (inside === undefined) return [];
      const message = covers(inside.place, boundary)
        ? `nono cannot keep ${closed} closed inside ${inside.by}, which the box may use: its reads are an allow-list`
        : `nono cannot open ${inside.by} inside ${closed}, which is closed`;
      return [{ code: "adapter" as const, message }];
    });
    if (carved.length > 0) throw new BoxRefused(carved, "nono");
    const net = spec.net.length === 0 ? ["--block-net"] : spec.net.flatMap((host) => ["--allow-domain", host]);
    const config: NonoManifest = {
      sandbox: "nono",
      cwd: spec.cwd,
      env: account === undefined ? spec.env : { ...spec.env, USER: account },
      policy: {
        write: distinct(spec.write.map(homeExpanded)),
        devices: systemWrites(platform),
        read: { only: distinct([...[spec.cwd, ...spec.read, ...spec.write, ...spec.sockets].map(homeExpanded), ...systemReads(platform)]) },
        net: spec.net,
        ...(services.length === 0 ? {} : { keychainRead: services }),
        ...(bindDirs.length === 0 ? {} : { unixSocketBind: bindDirs }),
      },
      profile: { ...profileFor(platform), ...(account === undefined ? {} : { command_policies: keychainPolicy(services, account) }) },
      flags: [
        "--silent",
        "--read", spec.cwd,
        ...spec.read.flatMap((path) => grant(path, "read")),
        ...spec.write.flatMap((path) => grant(path, "write")),
        ...spec.sockets.flatMap((path) => ["--allow-unix-socket", path]),
        ...bindDirs.flatMap((dir) => [UNIX_SOCKET_DIR_BIND, dir]),
        ...net,
      ],
    };
    const refusals = socketBindRefusals(spec, config);
    if (refusals.length > 0) throw new BoxRefused(refusals, "nono");
    return config;
  };

  function requireSocketBindFlag() {
    if (!binary) throw new SandboxUnavailable("nono", "the nono binary is not on PATH");
    supportsSocketBind ??= (() => {
      const help = Bun.spawnSync([binary, "run", "--help"], {
        cwd: TRUSTED_DIRECTORY, env: { ...launcherEnv() }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000,
      });
      return help.exitCode === 0 && help.stdout.toString().split("\n").some((line) =>
        line.trimStart().startsWith(`${UNIX_SOCKET_DIR_BIND} `),
      );
    })();
    if (!supportsSocketBind) throw new BoxRefused([{ code: "adapter", message: `the installed nono does not support ${UNIX_SOCKET_DIR_BIND}` }], "nono");
  }

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
      if (config.policy.unixSocketBind?.length) requireSocketBindFlag();
      const wrapper = await wrapped(config);
      try {
        const guest = { cwd: config.cwd, env: config.env, keychain: config.policy.keychainRead !== undefined, argv: proxyCommand(spec.net, argv) };
        return spawnBox("nono", wrapper.command, guest, launcherEnv(), TRUSTED_DIRECTORY, wrapper.cleanup, options);
      } catch (error) {
        await wrapper.cleanup();
        throw error;
      }
    },
  };
}
