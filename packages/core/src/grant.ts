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

/** One segment of a target: not empty, no wildcard, no whitespace, no `@` or `:`, no braces of a placeholder. */
const SEGMENT = "[^\\s*@:/{}]+";

/**
 * A target mask: segments between `/`, the last of which may be `*`. `*` alone is every target.
 * So `git.example.com/acme/billing/pr/*` is a mask and `acme/billing#*` is not: a wildcard
 * stands only for whole segments. A leading `/` makes it an absolute path, the target of a local
 * file or directory as the action that owns it normalizes it.
 */
const TARGET_MASK = new RegExp(`^(\\*|/\\*|/?${SEGMENT}(/${SEGMENT})*(/\\*)?)$`);

/** The target of one call: segments between `/`, none empty, none a wildcard, with an optional leading `/`. */
const TARGET = new RegExp(`^/?${SEGMENT}(/${SEGMENT})*$`);

/** A target mask, from the text after the `@` of a rule. */
export function targetMask(text: string): Mask {
  if (!TARGET_MASK.test(text)) {
    throw new TypeError(`not a target (segments between "/", "<prefix>/*" or "*"): ${JSON.stringify(text)}`);
  }
  return text as Mask;
}

/**
 * The target of a call, as an action computes it from its input: one place, which a rule's
 * target mask is matched against. Data cannot add a wildcard: a target with `*` or an empty
 * segment is refused.
 */
export function callTarget(text: string): string {
  if (typeof text !== "string" || !TARGET.test(text)) {
    throw new TypeError(`not the target of a call (segments between "/", none empty, no "*"): ${JSON.stringify(text)}`);
  }
  return text;
}

/** Is this text the target of one call? */
export function isCallTarget(text: string): boolean {
  return TARGET.test(text);
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
  return { verb, name, target: targetMask(rest.slice(at + 1)), ask };
}

/** A placeholder of a template: `{path.to.value}` in the input of a run. */
const PLACEHOLDER = /^\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\}$/;

/** One value filled into a template: segments between `/`, none empty, none a wildcard. */
const FILLED = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);

/** The value of a placeholder that opens a target: it may be an absolute path too. */
const FILLED_FIRST = new RegExp(`^/?${SEGMENT}(/${SEGMENT})*$`);

/** Is the text a rule whose target has placeholders, to be filled from the input of a run? */
export function isRuleTemplate(text: string): boolean {
  const at = text.indexOf("@");
  return at !== -1 && /[{}]/.test(text.slice(at + 1));
}

/** The text of a call rule split at its `@`: the name with its verb, and the pieces of the target. */
function templateParts(text: string): { head: string; pieces: string[] } {
  const at = text.indexOf("@");
  if (at === -1) throw new TypeError(`a template has a target: ${JSON.stringify(text)}`);
  const head = text.slice(0, at);
  const parsed = rule(head);
  if (parsed.verb !== "call") throw new TypeError(`only a call rule has a target template: ${JSON.stringify(text)}`);
  return { head, pieces: text.slice(at + 1).split("/") };
}

/**
 * A rule with a target template, checked as it is written: `forge.pr.merge@{repo.host}/{repo.path}/pr/*`.
 *
 * Each segment of the target is text, a placeholder `{path}` that stands for one or more whole
 * segments, or, last, `*`. The rule it gives is known only once it is filled.
 */
export function ruleTemplate(text: string): string {
  const { head, pieces } = templateParts(text);
  // Every placeholder stands in for a segment, so the rule with a segment in each place must be a rule.
  const shaped = pieces.map((piece) => (PLACEHOLDER.test(piece) ? "x" : piece)).join("/");
  if (pieces.some((piece) => /[{}]/.test(piece) && !PLACEHOLDER.test(piece))) {
    throw new TypeError(`a placeholder of a template is a whole segment, "{name}" or "{name.field}": ${JSON.stringify(text)}`);
  }
  rule(`${head}@${shaped}`);
  return text;
}

/** The value at a path of the input; undefined when the input has none. */
function valueAt(input: unknown, path: string): unknown {
  let value: unknown = input;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * The rule a template gives for one input: each placeholder is replaced by the value at its path,
 * which must be text or a whole number made of segments between `/`, none empty and none a
 * wildcard; one that opens the target may be an absolute path. A value cannot widen the rule:
 * what is refused says which placeholder and why.
 */
export function fillRule(text: string, input: unknown): string {
  ruleTemplate(text);
  const { head, pieces } = templateParts(text);
  const filled = pieces.map((piece, at) => {
    const placeholder = PLACEHOLDER.exec(piece)?.[1];
    if (placeholder === undefined) return piece;
    const value = valueAt(input, placeholder);
    if (value === undefined || value === null) throw new TypeError(`{${placeholder}} has no value in the input`);
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) {
      throw new TypeError(`{${placeholder}} is not text or a whole number`);
    }
    const segments = String(value);
    if (!(at === 0 ? FILLED_FIRST : FILLED).test(segments)) {
      throw new TypeError(`{${placeholder}} is not one or more segments without "*": ${JSON.stringify(segments)}`);
    }
    return segments;
  });
  const result = `${head}@${filled.join("/")}`;
  rule(result);
  return result;
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

/** The id of the owner's grant: the owner calls an irreversible action by its `*`, nobody else does. */
export const OWNER_GRANT_ID: GrantId = grantId("owner");

/** Is this the owner's own grant, the one value the host gives the owner: its `*` covers irreversible actions too. */
export function isOwnerGrant(of: Grant): boolean {
  return of === OWNER_GRANT;
}

/**
 * What a match or a narrowing needs to know of the actions: which are irreversible.
 *
 * A mask never grants an irreversible action: only a rule whose name is the action's own does.
 */
export interface Irreversibility {
  /** The call is of an irreversible action. */
  readonly irreversible?: boolean;
}

/** Which names are of irreversible actions, for a narrowing. */
export interface NarrowOptions {
  readonly irreversible?: (name: string) => boolean;
}

/** Is the name of this rule a mask rather than one name? */
function masked(of: Rule): boolean {
  return prefixOf(of.name) !== undefined;
}

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
 * every target. Of the rules that match the longest wins. For an irreversible action only the
 * rules that name it count: a mask does not grant it.
 */
export function match(of: Grant, verb: Verb, name: string, target?: string, opts: Irreversibility = {}): Rule | undefined {
  let best: Rule | undefined;
  for (const candidate of of.rules) {
    if (candidate.verb !== verb || !matches(candidate.name, name)) continue;
    if (opts.irreversible === true && masked(candidate)) continue;
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

/**
 * The rule of a grant that governs a requested rule: the longest of those that hold it. A request
 * that names an irreversible action is held only by a rule that names it too.
 */
function governing(of: Grant, requested: Rule, opts: NarrowOptions = {}): Rule | undefined {
  const exact = !masked(requested) && requested.verb === "call" && opts.irreversible?.(requested.name) === true;
  let best: Rule | undefined;
  for (const candidate of of.rules) {
    if (exact && masked(candidate)) continue;
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
 *   one holding the other (the name is wider in one and the target in the other) and no longer
 *   parent rule answers for that part: the request would otherwise let it through without a
 *   question.
 *
 * With `irreversible`, a request that names an irreversible action is held only by a parent rule
 * that names it, and a mask the child asks for does not carry such a rule along: a mask never
 * grants an irreversible action, at any depth.
 */
export function narrow(parent: Grant, requested: readonly RuleSpec[], opts: NarrowOptions = {}): Narrowed {
  const refused: string[] = [];
  const rules: Rule[] = [];
  // A rule of the parent that names an irreversible action is not carried by a mask the child asks for.
  const named = (own: Rule): boolean => !masked(own) && own.verb === "call" && opts.irreversible?.(own.name) === true;
  for (const spec of requested) {
    const asked = rule(spec);
    const over = governing(parent, asked, opts);
    if (over === undefined) {
      refused.push(ruleText(asked));
      continue;
    }
    rules.push({ ...asked, ask: asked.ask || over.ask });
    for (const own of parent.rules) {
      if (masked(asked) && named(own)) continue;
      if (inside(asked, own)) {
        rules.push(own);
      } else if (own.ask && !holds(own, asked)) {
        // Only where the rule decides: a longer parent rule over the shared part answers for it.
        const shared = common(asked, own);
        if (shared !== undefined && governing(parent, shared, opts)?.ask === true) rules.push({ ...shared, ask: true });
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
export function narrowed(before: Grant, after: Grant, opts: NarrowOptions = {}): boolean {
  const kept = narrow(after, before.rules.map(specOf), opts);
  if ("refused" in kept) return true;
  return kept.rules.rules.some((now) => {
    if (!now.ask) return false;
    const was = governing(before, now);
    return was !== undefined && !was.ask;
  });
}
