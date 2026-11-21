/**
 * What a session's grant makes of its launch, and the box it runs in.
 *
 * The `tool:` rules become the tool allowance of the harness. A rule that asks (`ask`) grants
 * nothing at launch: the owner's answer comes at the moment of a call, and a launch has no such
 * moment, so it is left out.
 *
 * The box is the host's default for sessions (`allow: ["project", "toolchains"]` unless the host
 * says otherwise), what the start asks for besides or instead, and always the profile of the
 * installation the session runs on, with a temp directory of its own and the host's socket.
 * Widening beyond the default takes the `box.*` rules of the caller's grant.
 */

import { coveringRule, rule, specsOf } from "@niwa-labs/core";
import type { Grant, Rule, RuleSpec, Verb } from "@niwa-labs/core";
import type { ToolAllowance, ToolsMode } from "@niwa-labs/harness";

import { SessionRefusal } from "./refusal.ts";

/** The verbs whose rules are for the launch and not for niwa's own actions. */
const LAUNCH_VERBS: readonly Verb[] = ["tool"];

/** The rules that say how far a box may be widened: held by the action that makes a box, never called. */
const BOX_RULES = "box.";

/** Is this rule, as it is written, one of the launch: a tool, or how far a box may be widened? */
export function isLaunchRule(spec: RuleSpec): boolean {
  const parsed = rule(spec);
  return LAUNCH_VERBS.includes(parsed.verb) || (parsed.verb === "call" && parsed.name.startsWith(BOX_RULES));
}

/**
 * The launch rules a child takes from its caller: when the child asked for no tool, the tools the
 * caller holds, as it holds them. A child is never wider than its caller, so a limited caller's
 * child is not left with every tool by asking for none. A caller that nothing limits has no rules
 * to hand down.
 */
export function inheritedLaunch(caller: Grant | "unlimited", asked: readonly RuleSpec[]): RuleSpec[] {
  if (caller === "unlimited") return [];
  const named = asked.map(rule);
  const inheritsTools = !named.some((entry) => entry.verb === "tool");
  const isBoxRule = (entry: Rule) => entry.verb === "call" && entry.name.startsWith(BOX_RULES);
  const inheritsBox = !named.some(isBoxRule);
  const rules = caller.rules.filter((entry) => (inheritsTools && entry.verb === "tool") || (inheritsBox && isBoxRule(entry)));
  return specsOf({ rules });
}

function plain(of: Rule): Rule {
  if (of.target !== undefined) {
    throw new SessionRefusal("rule-target", `${of.verb}:${of.name} has a target, which means nothing for a launch`);
  }
  return of;
}

/**
 * The tools of a session: the mode the start asked for, held within the allow-list its grant
 * makes. Only niwa's tools is narrower than any allow-list; two allow-lists keep the names both
 * have.
 */
export function toolsOfSession(asked: ToolsMode | undefined, granted: ToolAllowance | undefined): ToolsMode | undefined {
  if (asked === undefined || asked === "all") return granted;
  if (asked === "niwa-only" || granted === undefined) return asked;
  return { allow: asked.allow.filter((tool) => granted.allow.includes(tool)) };
}

/**
 * The tools a grant allows. `tool:*` and no `tool:` rule at all leave the tools to the harness;
 * the tool names are the harness's own.
 */
export function toolsOfGrant(given: Grant): ToolAllowance | undefined {
  const tools = given.rules.filter((each) => LAUNCH_VERBS.includes(each.verb)).map(plain);
  const allow = tools.filter((each) => !each.ask).map((each) => each.name as string);
  return tools.length === 0 || allow.includes("*") ? undefined : { allow };
}

/**
 * Whether a caller holds a rule of the box (`box.read@/data`): the rule of its grant that covers
 * it, as it is written; the rule itself for a caller nothing limits; undefined when none does.
 */
export function heldRule(rights: Grant | "unlimited", needed: string): string | undefined {
  return rights === "unlimited" ? needed : coveringRule(rights, needed);
}
