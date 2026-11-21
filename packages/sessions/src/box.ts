/**
 * What a session's grant makes of its launch.
 *
 * The `tool:` rules become the tool allowance of the harness, and the `write:` and `net:` rules
 * become the box of the sandbox. Nothing here starts anything: the answer is a value the control
 * side is given.
 *
 * A rule that asks (`ask`) grants nothing at launch: the owner's answer comes at the moment of a
 * call, and a launch has no such moment. It is left out, and it still tells that the session
 * wants a box.
 */

import { join } from "node:path";

import { HOST_KEY_FILE, OWNER_TOKEN_FILE, rule, specsOf } from "@niwa-labs/core";
import type { Grant, Rule, RuleSpec, Verb } from "@niwa-labs/core";
import type { ToolAllowance } from "@niwa-labs/harness";
import { SandboxUnsupported } from "@niwa-labs/sandbox";
import type { BoxRequest, BoxSandboxName, BoxSpecInput } from "@niwa-labs/sandbox";

import { SessionRefusal } from "./refusal.ts";

/** The verbs whose rules are for the launch and not for niwa's own actions. */
const LAUNCH_VERBS: readonly Verb[] = ["tool", "write", "net"];

/** Is this rule, as it is written, one of the launch? */
export function isLaunchRule(spec: string): boolean {
  return LAUNCH_VERBS.includes(rule(spec).verb);
}

/**
 * The launch rules a child takes from its caller: for each launch verb the child asked nothing
 * of, the rules the caller holds, as it holds them. A child is never wider than its caller, so a
 * limited caller's child is not left unconfined by asking for nothing. A caller that nothing
 * limits has no rules to hand down.
 */
export function inheritedLaunch(caller: Grant | "unlimited", asked: readonly string[]): RuleSpec[] {
  if (caller === "unlimited") return [];
  const named = new Set(asked.map((spec) => rule(spec).verb));
  return specsOf({ rules: caller.rules.filter((each) => LAUNCH_VERBS.includes(each.verb) && !named.has(each.verb)) });
}

/** What the grant of a session makes of its launch. */
export interface GrantLaunch {
  /** The tools the session may use; absent when the grant says nothing of tools, so the harness keeps its own. */
  readonly tools?: ToolAllowance;
  /** The box the session runs in; absent when the grant reaches neither disk nor network. */
  readonly box?: BoxRequest;
}

/** Where the session is, which sandbox a box is made in, and the host's socket the box must let through. */
export interface LaunchPlan {
  /** The home of the host: the keys in it are closed to every box. */
  readonly home: string;
  readonly cwd: string;
  /** The unix socket of the host: a boxed session reaches niwa's MCP server and CLI through it. */
  readonly socket: string;
  readonly sandbox: BoxSandboxName;
}

function plain(of: Rule): Rule {
  if (of.target !== undefined) {
    throw new SessionRefusal("rule-target", `${of.verb}:${of.name} has a target, which means nothing for a launch`);
  }
  return of;
}

/** A place a `write:` mask stands for: a directory covers what is under it. */
function placeOf(name: string): string {
  if (name === "*") return "/";
  if (name.endsWith("/*")) return name.slice(0, -2) || "/";
  if (name.endsWith("*")) {
    throw new SessionRefusal("write-mask", `write:${name} cannot be a place: use a directory, "dir/*" or "*"`);
  }
  return name;
}

/** A host a `net:` mask stands for: a host. Any host (`*`) is no allow-list, and no sandbox says it. */
function hostOf(name: string, sandbox: BoxSandboxName): string {
  if (name === "*") throw new SandboxUnsupported(sandbox, "net:* cannot be said as a list of hosts: name the hosts");
  if (name.endsWith("*")) throw new SessionRefusal("net-mask", `net:${name} cannot be a host: use a host`);
  return name;
}

/**
 * The launch of a grant. `tool:*` and no `tool:` rule at all leave the tools to the harness; the
 * tool names are the harness's own. Any `write:` or `net:` rule makes a box: its writable places
 * and its hosts are the rules, the host's socket is let through so the session can call niwa, and what
 * the harness needs inside is added by the funnel. The owner's token and the host key are never readable
 * in it.
 */
export function launchOf(given: Grant, plan: LaunchPlan): GrantLaunch {
  const rules = given.rules.filter((each) => LAUNCH_VERBS.includes(each.verb)).map(plain);
  const of = (verb: Verb) => rules.filter((each) => each.verb === verb);

  const toolRules = of("tool");
  const allow = toolRules.filter((each) => !each.ask).map((each) => each.name as string);
  const tools: ToolAllowance | undefined =
    toolRules.length === 0 || allow.includes("*") ? undefined : { allow };

  const writes = of("write");
  const nets = of("net");
  if (writes.length === 0 && nets.length === 0) return tools === undefined ? {} : { tools };

  const spec: BoxSpecInput = {
    cwd: plan.cwd,
    write: writes.filter((each) => !each.ask).map((each) => placeOf(each.name)),
    net: nets.filter((each) => !each.ask).map((each) => hostOf(each.name, plan.sandbox)),
    sockets: [plan.socket],
    // Whatever the grant says, a box never reads the keys that make a caller the owner or sign tokens.
    denyRead: [join(plan.home, OWNER_TOKEN_FILE), join(plan.home, HOST_KEY_FILE)],
  };
  const box: BoxRequest = { sandbox: plan.sandbox, spec };
  return tools === undefined ? { box } : { tools, box };
}
