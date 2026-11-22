import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProfileContext } from "@niwa-labs/sandbox";

/** The active package of a versioned ncode launcher and the Node installation it pins. */
export function versionedPrograms(launcher: string, context: ProfileContext): readonly string[] | undefined {
  if (basename(launcher) !== "ncode" || basename(dirname(launcher)) !== "bin") return undefined;
  try {
    const file = statSync(launcher);
    if (!file.isFile() || file.size > 4096) return undefined;
    const script = readFileSync(launcher, "utf8");
    const revision = /^MCODE_BUILD_ID=([0-9a-f]{40})$/m.exec(script)?.[1];
    const command = /^exec (\/[^\s'"]+\/node) (\/[^\s'"]+\/cli\.js) "\$@"$/m.exec(script);
    if (!revision || !command?.[1] || !command[2]) return undefined;
    const prefix = dirname(dirname(launcher));
    const release = join("installs", "ncode", revision, "lib", "node_modules", "@niwa-labs", "ncode");
    const pkg = dirname(command[2]);
    const installed = join(realpathSync(prefix), release);
    if (realpathSync(pkg) !== installed || realpathSync(command[2]) !== join(installed, "cli.js")) return undefined;
    const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const build = JSON.parse(readFileSync(join(pkg, "release.json"), "utf8"));
    if (metadata.name !== "@niwa-labs/ncode" || build.revision !== revision) return undefined;

    // A distribution's own bin/node and public development header identify its prefix. Never
    // grant that prefix: the executable and the one active release are the entire read grant.
    const runtime = realpathSync(command[1]);
    if (basename(runtime) !== "node" || basename(dirname(runtime)) !== "bin" || Bun.which(runtime) === null) return undefined;
    if (!existsSync(join(dirname(dirname(runtime)), "include", "node", "node_version.h"))) return undefined;
    return [...context.bin(pkg), ...context.bin(command[1])];
  } catch {
    return undefined;
  }
}


export const NCODE_EXTERNAL_TOOL_FLAGS = ["--no-builtin-tools", "--session-mcp-only"] as const;

interface NcodeLauncher {
  readonly path: string;
  readonly searchPath: string;
}

/** Resolve only against the host's installation configuration, before any session is given. */
export function ncodeLauncher(program: string): NcodeLauncher | undefined {
  const searchPath = (process.env["PATH"] ?? "/usr/bin:/bin").split(delimiter).filter(isAbsolute).join(delimiter);
  const found = Bun.which(program, { PATH: searchPath });
  return found === null ? undefined : { path: resolve(found), searchPath };
}

/** Probe the host-selected program, without passing a session's directory, token or environment. */
export function externalToolsProgram(launcher: NcodeLauncher): string | undefined {
  try {
    const executable = realpathSync(launcher.path);
    const answer = spawnSync(executable, ["acp", "--help"], {
      cwd: dirname(executable),
      env: { HOME: homedir(), PATH: launcher.searchPath, LC_ALL: "C", MCODE_DISABLE_TELEMETRY: "1", MCODE_SERVER_MODE: "off" },
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    });
    if (answer.error !== undefined || answer.status !== 0) return undefined;
    const options = new Set(answer.stdout.split(/\r?\n/).flatMap((line) => {
      const option = /^\s+--([a-z][a-z-]*)(?:\s|$)/.exec(line)?.[1];
      return option === undefined ? [] : [`--${option}`];
    }));
    return NCODE_EXTERNAL_TOOL_FLAGS.every((flag) => options.has(flag)) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** An Ncode distribution can be selected directly through its published bin entry. */
export function distributionPrograms(launcher: string, context: ProfileContext): readonly string[] {
  try {
    const executable = realpathSync(launcher);
    const pkg = dirname(executable);
    const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    if (metadata.name === "@niwa-labs/ncode" && metadata.bin?.ncode === basename(executable)) return context.bin(pkg);
  } catch {
    // An arbitrary wrapper gets only its own launcher and ordinary runtime paths.
  }
  return [];
}
