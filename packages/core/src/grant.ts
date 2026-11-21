/**
 * Grants: flat allow-lists of rules `verb:name[@target]`.
 *
 * What is not listed is forbidden. There is no `deny` and no order: of the rules that match, the
 * longest wins. `call` is the default verb. A rule may carry `ask`: the owner answers at the
 * moment of the call. All of it is pure: no table, no journal.
 */

import { z } from "zod";

import type { Grant, GrantId, Mask, Rule, Verb } from "./types.ts";

/** The verbs a rule may have; `call` when none is written. */
export const VERBS: readonly Verb[] = ["call", "emit", "tool", "write", "net"];

/** A rule as it is written or stored: the text, or the text with `ask`. */
export type RuleSpec = string | { readonly do: string; readonly ask?: true };

/** The schema of a rule as it is written and stored. */
export const RuleSpecSchema = z.union([
  z.string().min(1),
  z.strictObject({ do: z.string().min(1), ask: z.literal(true).optional() }),
]);

/** What a name or a target mask is made of: `*` only alone or after a `.` or a `/` at the end. */
const MASK = /^(\*|[^\s*@:]+|[^\s*@:]*[./]\*)$/;

/** A mask, from the text of a rule. */
export function mask(text: string): Mask {
  if (!MASK.test(text)) {
    throw new TypeError(`not a mask (exact, "group.*" or "*"): ${JSON.stringify(text)}`);
  }
  return text as Mask;
}

/** The prefix a mask like `group.*` stands for; undefined for an exact mask. `*` is the empty prefix. */
function prefixOf(name: Mask): string | undefined {
  return name.endsWith("*") ? name.slice(0, -1) : undefined;
}

/** Does the mask cover this exact name? */
export function matches(name: Mask, candidate: string): boolean {
  const prefix = prefixOf(name);
  return prefix === undefined ? name === candidate : candidate.startsWith(prefix);
}

/** Does every name the inner mask covers fall under the outer mask? */
function covers(outer: Mask, inner: Mask): boolean {
  const prefix = prefixOf(outer);
  if (prefix === undefined) return outer === inner;
  return inner.startsWith(prefix);
}

/** How narrow a mask is: an exact one beats every pattern, a longer prefix beats a shorter one. */
function specificity(name: Mask): number {
  const prefix = prefixOf(name);
  return prefix === undefined ? Number.MAX_SAFE_INTEGER : prefix.length;
}

/** The id of a grant: the id of the record that issued it. */
export function grantId(text: string): GrantId {
  if (typeof text !== "string" || text.length === 0 || /\s/.test(text)) {
    throw new TypeError(`a grant id must be a non-empty string without whitespace: ${JSON.stringify(text)}`);
  }
  return text as GrantId;
}

/** A rule, from its text: `verb:name[@target]`, the verb `call` when there is none. */
export function rule(spec: RuleSpec): Rule {
  const text = typeof spec === "string" ? spec : spec.do;
  const ask = typeof spec === "string" ? false : spec.ask === true;
  const colon = text.indexOf(":");
  const head = colon === -1 ? undefined : text.slice(0, colon);
  const verb = VERBS.find((known) => known === head) ?? "call";
  const rest = verb === "call" && head !== "call" ? text : text.slice(colon + 1);
  const at = rest.indexOf("@");
  const name = mask(at === -1 ? rest : rest.slice(0, at));
  if (at === -1) return { verb, name, ask };
  return { verb, name, target: mask(rest.slice(at + 1)), ask };
}

/** The text of a rule, with its verb: what a refusal says is missing. */
export function ruleText(of: Rule): string {
  return `${of.verb}:${of.name}${of.target === undefined ? "" : `@${of.target}`}`;
}

/** A rule as it is stored: the text, or the text with `ask`. */
export function specOf(of: Rule): RuleSpec {
  return of.ask ? { do: ruleText(of), ask: true } : ruleText(of);
}

/** The rules of a grant as they are stored. */
export function specsOf(of: Grant): RuleSpec[] {
  return of.rules.map(specOf);
}

/** The same line twice means one rule; where the two differ, the one that asks stands. */
function lineOf(of: Rule): string {
  return ruleText(of);
}

/** A grant from rules as they are written: duplicates are folded, the one that asks winning. */
export function grant(specs: readonly RuleSpec[]): Grant {
  const byLine = new Map<string, Rule>();
  for (const spec of specs) {
    const next = rule(spec);
    const held = byLine.get(lineOf(next));
    byLine.set(lineOf(next), held === undefined ? next : { ...held, ask: held.ask || next.ask });
  }
  return { rules: [...byLine.values()] };
}

/** The owner's grant: everything that may be called. */
export const OWNER_GRANT: Grant = grant(["*"]);

/** Which of two rules that both match is the longer: the name first, then a target, then `ask`. */
function longer(a: Rule, b: Rule): boolean {
  const names = specificity(a.name) - specificity(b.name);
  if (names !== 0) return names > 0;
  if ((a.target === undefined) !== (b.target === undefined)) return a.target !== undefined;
  return a.ask && !b.ask;
}

/**
 * The rule of a grant that decides a verb on a name, and a target when the call has one.
 *
 * A rule with a target says nothing about a call without one; a rule without a target covers
 * every target. Of the rules that match the longest wins.
 */
export function match(of: Grant, verb: Verb, name: string, target?: string): Rule | undefined {
  let best: Rule | undefined;
  for (const candidate of of.rules) {
    if (candidate.verb !== verb || !matches(candidate.name, name)) continue;
    if (candidate.target !== undefined && (target === undefined || !matches(candidate.target, target))) continue;
    if (best === undefined || longer(candidate, best)) best = candidate;
  }
  return best;
}

/** Does a parent rule cover a requested one: same verb, a mask that holds the name, and a target that holds the target? */
function holds(parent: Rule, requested: Rule): boolean {
  if (parent.verb !== requested.verb || !covers(parent.name, requested.name)) return false;
  if (parent.target === undefined) return true;
  return requested.target !== undefined && covers(parent.target, requested.target);
}

/** The rule of a grant that governs a requested rule: the longest of those that hold it. */
function governing(of: Grant, requested: Rule): Rule | undefined {
  let best: Rule | undefined;
  for (const candidate of of.rules) {
    if (holds(candidate, requested) && (best === undefined || longer(candidate, best))) best = candidate;
  }
  return best;
}

/** The mask that both masks cover: the narrower of two that overlap, nothing when they are apart. */
function meet(a: Mask, b: Mask): Mask | undefined {
  if (covers(a, b)) return b;
  return covers(b, a) ? a : undefined;
}

/**
 * The calls a requested rule and a parent rule have in common, as a rule: the narrower name and
 * the narrower target. Nothing when they share no call. A rule without a target covers every
 * target, so the target of the other one stands.
 */
function common(requested: Rule, parent: Rule): Rule | undefined {
  if (parent.verb !== requested.verb) return undefined;
  const name = meet(requested.name, parent.name);
  if (name === undefined) return undefined;
  if (requested.target === undefined || parent.target === undefined) {
    const target = requested.target ?? parent.target;
    return target === undefined ? { verb: requested.verb, name, ask: false } : { verb: requested.verb, name, target, ask: false };
  }
  const target = meet(requested.target, parent.target);
  return target === undefined ? undefined : { verb: requested.verb, name, target, ask: false };
}

/** A rule of the parent that lies inside the scope of a requested rule: it must stay as the parent has it. */
function inside(requested: Rule, parent: Rule): boolean {
  if (parent.verb !== requested.verb || !covers(requested.name, parent.name)) return false;
  if (requested.target === undefined) return true;
  return parent.target !== undefined && covers(requested.target, parent.target);
}

/** What `narrow` answers: the child's rules, or the masks that were asked for and are not the parent's. */
export type Narrowed = { readonly rules: Grant } | { readonly refused: readonly string[] };

/**
 * `child rights = parent rights ∩ requested`, computed once.
 *
 * Asking for more than the parent has is refused, with the masks that were refused: nothing is
 * narrowed silently. A call the parent asks about is asked about in the child too. For each
 * requested rule that comes from three places:
 *
 * - the request itself, asking when the parent rule that governs it asks;
 * - the parent's rules that lie inside the request, which stay as the parent has them;
 * - the part that a parent rule that asks shares with the request, when the two overlap without
 *   one holding the other (the name is wider in one and the target in the other): the request
 *   would otherwise let that part through without a question.
 *
 * A request that asks makes every call it covers ask, whatever the rules inside it say.
 */
export function narrow(parent: Grant, requested: readonly RuleSpec[]): Narrowed {
  const refused: string[] = [];
  const rules: Rule[] = [];
  for (const spec of requested) {
    const asked = rule(spec);
    const over = governing(parent, asked);
    if (over === undefined) {
      refused.push(ruleText(asked));
      continue;
    }
    rules.push({ ...asked, ask: asked.ask || over.ask });
    for (const own of parent.rules) {
      if (inside(asked, own)) {
        rules.push({ ...own, ask: own.ask || asked.ask });
      } else if (own.ask && !holds(own, asked)) {
        const shared = common(asked, own);
        if (shared !== undefined) rules.push({ ...shared, ask: true });
      }
    }
  }
  if (refused.length > 0) return { refused };
  return { rules: grant(rules.map(specOf)) };
}

/**
 * Did the grant lose something it had: a rule it no longer holds, or one that now asks?
 *
 * Only that is a narrowing: a grant that only gains rules is a widening, which touches nothing
 * that is already living.
 */
export function narrowed(before: Grant, after: Grant): boolean {
  const kept = narrow(after, before.rules.map(specOf));
  if ("refused" in kept) return true;
  return kept.rules.rules.some((now) => {
    if (!now.ask) return false;
    const was = governing(before, now);
    return was !== undefined && !was.ask;
  });
}
