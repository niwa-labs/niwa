/**
 * The typing of a workflow script, generated from what the host describes: the language
 * functions and one typed wrapper `niwa.<group>.<action>(input, opts)` per
 * action. Nothing here is kept by hand per action: a plugin that declares an action adds it to
 * the typing with no change in this file.
 *
 * The text is global declarations with no import and no export, so it is the same text for the
 * type checker (`check.ts`) and for an author (`workflow.guide`).
 */

import { z } from "zod";

import type { ActionDescription, Grant, JsonSchema } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";
import type { OptionsBlock } from "@niwa-labs/harness";

/** The options block a harness takes, as the sessions module reports it: its name, and its JSON Schema. */
export interface HarnessBlock {
  readonly block: OptionsBlock;
  readonly schema: JsonSchema;
}

/** The names of a script that do not depend on the host: the language, and the call by name. */
const LANGUAGE = `type NiwaDuration = number | string;
type NiwaCallOptions = { label?: string; reason?: string };

/** zod, with no import: z.object({ ... }) as a value, z.infer<typeof Schema> as a type. */
declare const z: typeof import("zod").z;
declare namespace z {
  type infer<T> = import("zod").z.infer<T>;
  type input<T> = import("zod").z.input<T>;
  type output<T> = import("zod").z.output<T>;
}
type NiwaPrompt = string | { sections: { id: string; tier: "constant" | "stable" | "volatile"; text: string }[] };
interface NiwaTurn<T> {
  readonly session: string;
  readonly operation: string;
  readonly turn?: number;
  /** Returns the answer, or rejects on timeout or terminal failure. The handle can be waited on again. */
  wait(options?: NiwaCallOptions & { timeout?: NiwaDuration }): Promise<T>;
}
interface NiwaSession {
  readonly id: string;
  readonly ref: string;
  readonly address: { kind: "session"; harness: string; id: string };
  readonly worktree?: Omit<NiwaSessionWorktree, "changed">;
  ask<S extends import("zod").z.ZodType>(prompt: NiwaPrompt, options: { schema: S; label?: string }): Promise<import("zod").z.output<S>>;
  ask(prompt: NiwaPrompt, options?: { label?: string }): Promise<{ answer: string }>;
  send<S extends import("zod").z.ZodType>(prompt: NiwaPrompt, options: NiwaCallOptions & { schema: S }): Promise<NiwaTurn<import("zod").z.output<S>>>;
  send(prompt: NiwaPrompt, options?: NiwaCallOptions & { schema?: undefined }): Promise<NiwaTurn<string>>;
  send<S extends import("zod").z.ZodType>(prompt: NiwaPrompt, options: NiwaCallOptions & { schema?: S }): Promise<NiwaTurn<string | import("zod").z.output<S>>>;
  end(options?: NiwaCallOptions): Promise<void>;
}
/** How one turn of a group wait ended: its answer, or the reason there is none. */
type NiwaTurnOutcome<T> = { status: "completed"; value: T } | { status: "ended"; how: "interrupted" | "failed" | "unknown" } | { status: "handled" } | { status: "no-answer" } | { status: "invalid-answer" };
/** One turn of a group wait that settled: its index among the handles given, the handle, and how it ended. */
interface NiwaTurnDone<T> { readonly index: number; readonly turn: NiwaTurn<T>; readonly result: NiwaTurnOutcome<T> }
/** One turn of a group wait still running: its index among the handles given, and the handle, to wait on again. */
interface NiwaTurnPending<T> { readonly index: number; readonly turn: NiwaTurn<T> }
/** The value a list of turn handles answers with: the union of the value types of its handles. */
type NiwaTurnValue<T extends readonly NiwaTurn<any>[]> = T[number] extends NiwaTurn<infer V> ? V : never;
/** What turns.first and turns.all answer: what settled and what is still pending, in the order the handles were given. */
interface NiwaTurnsWaited<T extends readonly NiwaTurn<any>[]> {
  readonly done: Array<NiwaTurnDone<NiwaTurnValue<T>>>;
  readonly pending: Array<NiwaTurnPending<NiwaTurnValue<T>>>;
  readonly timedOut: boolean;
}
/**
 * Group waits over turn handles session.send returned. One call and one deadline cover the whole group;
 * nothing is sent, consumed or cancelled, and a handle either answer names can be waited for again.
 * Put session.turn-wait-many in uses.
 */
declare const turns: {
  first<T extends readonly NiwaTurn<any>[]>(list: T, opts?: NiwaCallOptions & { timeout?: NiwaDuration }): Promise<NiwaTurnsWaited<T>>;
  all<T extends readonly NiwaTurn<any>[]>(list: T, opts?: NiwaCallOptions & { timeout?: NiwaDuration }): Promise<NiwaTurnsWaited<T>>;
};

/** The worktree an ask({ worktree }) call left because the work changed something in it; a clean one is removed. */
type NiwaSessionWorktree = { id: string; path: string; branch: string; changed: boolean };
/** What ask({ worktree }) takes: true, or the repository (default: cwd), the base (default: its current branch) and a description. */
type NiwaWorktreeOption = true | { repo?: string; base?: string; description?: string };
/** One thing a box asks for: a profile by its name, "project", "toolchains", or a path or a host. */
type NiwaBoxItem = string | { read: string } | { write: string } | { net: string };
/** What ask({ box }) takes: items added to the host's default (allow), or put instead of it (only). Beyond the default takes the run's box.* rules. */
type NiwaBoxAccess = { allow: NiwaBoxItem[] } | { only: NiwaBoxItem[] };
declare function session(options: NiwaSessionOptions): Pick<NiwaSession, "ask" | "send" | "end"> & PromiseLike<NiwaSession>;
declare function agent(name: "agent.tell" extends keyof NiwaActions ? string : never): { tell(text: string, options?: NiwaCallOptions): Promise<{ message: string }> };
/** Sleep; a replay does not sleep from the start. */
declare function sleep(duration: NiwaDuration, opts?: NiwaCallOptions): Promise<void>;
type NiwaAskOption = string | { id: string; label?: string; description?: string };
type NiwaAskId<T> = T extends string ? T : T extends { id: infer I extends string } ? I : never;
type NiwaAskOptions = { timeout?: NiwaDuration; label?: string };
/** Ask a model with ask(options, prompt), or the owner with a named method. Each owner question gives a typed value. A cancel or no answer within the timeout throws AskCancelled or AskExpired, which the script may catch; uncaught, the run waits for a revision or a cancel. */
declare const ask: {
  <S extends import("zod").z.ZodObject | import("zod").z.ZodRecord>(options: NiwaSessionOptions & { schema: S; worktree: NonNullable<NiwaSessionOptions["worktree"]> }, prompt: NiwaPrompt): Promise<import("zod").z.output<S> & { worktree?: NiwaSessionWorktree }>;
  (options: NiwaSessionOptions & { schema?: undefined; worktree: NonNullable<NiwaSessionOptions["worktree"]> }, prompt: NiwaPrompt): Promise<{ answer: string; worktree?: NiwaSessionWorktree }>;
  <S extends import("zod").z.ZodType>(options: NiwaSessionOptions & { schema: S; worktree?: undefined }, prompt: NiwaPrompt): Promise<import("zod").z.output<S>>;
  (options: NiwaSessionOptions & { schema?: undefined; worktree?: undefined }, prompt: NiwaPrompt): Promise<{ answer: string }>;
  choice<const O extends readonly NiwaAskOption[]>(text: string, options: O, opts?: NiwaAskOptions): Promise<NiwaAskId<O[number]>>;
  multi<const O extends readonly NiwaAskOption[]>(text: string, options: O, opts?: NiwaAskOptions): Promise<NiwaAskId<O[number]>[]>;
  confirm(text: string, opts?: NiwaAskOptions): Promise<boolean>;
  text(text: string, opts?: NiwaAskOptions): Promise<string>;
  form<S extends import("zod").z.ZodType>(text: string, schema: S, opts?: NiwaAskOptions): Promise<import("zod").z.output<S>>;
};
/** A record a script declares with record(name, schema), lists in workflow({ emits }) and writes with emit. */
interface NiwaRecordType<S extends import("zod").z.ZodType = import("zod").z.ZodType> { readonly niwaRecord: true; readonly name: string; readonly schema: S }
/** Declare a record the script writes: its name, under the script's own wf.<name>., and the zod schema of its data. */
declare function record<S extends import("zod").z.ZodType>(name: string, schema: S): NiwaRecordType<S>;
/** Write a record the script lists in workflow({ emits }): the data is held to the record's schema. */
declare function emit<S extends import("zod").z.ZodType>(record: NiwaRecordType<S>, data: import("zod").z.input<S>, opts?: NiwaCallOptions): Promise<void>;
/** The clock of the host, recorded. */
declare function now(opts?: NiwaCallOptions): Promise<number>;
/** A random number, recorded. */
declare function random(opts?: NiwaCallOptions): Promise<number>;
/** How a branch ended: its value, or its error by name and message (a cancelled branch is named Cancelled). */
type NiwaSettled<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } };
/** A branch of a scope: its key, its outcome, and its value (which throws what the branch threw). */
interface NiwaBranch<R> { readonly key: string; settled(): Promise<NiwaSettled<R>>; value(): Promise<R> }
/** A scope: start branches in it, read their outcomes in the order the host committed them, cancel the ones left. */
interface NiwaScope {
  readonly path: string[];
  start<R>(key: string, fn: () => R | Promise<R>): NiwaBranch<Awaited<R>>;
  /** A branch that is a run of a registered workflow, started as a child of this run. */
  run<R = unknown>(key: string, child: { id: string; version?: string; args?: unknown }): NiwaBranch<R>;
  /** The next outcome, or null when every branch ended and was read. */
  next(): Promise<{ key: string; result: NiwaSettled<unknown> } | null>;
  /** The outcomes ready now and not read yet. */
  ready(): Promise<Array<{ key: string; result: NiwaSettled<unknown> }>>;
  /** Every branch, by key, once each ended. */
  rest(): Promise<Record<string, NiwaSettled<unknown>>>;
  /** The keys of the branches still going. */
  pending(): Promise<string[]>;
  /** Cancel the branches still going, or those named. */
  cancel(reason?: string, keys?: string[]): Promise<void>;
}
type NiwaScopeOptions = { concurrency?: number; onExit?: "wait" | "cancel"; deadline?: NiwaDuration; onDeadline?: "skip" | "fail"; shield?: boolean };
/**
 * A group of branches: nothing started in it outlives it. Leaving the block waits for the branches (onExit "wait", the default)
 * or cancels them ("cancel"); a block that throws cancels them, and so does an outer cancel unless the scope is a shield. With a
 * deadline the scope is cancelled when it runs out: onDeadline "skip" gives undefined, "fail" throws DeadlineExceeded.
 */
declare function scope<T>(name: string, opts: (NiwaScopeOptions & { deadline?: undefined }) | undefined, fn: (s: NiwaScope) => Promise<T>): Promise<T>;
/** With a deadline and onDeadline "fail" the scope gives its value or throws. */
declare function scope<T>(name: string, opts: NiwaScopeOptions & { deadline: NiwaDuration; onDeadline: "fail" }, fn: (s: NiwaScope) => Promise<T>): Promise<T>;
/** With a deadline that may skip (the default), the scope past it gives undefined. */
declare function scope<T>(name: string, opts: NiwaScopeOptions | undefined, fn: (s: NiwaScope) => Promise<T>): Promise<T | undefined>;
declare function scope<T>(name: string, fn: (s: NiwaScope) => Promise<T>): Promise<T>;
/** Run the block for at most the duration: past it the block is cancelled and the call gives undefined. */
declare function moveOnAfter<T>(name: string, duration: NiwaDuration, fn: () => Promise<T>): Promise<T | undefined>;
/** Run the block for at most the duration: past it the block is cancelled and the call throws DeadlineExceeded. */
declare function failAfter<T>(name: string, duration: NiwaDuration, fn: () => Promise<T>): Promise<T>;
/** The error a scope that ran out of time throws with onDeadline "fail". */
declare class DeadlineExceeded extends Error {}
/** Branches at once, by the index of a list or the keys of an object; the answer has the same shape. A branch that fails cancels the others. */
declare function parallel<T>(thunks: Array<() => T | Promise<T>>, opts?: { concurrency?: number }): Promise<Awaited<T>[]>;
declare function parallel<B extends Record<string, () => unknown>>(branches: B, opts?: { concurrency?: number }): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
/** A stream of branches: their outcomes one at a time, in the order the host committed them; closing it cancels the rest. */
interface NiwaStream<K extends string, T> extends AsyncIterable<{ key: K; result: NiwaSettled<T> }> {
  next(): Promise<{ key: K; result: NiwaSettled<T> } | null>;
  ready(): Promise<Array<{ key: K; result: NiwaSettled<T> }>>;
  rest(): Promise<Record<K, NiwaSettled<T>>>;
  pending(): Promise<K[]>;
  cancel(keys?: K[]): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
declare function stream<K extends string, T>(name: string, branches: Record<K, () => T | Promise<T>>, opts?: { concurrency?: number }): NiwaStream<K, Awaited<T>>;
/** The first branch to succeed, with its key; the others are cancelled. When every branch fails, the first error is thrown. */
declare function race<K extends string, T>(name: string, branches: Record<K, () => T | Promise<T>>): Promise<{ key: K; value: Awaited<T> }>;
/** Stages run one after another; each is given what the one before gave, awaited, and the call gives all of them. From two to four stages. */
declare function pipeline<A, B>(stages: [() => A, (previous: Awaited<A>) => B]): Promise<[Awaited<A>, Awaited<B>]>;
declare function pipeline<A, B, C>(stages: [() => A, (previous: Awaited<A>) => B, (previous: Awaited<B>) => C]): Promise<[Awaited<A>, Awaited<B>, Awaited<C>]>;
declare function pipeline<A, B, C, D>(stages: [() => A, (previous: Awaited<A>) => B, (previous: Awaited<B>) => C, (previous: Awaited<C>) => D]): Promise<[Awaited<A>, Awaited<B>, Awaited<C>, Awaited<D>]>;
/** Enter a phase the script declares in workflow({ phases }): the steps after it belong to it. In a branch of parallel or pipeline it changes that branch only; a branch starts in the phase of the one that made it. */
declare function phase(title: NiwaPhase): void;
declare function log(text: string): void;
/** The record a script with \`on\` is given, as a name or a name with a filter written as a literal. */
type NiwaOn = string | { type: string; filter?: Record<string, unknown> };
/** What \`workflow\` declares that does not depend on the shape of the script. */
type NiwaDeclaration = { name?: string; description?: string; uses?: string[]; emits?: NiwaRecordType[]; phases?: Array<{ title: string; detail?: string }> };
/** What the default export of a script is: what \`workflow(...)\` gives. */
interface NiwaWorkflow { readonly niwaWorkflow: true }
/** The result a function of a script returns: what its \`output\` says, or nothing when it has none. */
type NiwaResult<O extends import("zod").z.ZodType> = [O] extends [never] ? void : import("zod").z.output<O>;
/** What the function of a script is given: the record for a script with \`on\`, else its parsed \`input\`, else nothing. */
type NiwaInput<I extends import("zod").z.ZodObject, On> = [On] extends [undefined] ? ([I] extends [never] ? [] : [import("zod").z.output<I>]) : [NiwaTrigger];
/**
 * The script: \`export default workflow({ description, input, output, uses, on }, async (input) => { ... })\`.
 * The function is given \`input\` parsed (a script with no \`input\` is given nothing, a script with \`on\` is given the
 * record, typed by what \`on\` lists) and returns what \`output\` says (a script with no \`output\` returns nothing).
 * \`input\` is a \`z.object\`, and a script has an \`input\` or an \`on\`, not both.
 */
declare function workflow<I extends import("zod").z.ZodObject = never, O extends import("zod").z.ZodType = never, On extends NiwaOn[] | undefined = undefined>(
  declaration: NiwaDeclaration & { input?: I; output?: O; on?: On },
  run: (...input: NiwaInput<I, On>) => Promise<NiwaResult<O>>,
): NiwaWorkflow;`;

/** The prefix of the action that starts a session of a harness and asks it: what an `session({ harness })` goes to. */
const AGENT_ACTION_PREFIX = "session.start.";

/** The harness an agent action serves: `codex` of `session.start.codex`; absent for any other action. */
export function harnessOfAction(name: string): string | undefined {
  return name.startsWith(AGENT_ACTION_PREFIX) && name.length > AGENT_ACTION_PREFIX.length ? name.slice(AGENT_ACTION_PREFIX.length) : undefined;
}

/** The type of a field of the input of an action: the literals it lists, else what its schema says. */
function fieldType(input: Schema, field: string): string {
  const properties = typeof input === "object" && typeof input.properties === "object" && input.properties !== null ? (input.properties as Record<string, unknown>) : {};
  const member = properties[field];
  return isSchema(member) ? schemaToType(member, { root: "unknown", defs: "unknown" }) : "string";
}

/** The names of the blocks the harnesses of a host take, each once. */
function blockNames(blocks: ReadonlyMap<string, HarnessBlock>): OptionsBlock[] {
  return [...new Set([...blocks.values()].map((one) => one.block))].sort();
}

/**
 * The options blocks of a harness: the block of its kind, typed as that kind declares it, and every other block `never`,
 * so the block of another kind is an error of the check and not an extra field the checker may let through.
 */
function blocksTyping(names: readonly OptionsBlock[], own: OptionsBlock | undefined): string {
  return `{ ${names.map((block) => (block === own ? `${literal(block)}?: NiwaOptionBlocks[${literal(block)}]` : `${literal(block)}?: never`)).join("; ")} }`;
}

/**
 * The options of `ask()`: the harness is one of those the caller may call a `session.start.<harness>` action for; the
 * model and the effort are the literals that action lists, where the adapter lists them; and the options block is the
 * one the sessions module binds the harness to (`blocks`), and no other. A call with no harness names no kind, so it
 * takes no block. A host that serves no harness has nothing to check one against, so a harness is any text and any block
 * is taken; a host that serves some holds a script to the ones it may call, and a script that may call none names none.
 */
function agentTyping(description: readonly ActionDescription[], callable: ReadonlySet<string>, blocks: ReadonlyMap<string, HarnessBlock>): string {
  const names = blockNames(blocks);
  const common = `{ label?: string; visible?: string[]; tools?: "all" | "niwa-only" | { allow: readonly string[] }; mode?: "ask" | "auto" | "full"; cwd?: string; worktree?: NiwaWorktreeOption; stuckAfter?: NiwaDuration; box?: NiwaBoxAccess }`;
  const hosted = description.filter((action) => harnessOfAction(action.name) !== undefined);
  const served = hosted.filter((action) => callable.has(action.name));
  const variants =
    hosted.length === 0
      ? ["{ harness?: string; model?: string; effort?: string } & NiwaOptionBlocks"]
      : [
          `{ harness?: undefined; model?: string; effort?: string } & ${blocksTyping(names, undefined)}`,
          ...served.map((action) => {
            const harness = action.name.slice(AGENT_ACTION_PREFIX.length);
            return `{ harness: ${literal(harness)}; model?: ${fieldType(action.input, "model")}; effort?: ${fieldType(action.input, "effort")} } & ${blocksTyping(names, blocks.get(harness)?.block)}`;
          }),
        ];
  return `/** What ask() takes: the harness is one the host serves, its model and effort are the ones that harness lists, and its options block is the one of its kind. */\ntype NiwaSessionOptions = ${common} & (${variants.map((variant) => `(${variant})`).join(" | ")});`;
}

/** A JSON Schema as a value: an object, or a boolean. */
type Schema = Readonly<Record<string, unknown>> | boolean;

/** Where a rendered schema finds the types it points at. */
interface Scope {
  /** The alias the root of the schema is, for `$ref: "#"`. */
  readonly root: string;
  /** The prefix of the aliases of the definitions, for `$ref: "#/$defs/<name>"`. */
  readonly defs: string;
}

const isSchema = (value: unknown): value is Schema =>
  typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value));

const list = (value: unknown): Schema[] => (Array.isArray(value) ? value.filter(isSchema) : []);

const identifier = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, "_");

/** A comment that cannot end early. */
const doc = (text: string, indent: string): string =>
  `${indent}/** ${text.replace(/\*\//g, "*\\/").replace(/\s*\n\s*/g, " ")} */\n`;

const literal = (value: unknown): string => JSON.stringify(value) ?? "unknown";

function union(parts: readonly string[]): string {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return "never";
  return unique.length === 1 ? (unique[0] ?? "never") : unique.map((part) => `(${part})`).join(" | ");
}

/** A JSON Schema as a TypeScript type. A member with no equivalent is `unknown`. */
export function schemaToType(schema: Schema, scope: Scope, indent = ""): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  const ref = schema.$ref;
  if (typeof ref === "string") {
    if (ref === "#") return scope.root;
    if (ref.startsWith("#/$defs/")) return `${scope.defs}${identifier(ref.slice("#/$defs/".length))}`;
    return "unknown";
  }
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
  const variants = list(schema.anyOf ?? schema.oneOf);
  if (variants.length > 0) return union(variants.map((variant) => schemaToType(variant, scope, indent)));
  const parts = list(schema.allOf);
  if (parts.length > 0) return parts.map((part) => `(${schemaToType(part, scope, indent)})`).join(" & ");
  const type = schema.type;
  if (Array.isArray(type)) {
    return union(type.map((one) => schemaToType({ ...schema, type: one }, scope, indent)));
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return arrayType(schema, scope, indent);
    case "object":
      return objectType(schema, scope, indent);
    default:
      return schema.properties === undefined ? "unknown" : objectType(schema, scope, indent);
  }
}

function arrayType(schema: Readonly<Record<string, unknown>>, scope: Scope, indent: string): string {
  const prefix = list(schema.prefixItems).map((item) => schemaToType(item, scope, indent));
  const items = isSchema(schema.items) ? schemaToType(schema.items, scope, indent) : undefined;
  if (prefix.length === 0) return `Array<${items ?? "unknown"}>`;
  return `[${[...prefix, ...(items === undefined ? [] : [`...Array<${items}>`])].join(", ")}]`;
}

function objectType(schema: Readonly<Record<string, unknown>>, scope: Scope, indent: string): string {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? Object.entries(schema.properties as Record<string, unknown>)
      : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const extra = schema.additionalProperties;
  const open = isSchema(extra) && extra !== false;
  const index = open ? `[key: string]: ${schemaToType(extra, scope, indent)}` : undefined;
  // An object that takes no field at all is not `{}`, which takes any value but null.
  if (properties.length === 0) return index !== undefined ? `{ ${index} }` : extra === false ? "Record<string, never>" : "{}";
  const inner = `${indent}  `;
  const lines = properties.map(([name, member]) => {
    const note =
      typeof member === "object" && member !== null && typeof (member as { description?: unknown }).description === "string"
        ? doc((member as { description: string }).description, inner)
        : "";
    const type = isSchema(member) ? schemaToType(member, scope, inner) : "unknown";
    return `${note}${inner}${literal(name)}${required.has(name) ? "" : "?"}: ${type};\n`;
  });
  const body = `{\n${lines.join("")}${indent}}`;
  // Named properties and an open index meet in an intersection, so the properties need not fit the index.
  return index === undefined ? body : `${body} & { ${index} }`;
}

/**
 * The options of each kind the host's harnesses are of, one block each, made from the schemas those kinds declare: what
 * ask() takes besides its own options. Two harnesses of one kind have one block.
 */
function optionBlocksTyping(blocks: ReadonlyMap<string, HarnessBlock>): string {
  const first = new Map<OptionsBlock, JsonSchema>();
  for (const one of blocks.values()) if (!first.has(one.block)) first.set(one.block, one.schema);
  const each = [...first.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([block, schema]) => ({ block, alias: `NiwaOptionBlock$${identifier(block)}`, schema }));
  const text = each.map((one) => aliases(one.schema as Schema, one.alias).text).join("");
  const fields = each.map((one) => `${literal(one.block)}?: ${one.alias}`).join("; ");
  return `${text}/** The options of the harness's kind, in the block named after the kind; the block of another kind is refused. */\ntype NiwaOptionBlocks = { ${fields} };\n`;
}

/** The language of a script that reads the journal: \`wait\` and \`read\`, typed by the data of the record types the script names. */
const RECORDS = `/** The dotted paths into data: a field, or a field of a field. */
type NiwaPath<D, Depth extends unknown[] = []> = Depth["length"] extends 4
  ? never
  : D extends readonly unknown[]
    ? never
    : D extends object
      ? { [K in keyof D & string]-?: K | \`\${K}.\${NiwaPath<NonNullable<D[K]>, [...Depth, 0]>}\` }[keyof D & string]
      : never;
/** The value at a dotted path into data. */
type NiwaAt<D, P extends string> = D extends unknown
  ? P extends keyof D
    ? D[P]
    : P extends \`\${infer Head}.\${infer Rest}\`
      ? Head extends keyof D
        ? NiwaAt<NonNullable<D[Head]>, Rest>
        : never
      : never
  : never;
/** The filter of a wait: values for fields of the data, by field name or dotted path. Data of any shape takes any field. */
type NiwaFilter<D> = unknown extends D ? Record<string, unknown> : { [P in NiwaPath<D>]?: NiwaAt<D, P> };
/**
 * A record type a plugin declares, imported from its records entry (\`import { TaskDone } from "@niwa-labs/tasks/records"\`):
 * a wait or a read that names it gives the data its schema gives.
 */
type NiwaRecordRef<D = unknown> = { readonly kind: "record"; readonly name: string; readonly version: number; readonly schema: { readonly _zod: { readonly output: D } } };
/** The data of the records of a referenced type. */
type NiwaDataOf<R> = R extends { readonly schema: { readonly _zod: { readonly output: infer D } } } ? D : unknown;
/** The first record of the type whose data holds every field of the filter, written after \`from\` or after the wait began: its data and its position. Without a timeout it waits for ever. */
declare function wait<T extends keyof NiwaRecords>(type: T, opts?: { filter?: NiwaFilter<NiwaRecords[T]>; from?: number; label?: string; timeout?: undefined }): Promise<{ data: NiwaRecords[T]; at: number }>;
/** The same, or { timedOut: true } at the end of the timeout: options that may hold a timeout give both. */
declare function wait<T extends keyof NiwaRecords>(type: T, opts: { filter?: NiwaFilter<NiwaRecords[T]>; from?: number; label?: string; timeout?: NiwaDuration }): Promise<{ data: NiwaRecords[T]; at: number } | { timedOut: true }>;
/** The first record of the referenced type whose data holds every field of the filter, written after \`from\` or after the wait began: its data, typed by the type, and its position. */
declare function wait<R extends NiwaRecordRef<any>>(type: R, opts?: { filter?: NiwaFilter<NiwaDataOf<R>>; from?: number; label?: string; timeout?: undefined }): Promise<{ data: NiwaDataOf<R>; at: number }>;
/** The same, or { timedOut: true } at the end of the timeout. */
declare function wait<R extends NiwaRecordRef<any>>(type: R, opts: { filter?: NiwaFilter<NiwaDataOf<R>>; from?: number; label?: string; timeout?: NiwaDuration }): Promise<{ data: NiwaDataOf<R>; at: number } | { timedOut: true }>;
/** A query of one referenced type and a filter on its data, as a plugin's query builder gives it (\`taskDone(task)\`). A wait looks at every stream: a query that names one is for a read. */
type NiwaTypeQuery<R> = { readonly types: readonly [R]; readonly filter?: NiwaFilter<NiwaDataOf<R>>; readonly from?: number; readonly stream?: undefined };
/** The first record that answers the query, written after \`from\` (the option, else the query's) or after the wait began: its data, typed by the type, and its position. */
declare function wait<R extends NiwaRecordRef<any>>(query: NiwaTypeQuery<R>, opts?: { from?: number; label?: string; timeout?: undefined }): Promise<{ data: NiwaDataOf<R>; at: number }>;
/** The same, or { timedOut: true } at the end of the timeout. */
declare function wait<R extends NiwaRecordRef<any>>(query: NiwaTypeQuery<R>, opts: { from?: number; label?: string; timeout?: NiwaDuration }): Promise<{ data: NiwaDataOf<R>; at: number } | { timedOut: true }>;
/** A record as the journal keeps it. */
type NiwaStoredRecord<T extends string, D> = { id: string; seq: number; stream: string; type: T; schema: number; data: D; cause: string | null; root: string; at: number; actor: { kind: string } };
/** Where a read of the journal starts, what stream it reads, and how much. */
type NiwaReadQuery = { from?: number; stream?: string; limit?: number; tail?: number };
/** What a read answers: the records, and the position to read or wait on from. */
type NiwaRead<R> = { records: R[]; next: number };
/**
 * Whether a list of record types names only known types: a tuple of at least one type of the catalogue or reference. A
 * list that may be empty (one built at run time) selects every type when it is, and one that holds a name the catalogue does
 * not know, or a family, has no data type to give.
 */
type NiwaKnownOnly<T extends readonly unknown[]> = T extends readonly [] ? false : number extends T["length"] ? false : T[number] extends (keyof NiwaRecords & string) | NiwaRecordRef<any> ? true : false;
/** The data of a record type named as text or by reference. */
type NiwaDataOfType<S> = S extends keyof NiwaRecords ? NiwaRecords[S] : NiwaDataOf<S>;
/** The filter of a read of a list of types: by the data of the types when every one is known, else by any field. */
type NiwaTypesFilter<T extends readonly unknown[]> = NiwaKnownOnly<T> extends true ? NiwaFilter<NiwaDataOfType<T[number]>> : Record<string, unknown>;
/** A record of one known type, with its data typed by it; over a union of types, one record type each. */
type NiwaRecordOf<S> = S extends keyof NiwaRecords & string ? NiwaStoredRecord<S, NiwaRecords[S]> : S extends NiwaRecordRef<any> ? NiwaStoredRecord<string, NiwaDataOf<S>> : never;
/** The records a read of a list of types answers with: typed when every type is known, else of data of unknown shape. */
type NiwaTypesRecords<T extends readonly unknown[]> = NiwaKnownOnly<T> extends true ? NiwaRecordOf<T[number]> : NiwaStoredRecord<string, unknown>;
declare const read: {
  state(plugin: string, opts?: NiwaCallOptions): Promise<any>;
  /** The records of a referenced type whose data holds the filter, with their data typed by the type. */
  records<R extends NiwaRecordRef<any>>(type: R, query?: NiwaReadQuery & { filter?: NiwaFilter<NiwaDataOf<R>> }, opts?: NiwaCallOptions): Promise<NiwaRead<NiwaStoredRecord<string, NiwaDataOf<R>>>>;
  /**
   * The records of a list of types: names, families written prefix.* or references; a query a plugin's builder gives is one. A list
   * of known types written out ([TaskDone], ["task.done"]) types the filter and the data of each record by its type; any other list,
   * one that may be empty or has a name the catalogue does not know, takes a filter on any field and gives data of unknown shape.
   */
  records<const T extends ReadonlyArray<string | NiwaRecordRef<any>> = readonly []>(query?: NiwaReadQuery & { types?: T; filter?: NiwaTypesFilter<T> }, opts?: NiwaCallOptions): Promise<NiwaRead<NiwaTypesRecords<T>>>;
};`;

/** The typing of what a script reads of the journal: the data of each record type of the catalogue, and `wait` and `read` typed by it. */
function recordTyping(records: ReadonlyArray<{ name: string; schema: JsonSchema }>): string {
  const data = records.map((one, index) => aliases(one.schema, `NiwaRecord${String(index)}Data`));
  const byType = records.map((one, index) => `  ${literal(one.name)}: NiwaRecord${String(index)}Data;\n`);
  return `${data.map((alias) => alias.text).join("")}/** The data of the records a script may wait for and read, by type. */\ninterface NiwaRecords {\n${byType.join("")}}\n${RECORDS}`;
}

/** The titles of the phases the script declares: what \`phase(title)\` may name. A script with no phases names none. */
function phaseTyping(phases: readonly string[]): string {
  return `/** The phases the script declares in workflow({ phases }), by title: phase(title) names one. No phases declared: phase() takes nothing. */\ntype NiwaPhase = ${union(phases.map(literal))};`;
}

/** The aliases of one schema: its root, and the definitions it holds; and the type the root is. */
function aliases(schema: Schema, name: string): { text: string; type: string } {
  const scope: Scope = { root: name, defs: `${name}$` };
  const defs =
    typeof schema === "object" && typeof schema.$defs === "object" && schema.$defs !== null
      ? Object.entries(schema.$defs as Record<string, unknown>)
      : [];
  const own = defs.map(([key, def]) => `type ${scope.defs}${identifier(key)} = ${isSchema(def) ? schemaToType(def, scope) : "unknown"};\n`);
  const type = schemaToType(schema, scope);
  return { text: `${own.join("")}type ${name} = ${type};\n`, type };
}

/**
 * The action names a script may call: the names of a catalogue that a mask of `uses` allows.
 *
 * A script with no `uses` asks for nothing, so it may call nothing, unless whoever starts it is
 * limited by no grant: then there is nothing to narrow and it may call whatever is served.
 */
export function allowedFor(
  names: readonly ActionName[],
  uses: readonly string[] | undefined,
  rights: Grant | "unlimited",
): ActionName[] {
  if (uses === undefined) return rights === "unlimited" ? [...names] : [];
  return names.filter((name) => uses.some((mask) => matches(mask, name)));
}

/** Whether a mask names the action: `task.create`, `task.*` (everything under `task.`) or `*`. */
export function matches(mask: string, name: string): boolean {
  if (mask === "*") return true;
  if (mask.endsWith(".*")) return name.startsWith(mask.slice(0, -1));
  return mask === name;
}

interface Node {
  action?: { input: string; output: string };
  children: Map<string, Node>;
}

function addAction(root: Node, name: string, action: { input: string; output: string }): void {
  let node = root;
  for (const part of name.split(".")) {
    let child = node.children.get(part);
    if (child === undefined) {
      child = { children: new Map() };
      node.children.set(part, child);
    }
    node = child;
  }
  node.action = action;
}

function renderNode(node: Node, indent: string): string {
  const inner = `${indent}  `;
  const members = [...node.children].map(([key, child]) => `${inner}${literal(key)}: ${renderNode(child, inner)};\n`);
  const call =
    node.action === undefined
      ? []
      : [`${inner}(input: ${node.action.input}, opts?: NiwaCallOptions): Promise<${node.action.output}>;\n`];
  return `{\n${call.join("")}${members.join("")}${indent}}`;
}

/** The typing of a script: the declarations, and the type of the input of each action in them. */
export interface ScriptTyping {
  declarations: string;
  inputs: ReadonlyMap<ActionName, string>;
}

/**
 * The typing of a script: the language, the actions by name for `call`, and the wrappers
 * `niwa.<group>.<action>`.
 *
 * `callable` is the list of the actions the script may call: it decides what is declared. The
 * host's own list is `description`; an action not in `callable` is not declared, so a call of it
 * is an error of the type checker. `blocks` binds each harness to its options block; `phases` are the titles the script declares: what `phase(title)` may name.
 */
export function scriptTyping(
  description: readonly ActionDescription[],
  callable: readonly ActionName[],
  triggers: ReadonlyArray<{ name: string; schema: JsonSchema }> = [],
  records: ReadonlyArray<{ name: string; schema: JsonSchema }> = [],
  blocks: ReadonlyMap<string, HarnessBlock> = new Map(),
  phases: readonly string[] = [],
): ScriptTyping {
  const wanted = new Set<string>(callable);
  const taken = new Set<string>();
  const root: Node = { children: new Map() };
  const types: string[] = [];
  const byName: string[] = [];
  const inputs = new Map<ActionName, string>();
  for (const action of description) {
    if (!wanted.has(action.name)) continue;
    const base = action.name
      .split(/[^A-Za-z0-9]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    let own = base;
    for (let n = 2; taken.has(own); n += 1) own = `${base}${String(n)}`;
    taken.add(own);
    const input = aliases(action.input, `${own}Input`);
    types.push(input.text, aliases(action.output, `${own}Output`).text);
    inputs.set(action.name, input.type);
    byName.push(`  ${literal(action.name)}: { input: ${own}Input; output: ${own}Output };\n`);
    addAction(root, action.name, { input: `${own}Input`, output: `${own}Output` });
  }
  // The record a script that starts on records is given: what the default export takes.
  const triggerTypes = triggers.map((trigger, index) => aliases(trigger.schema, `NiwaTrigger${String(index)}Data`));
  const triggerUnion = union(
    triggers.map((trigger, index) => `{ id: string; type: ${literal(trigger.name)}; data: NiwaTrigger${String(index)}Data }`),
  );
  const declarations = [
    "// Generated from the actions the host describes. Do not edit.",
    LANGUAGE,
    phaseTyping(phases),
    optionBlocksTyping(blocks),
    agentTyping(description, wanted, blocks),
    "",
    triggerTypes.map((alias) => alias.text).join(""),
    `/** The record that started the run, for a script with on: the argument of its function. */\ntype NiwaTrigger = ${triggerUnion};`,
    recordTyping(records),
    types.join(""),
    `interface NiwaActions {\n${byName.join("")}}`,
    "/** Call an action by name. */",
    'declare function call<Name extends keyof NiwaActions>(name: Name, input: NiwaActions[Name]["input"], opts?: NiwaCallOptions): Promise<NiwaActions[Name]["output"]>;',
    `/** The actions as functions: niwa.task.create(input, { label }) is call("task.create", input, { label }). */`,
    `declare const niwa: ${renderNode(root, "")};`,
    "",
  ].join("\n");
  return { declarations, inputs };
}
