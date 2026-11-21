/** What Claude Code needs inside a box and of its environment, shared by its ACP and SDK harnesses. */

import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { homePath } from "@niwa-labs/sandbox";
import type { BoxProfile } from "@niwa-labs/sandbox";

/** The directory Claude Code keeps its files in when nothing says otherwise. */
const DEFAULT_HOME = homePath(".claude");

/** The variable that tells Claude Code where its directory is. */
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** The root of an installed package, from the module it resolves to. */
function packageRootOf(specifier: string): string[] {
  try {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    const at = entry.lastIndexOf(`/node_modules/${specifier}/`);
    return at < 0 ? [] : [entry.slice(0, at + `/node_modules/${specifier}`.length)];
  } catch {
    return [];
  }
}

/**
 * What a Claude Code installation needs inside a box: the `claude` it runs, the runtime and the
 * packages niwa's own adapter runs on, its directory (sign-in, sessions, settings, plugins) and,
 * for the default directory, the configuration file beside it, and the endpoint of its model.
 *
 * Its sign-in on macOS is in the Keychain, which is no path: no profile can keep another box from
 * asking the Keychain for it, and none can give it to this one.
 */
export function claudeProfile(home: string, executable: string | undefined): BoxProfile {
  return ({ bin }) => ({
    // Programs and the packages they run, all through `bin`: they are never closed to another box.
    read: [
      ...bin(executable ?? "claude"),
      ...bin(process.execPath),
      ...bin(fileURLToPath(new URL("../..", import.meta.url))),
      ...packageRootOf("@anthropic-ai/claude-agent-sdk").flatMap((root) => bin(root)),
    ],
    write: [home, ...(home === DEFAULT_HOME ? [join(dirname(home), ".claude.json")] : [])],
    net: ["api.anthropic.com"],
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

/**
 * The built-in tools an allow-list switches off: every name the SDK lists that is not allowed.
 * The allow-list itself reaches Claude Code through niwa's adapter entry; the same tools switched
 * off as well keep them off should a build of the adapter give its own set after all. The SDK says
 * its list is not complete, which is why the allow-list, not this, is what holds the session.
 */
export function claudeToolsOff(allow: readonly string[]): string[] {
  return BUILTIN_TOOL_NAMES.filter((name) => !allow.includes(name));
}
