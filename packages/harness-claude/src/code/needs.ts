/** What Claude Code needs inside a box and of its environment, shared by its ACP and SDK harnesses. */

import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SecretRef } from "@niwa-labs/core";
import type { SecretStore } from "@niwa-labs/core";
import { homePath } from "@niwa-labs/sandbox";
import type { BoxProfile } from "@niwa-labs/sandbox";

/** The directory Claude Code keeps its files in when nothing says otherwise. */
const DEFAULT_HOME = homePath(".claude");

/** The variable that tells Claude Code where its directory is. */
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** The exact installed directory of a dependency, including with Bun's isolated linker. */
function packageRootOf(specifier: string, from: string): string | undefined {
  for (const request of [`${specifier}/package.json`, specifier]) {
    try {
      const entry = Bun.resolveSync(request, from);
      const marker = `/node_modules/${specifier}`;
      const at = entry.lastIndexOf(`${marker}/`);
      if (at >= 0) return entry.slice(0, at + marker.length);
    } catch {
      // Some packages export only their code, others only subpaths.
    }
  }
  return undefined;
}

/** The ACP adapter imports its dependencies inside the box, each from its own package directory. */
function runtimePackages(): ReadonlySet<string> {
  const roots = new Set<string>();
  const visited = new Set<string>();
  const add = (specifier: string, from: string): void => {
    const root = packageRootOf(specifier, from);
    if (root === undefined) return;
    const real = realpathSync(root);
    roots.add(real);
    // Bun returns the resolved file. Its loader still traverses the importer's package link,
    // which Seatbelt must be allowed to read separately from the target.
    const lookup = createRequire(join(from, "package.json")).resolve.paths(specifier) ?? [];
    for (const dir of lookup) {
      const candidate = join(dir, specifier);
      try {
        if (realpathSync(candidate) !== real) continue;
      } catch {
        continue;
      }
      roots.add(candidate);
      break;
    }
    if (visited.has(real)) return;
    visited.add(real);
    const { dependencies, optionalDependencies, peerDependencies } = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies })) add(name, real);
  };
  add("@anthropic-ai/claude-agent-sdk", import.meta.dir);
  add("@zed-industries/claude-code-acp", import.meta.dir);
  const adapterRoot = packageRootOf("@zed-industries/claude-code-acp", import.meta.dir);
  if (adapterRoot !== undefined) {
    const installed = realpathSync(adapterRoot);
    const store = "/node_modules/.bun";
    const offset = installed.lastIndexOf(`${store}/`);
    // Bun resolves imports through sibling links in its isolated install store.
    if (offset >= 0) roots.add(installed.slice(0, offset + store.length));
  }
  return roots;
}

/**
 * What a Claude Code installation needs inside a box: the `claude` it runs, the runtime and the
 * packages niwa's own adapter runs on, its directory (sessions, settings, plugins) and,
 * for the default directory, the configuration file beside it, and the endpoint of its model.
 *
 * On macOS the local login uses the installation's OAuth credentials.
 */
export function claudeProfile(home: string, executable: string | undefined): BoxProfile {
  const localLogin = process.platform === "darwin";
  const suffix = home === DEFAULT_HOME ? "" : `-${createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8)}`;
  return ({ bin }) => ({
    ...(localLogin ? { keychainRead: [`Claude Code-credentials${suffix}`] } : {}),
    // Programs and the packages they run, all through `bin`: they are never closed to another box.
    read: [
      ...bin(executable ?? "claude"),
      ...bin(process.execPath),
      ...bin(fileURLToPath(new URL("../..", import.meta.url))),
      ...[...runtimePackages()].flatMap((root) => bin(root)),
    ],
    write: [home, ...(home === DEFAULT_HOME ? [join(dirname(home), ".claude.json")] : [])],
    net: localLogin ? ["api.anthropic.com", "platform.claude.com"] : ["api.anthropic.com"],
  });
}

/**
 * The environment that binds a Claude Code process to the installation the instance reads: the
 * process writes its sessions where the reading side looks for them. The default directory is the
 * one the program uses when nothing is said, so nothing is said for it, and the owner's own
 * environment stands.
 */
export function claudeHomeEnv(home: string | undefined): Record<string, string> {
  return home === undefined || home === DEFAULT_HOME ? {} : { [CONFIG_DIR_ENV]: home };
}

/** Claude Code chooses its own temp root unless it is explicitly bound to the box's TMPDIR. */
export function claudeTempEnv(boxed: boolean, env?: Readonly<Record<string, string>>): Record<string, string> {
  return boxed && env?.TMPDIR ? { CLAUDE_CODE_TMPDIR: env.TMPDIR } : {};
}

/** Owner configuration for one boxed Claude installation. */
export interface ClaudeBoxedApiKey {
  readonly ref: SecretRef;
  readonly store: Pick<SecretStore, "resolve">;
}

export function claudePrivateEnv(auth: ClaudeBoxedApiKey | undefined): (() => Record<string, string>) | undefined {
  if (auth === undefined) return undefined;
  const { secret } = SecretRef.parse(auth.ref);
  return () => {
    let key: string;
    try {
      key = auth.store.resolve(secret);
    } catch {
      throw new Error("Claude host API key unavailable");
    }
    if (key.length === 0 || /[\r\n\0]/.test(key)) throw new Error("Claude host API key unavailable");
    return { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  };
}

/**
 * The built-in tools an allow-list switches off: every name the SDK lists that is not allowed.
 * The allow-list itself reaches Claude Code through niwa's adapter entry; the same tools switched
 * off as well keep them off should a build of the adapter give its own set after all. The SDK says
 * its list is not complete, which is why the allow-list, not this, is what holds the session.
 */
export function claudeToolsOff(allow: readonly string[]): string[] {
  return BUILTIN_TOOL_NAMES.filter((name) => !allow.includes(name));
}
