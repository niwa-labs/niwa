// The disposable process of a workflow run: it loads the script and speaks one JSON line at a time
// to the parent. It keeps nothing: every call, phase and log line goes to the parent.
//
// The protocol lines carry a prefix, and the script shares the stdout with the child: a line the
// child did not write is the script's own output and is passed through to the parent as a log.
//
// The key of a call says which branch it belongs to: the branches of a `parallel` and the stages
// of a `pipeline` are numbered, and the calls of a branch are numbered within it. A key that
// counted the calls of the whole script would be decided by the order the calls arrive in, and
// the branches would take each other's answers on a replay.
//
// The child has two modes. `run` runs the script's function with its input. `describe` only loads the
// module and prints what its `workflow({ input, output, ... }, fn)` call declares: the niwa globals
// are inert stubs there, so the top level of a module that calls one fails with a clear error, and
// the function of the script is never called.
//
// Usage: bun child.ts run <script url> <args as json>
//        bun child.ts describe <script url>

import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

import { JsonSchemaValue, jsonOf } from "@niwa-labs/core";
import type { Question } from "@niwa-labs/core";
import { WorktreeOption } from "@niwa-labs/git/records";
import { blocksOf } from "@niwa-labs/harness";
import type { OptionBlocks } from "@niwa-labs/harness";
import type { CallOptions, Duration } from "@niwa-labs/script";

import { choiceQuestion, confirmQuestion, formQuestion, multiQuestion, textQuestion } from "./ask.ts";
import type { AskOption } from "./ask.ts";
import { PROTOCOL_PREFIX, WorkflowPhases, durationMs } from "./language.ts";
import type { AgentOptions, ScriptRequest } from "./language.ts";

const [mode, scriptUrl, argsJson] = process.argv.slice(2);

let calls = 0;
let outside = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

/** The branch a call belongs to: its path in the script, and the calls made in it. */
interface Branch {
  /** The path of the branch: the branches of a parallel and the stages of a pipeline. */
  readonly path: string;
  /** How many calls the branch has made: the number of an unlabeled call within it. */
  ordinal: number;
  /** How many groups (a parallel or a pipeline) the branch has started: the number of the next. */
  groups: number;
  /** The declared phase the branch is in: the one it was made in, until it enters another. */
  phase: string | undefined;
  /** How many times the branch entered a phase: the number of the next change, 0 being the one it was made in. */
  phases: number;
}

/** The branch the call is made in. The script itself is the branch of no path. */
const BRANCH = new AsyncLocalStorage<Branch>();

/** How many groups the script itself has started: the script is the branch of no path. */
let outsideGroups = 0;

/** The phase the script itself is in, and how many times it entered one. */
let outsidePhase: string | undefined;
let outsidePhases = 0;

/** The titles of the phases the script declares: what `phase(title)` may name. */
let declaredTitles: readonly string[] = [];

function say(message: unknown, then?: () => void): void {
  process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`, then);
}

function exitWith(code: number): never {
  process.exit(code);
}

/**
 * Run something in a branch of its own.
 *
 * The path of the branch is the path of the branch it is in, plus the name of this one: a
 * parallel inside a parallel keeps the two apart. The branch starts in the phase of the branch it
 * is made in, and its own `phase()` changes only it; a branch that was in a phase says when it ends.
 */
function inBranch<T>(group: string, name: string, body: () => T | Promise<T>): Promise<T> {
  const parent = BRANCH.getStore();
  const own = `${group}.${name}`;
  const path = parent === undefined ? own : `${parent.path}.${own}`;
  const phase = parent === undefined ? outsidePhase : parent.phase;
  const branch: Branch = { path, ordinal: 0, groups: 0, phase, phases: 0 };
  return BRANCH.run(branch, async () => {
    if (phase !== undefined) say({ kind: "phase", branch: path, ordinal: 0, phase });
    try {
      return await body();
    } finally {
      if (branch.phase !== undefined) say({ kind: "left", branch: path });
    }
  });
}

/**
 * The name of the next group of branches in the branch the caller is in.
 *
 * A script that runs two groups one after the other, or one in a loop, numbers the branches of
 * each from zero: the group has a number of its own, so the branches of the second are not the
 * branches of the first. The number is taken when the group starts, in the order of the script.
 */
function nextGroup(kind: "p" | "s"): string {
  const branch = BRANCH.getStore();
  if (branch === undefined) return `${kind}${String(++outsideGroups)}`;
  branch.groups += 1;
  return `${kind}${String(branch.groups)}`;
}

/** The labels the script has used: one label names one call of the run. */
const labels = new Set<string>();

/**
 * The key of a call.
 *
 * A labeled call is keyed by its label, under `label:` so that no label can be the name of a record
 * the run writes itself (`finished`, `started`) or an unlabeled key. The label is the name the
 * author gave the call, and it says what the call is however the script is arranged, so a label
 * is used once in a run: a second call under it would be answered with the first one's answer.
 * `~` is the mark of the steps a call needs besides its own, so a label does not hold one.
 *
 * An unlabeled call is keyed by the branch it is in and by its number within that branch: the
 * key of a call of a branch does not depend on the calls of the other branches, so a branch
 * that answers before another one does not take its place.
 */
function keyOf(label: string | undefined): string {
  if (label !== undefined) {
    if (label.includes("~")) throw new Error(`the label "${label}" holds "~", which is kept for the steps of a call`);
    if (labels.has(label)) throw new Error(`the label "${label}" is used twice in this run: a label names one call`);
    labels.add(label);
    return `label:${label}`;
  }
  const branch = BRANCH.getStore();
  if (branch === undefined) return `call-${String(++outside)}`;
  branch.ordinal += 1;
  return `${branch.path}.call-${String(branch.ordinal)}`;
}

const globals = globalThis as Record<string, unknown>;

// zod is a global of the script, as the language functions are: a script writes `z.object({ ... })`
// with no import.
globals.z = z;

/** The phase of the branch the caller is in. */
function currentPhase(): string | undefined {
  const branch = BRANCH.getStore();
  return branch === undefined ? outsidePhase : branch.phase;
}

/**
 * Ask the parent to do something and wait for the answer.
 *
 * Every request takes its key here, in the branch it is made in, so the key does not depend on
 * which branch the parent answered first. The phase of the branch goes beside the request, not in
 * it: the parent records it against the key.
 */
function request(body: ScriptRequest, label: string | undefined): Promise<unknown> {
  const phase = currentPhase();
  const ordinal = ++calls;
  let key: string;
  try {
    key = keyOf(label);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    pending.set(ordinal, { resolve, reject });
    say({ kind: "call", ordinal, key, ...(phase === undefined ? {} : { phase }), request: body });
  });
}

/**
 * The JSON Schema of the answer a zod schema describes, which is what travels to the host.
 *
 * The agent writes the input shape of the schema; the script gets the output shape, after the
 * transforms and defaults of the schema, so the schema is read as an input here and parsed
 * with here when the answer comes back.
 */
function answerSchema(schema: z.ZodType): JsonSchemaValue {
  return JsonSchemaValue.parse(z.toJSONSchema(schema, { io: "input" }));
}

globals.agent = (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
  let schema: JsonSchemaValue | undefined;
  let blocks: OptionBlocks;
  let worktree: WorktreeOption | undefined;
  try {
    schema = opts.schema === undefined ? undefined : answerSchema(opts.schema);
    blocks = blocksOf(opts);
    worktree = opts.worktree === undefined ? undefined : WorktreeOption.parse(opts.worktree);
  } catch (error) {
    return Promise.reject(error);
  }
  const answer = request(
    {
      op: "agent",
      input: {
        prompt,
        ...(opts.harness === undefined ? {} : { harness: opts.harness }),
        ...(opts.label === undefined ? {} : { label: opts.label }),
        ...(opts.visible === undefined ? {} : { visible: opts.visible }),
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.effort === undefined ? {} : { effort: opts.effort }),
        ...(opts.mode === undefined ? {} : { mode: opts.mode }),
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(worktree === undefined ? {} : { worktree }),
        ...blocks,
        ...(schema === undefined ? {} : { schema }),
      },
    },
    opts.label,
  );
  const wanted = opts.schema;
  if (wanted === undefined) return answer;
  // A worktree that was kept rides along with the answer: the schema is the answer's alone.
  return answer.then(async (value) => {
    const { worktree, ...rest } = (value ?? {}) as { worktree?: unknown };
    const parsed: unknown = await wanted.parseAsync(opts.worktree === undefined ? value : rest);
    return opts.worktree === undefined || worktree === undefined ? parsed : { ...(parsed as object), worktree };
  });
};

/** The reason a call carries, when it has one. */
const reasonOf = (opts: CallOptions | undefined): { reason?: string } =>
  opts?.reason === undefined ? {} : { reason: opts.reason };

/** The call of an action: an input that has no JSON form is a rejection, as any other failure of a call is. */
function callOf(action: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
  let body: ScriptRequest;
  try {
    body = { op: "call", action, input: jsonOf(input), ...reasonOf(opts) };
  } catch (error) {
    return Promise.reject(error);
  }
  return request(body, opts?.label);
}

globals.call = (name: string, input: unknown, opts: CallOptions = {}): Promise<unknown> => callOf(name, input, opts);

/**
 * `niwa.task.create` is the action `task.create`: a group is a path, and a call of the path is
 * the call of the action of that name. The names are not listed here: an action nobody serves
 * is a failed step, as it is for `call`. A group is never thenable, so `await niwa.task` is the
 * group and not a call of an action named `task.then`.
 */
function group(path: readonly string[]): unknown {
  const target = (input?: unknown, opts?: CallOptions): Promise<unknown> => {
    if (path.length === 0) throw new TypeError("niwa is a group of actions: call niwa.<group>.<action>(input)");
    return callOf(path.join("."), input, opts);
  };
  return new Proxy(target, {
    get: (_target, name) => (typeof name === "symbol" || name === "then" ? undefined : group([...path, name])),
  });
}
globals.niwa = group([]);

globals.wait = (type: string, opts: { filter?: Record<string, unknown>; timeout?: Duration; label?: string } = {}): Promise<unknown> =>
  request(
    {
      op: "wait",
      type,
      ...(opts.filter === undefined ? {} : { filter: opts.filter }),
      ...(opts.timeout === undefined ? {} : { timeoutMs: durationMs(opts.timeout) }),
    },
    opts.label,
  );

globals.sleep = (duration: Duration, opts: CallOptions = {}): Promise<unknown> =>
  request({ op: "sleep", ms: durationMs(duration) }, opts.label);

/** What an `ask.<kind>` call may carry. */
interface AskOptions {
  timeout?: Duration;
  label?: string;
}

/** Put a question to the owner. The host gives the typed value back: the id, the ids, a boolean, a text, the form. */
function askOwner(question: Question, opts: AskOptions): Promise<unknown> {
  return request(
    { op: "ask", question, ...(opts.timeout === undefined ? {} : { timeoutMs: durationMs(opts.timeout) }) },
    opts.label,
  );
}

globals.ask = {
  choice: (text: string, options: readonly AskOption[], opts: AskOptions = {}): Promise<unknown> =>
    askOwner(choiceQuestion(text, options), opts),
  multi: (text: string, options: readonly AskOption[], opts: AskOptions = {}): Promise<unknown> =>
    askOwner(multiQuestion(text, options), opts),
  confirm: (text: string, opts: AskOptions = {}): Promise<unknown> => askOwner(confirmQuestion(text), opts),
  text: (text: string, opts: AskOptions = {}): Promise<unknown> => askOwner(textQuestion(text), opts),
  /** The value passes the schema the owner was shown, and again the zod schema of the script, here. */
  form: async (text: string, schema: z.ZodType, opts: AskOptions = {}): Promise<unknown> =>
    schema.parseAsync(await askOwner(formQuestion(text, answerSchema(schema)), opts)),
};

/** What `record(name, schema)` gives: a record type a script declares in `emits` and writes with `emit`. */
interface DeclaredRecord {
  readonly niwaRecord: true;
  readonly name: string;
  readonly schema: z.ZodType;
}

const isDeclaredRecord = (value: unknown): value is DeclaredRecord =>
  typeof value === "object" && value !== null && (value as { niwaRecord?: unknown }).niwaRecord === true;

/** The short name of a record a script declares: one or more words joined by dots, written under the script's own `wf.<name>.`. */
const RECORD_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

globals.record = (name: string, schema: z.ZodType): DeclaredRecord => {
  if (typeof name !== "string" || !RECORD_NAME.test(name)) throw new TypeError(`record(name, schema): "${String(name)}" is not a record name (words joined by dots)`);
  if (!isZod(schema)) throw new TypeError(`record("${name}", schema): the schema is a zod schema`);
  return { niwaRecord: true, name, schema };
};

/** The records the script declares in `emits`: set when the module is loaded, so `emit` writes only those. */
let declaredEmits: readonly unknown[] = [];

globals.emit = async (declared: unknown, data: unknown, opts: CallOptions = {}): Promise<unknown> => {
  if (!isDeclaredRecord(declared) || !declaredEmits.includes(declared)) {
    throw new TypeError("emit(record, data): the record is one the script lists in workflow({ emits })");
  }
  const parsed = await declared.schema.parseAsync(data);
  return request({ op: "emit", record: declared.name, data: parsed ?? null }, opts.label);
};

globals.read = {
  state: (plugin: string, opts: CallOptions = {}): Promise<unknown> => request({ op: "read-state", plugin }, opts.label),
  records: (query: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<unknown> =>
    request({ op: "read-records", query }, opts.label),
};

globals.now = (opts: CallOptions = {}): Promise<unknown> => request({ op: "now" }, opts.label);
globals.random = (opts: CallOptions = {}): Promise<unknown> => request({ op: "random" }, opts.label);

globals.parallel = (thunks: Array<() => unknown>): Promise<unknown[]> => {
  const group = nextGroup("p");
  return Promise.all(thunks.map((thunk, index) => inBranch(group, String(index), () => Promise.resolve().then(thunk))));
};

globals.pipeline = async (thunks: Array<(previous: unknown) => unknown>): Promise<unknown[]> => {
  const group = nextGroup("s");
  const results: unknown[] = [];
  let previous: unknown;
  for (const [index, thunk] of thunks.entries()) {
    previous = await inBranch(group, String(index), () => thunk(previous));
    results.push(previous);
  }
  return results;
};

/**
 * Enter a declared phase. The script itself enters it for the steps after; a branch enters it for itself only.
 * A title the script does not declare is an error of the script, here, where it is named.
 */
globals.phase = (title: string): void => {
  if (!declaredTitles.includes(title)) {
    throw new Error(
      declaredTitles.length === 0
        ? `phase("${title}"): the script declares no phases: declare them in workflow({ phases })`
        : `phase("${title}"): the script does not declare it: it declares ${declaredTitles.map((one) => `"${one}"`).join(", ")}`,
    );
  }
  const branch = BRANCH.getStore();
  if (branch === undefined) {
    outsidePhase = title;
    say({ kind: "phase", branch: "", ordinal: ++outsidePhases, phase: title });
    return;
  }
  branch.phase = title;
  say({ kind: "phase", branch: branch.path, ordinal: ++branch.phases, phase: title });
};
globals.log = (text: string): void => say({ kind: "log", text });

/** What `workflow({ ... }, fn)` gives: the declaration, and the function that is run. */
interface Declared {
  readonly niwaWorkflow: true;
  readonly declaration: {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly on?: unknown;
    readonly emits?: unknown;
    readonly phases?: unknown;
  };
  readonly run: (...input: unknown[]) => unknown;
}

globals.workflow = (declaration: Declared["declaration"], run: Declared["run"]): Declared => {
  if (typeof declaration !== "object" || declaration === null) throw new TypeError("workflow(declaration, fn): the declaration is an object");
  if (typeof run !== "function") throw new TypeError("workflow(declaration, fn): fn is the function of the script");
  return { niwaWorkflow: true, declaration, run };
};

const isDeclared = (value: unknown): value is Declared =>
  typeof value === "object" && value !== null && (value as { niwaWorkflow?: unknown }).niwaWorkflow === true;

/** The module of the script, and what it exports as its default: it must be what `workflow()` gave. */
async function loadScript(): Promise<Declared> {
  const loaded = (await import(scriptUrl as string)) as { default?: unknown };
  if (!isDeclared(loaded.default)) throw new Error("the script must export default workflow({ ... }, async (input) => { ... })");
  const { emits, phases } = loaded.default.declaration;
  declaredEmits = Array.isArray(emits) ? emits : [];
  const parsed = WorkflowPhases.safeParse(phases ?? []);
  declaredTitles = parsed.success ? parsed.data.map((phase) => phase.title) : [];
  return loaded.default;
}

const isZod = (value: unknown): value is z.ZodType => typeof value === "object" && value !== null && "_zod" in value;

/** One schema of a declaration: its JSON Schema, or what stops it from being one. */
type Declaration = { schema: Record<string, unknown> } | { problem: string };

/** Does the JSON Schema hold a schema that says nothing (`{}`): what `z.unknown()` and `z.any()` give? */
function holdsAnything(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(holdsAnything);
  if (typeof schema !== "object" || schema === null) return false;
  const keys = Object.keys(schema).filter((key) => key !== "$schema");
  if (keys.length === 0) return true;
  const subschemas = (value: unknown): unknown[] =>
    typeof value === "object" && value !== null ? (Array.isArray(value) ? value : Object.values(value)) : [];
  for (const [key, value] of Object.entries(schema)) {
    if (["properties", "$defs", "patternProperties"].includes(key) && subschemas(value).some(holdsAnything)) return true;
    if (["items", "additionalProperties", "propertyNames", "not", "if", "then", "else", "contains"].includes(key) && typeof value === "object" && holdsAnything(value)) return true;
    if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) && subschemas(value).some(holdsAnything)) return true;
  }
  return false;
}

/**
 * The JSON Schema of a schema of the declaration, which says everything the schema says.
 *
 * A schema JSON Schema cannot say (a transform, `z.custom`, a date) or one that says nothing
 * (`z.unknown()`, `z.any()`) is a problem, not a schema.
 */
function declaredSchema(schema: unknown, as: string): Declaration {
  if (!isZod(schema)) return { problem: `${as} must be a zod schema` };
  if (as === "input" && schema._zod.def.type !== "object") return { problem: "input must be a z.object({ ... }): the fields of the flags and the form" };
  try {
    // A schema is read as an output first: that is the one that refuses a transform.
    const written = z.toJSONSchema(schema, { unrepresentable: "throw", io: "output" });
    if (holdsAnything(written)) return { problem: `${as} holds a schema that says nothing (z.unknown, z.any): say what it is` };
    const json = as === "input" ? z.toJSONSchema(schema, { unrepresentable: "throw", io: "input" }) : written;
    delete json.$schema;
    return { schema: json };
  } catch (error) {
    return { problem: `${as} cannot be written as JSON Schema: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The records of `emits`, each with its JSON Schema or what stops it from being one. */
function declaredEmitsOf(emits: unknown): Array<{ name: string } & Declaration> | { problem: string } {
  if (!Array.isArray(emits)) return { problem: "emits must be a list of record(name, schema)" };
  const seen = new Set<string>();
  const described: Array<{ name: string } & Declaration> = [];
  for (const entry of emits) {
    if (!isDeclaredRecord(entry)) return { problem: "emits must be a list of record(name, schema)" };
    if (seen.has(entry.name)) return { problem: `emits lists the record "${entry.name}" twice` };
    seen.add(entry.name);
    described.push({ name: entry.name, ...declaredSchema(entry.schema, `the record "${entry.name}"`) });
  }
  return described;
}

/** The phases of the declaration, held to their schema, or what is wrong with them. */
function declaredPhasesOf(phases: unknown): { phases: WorkflowPhases } | { problem: string } {
  const parsed = WorkflowPhases.safeParse(phases);
  return parsed.success ? { phases: parsed.data } : { problem: `phases: ${z.prettifyError(parsed.error)}` };
}

/** What the module declares, for `workflow.check` and the start of a run. */
function describeScript(declared: Declared): Record<string, unknown> {
  const { name, description, input, output, emits, phases } = declared.declaration;
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(input === undefined ? {} : { input: declaredSchema(input, "input") }),
    ...(output === undefined ? {} : { output: declaredSchema(output, "output") }),
    ...(emits === undefined ? {} : { emits: declaredEmitsOf(emits) }),
    ...(phases === undefined ? {} : { phases: declaredPhasesOf(phases) }),
  };
}

if (mode === "describe") {
  // The names of a script are stubs: a module that calls one at its top level fails here, with the name.
  const unavailable = (name: string): (() => never) => () => {
    throw new Error(`${name} is not available while the module is read for its schemas: call it inside the function of the script`);
  };
  for (const name of ["agent", "call", "wait", "sleep", "emit", "now", "random", "parallel", "pipeline", "phase", "log"]) {
    globals[name] = unavailable(name);
  }
  const stub = (name: string): unknown => new Proxy(unavailable(name), { get: (_target, key) => (typeof key === "symbol" || key === "then" ? undefined : stub(`${name}.${key}`)) });
  globals.niwa = stub("niwa");
  globals.ask = stub("ask");
  globals.read = stub("read");
  try {
    say({ kind: "described", ...describeScript(await loadScript()) }, () => exitWith(0));
  } catch (error) {
    say({ kind: "failed", error: error instanceof Error ? error.message : String(error) }, () => exitWith(0));
  }
} else {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "") continue;
      const answer = JSON.parse(line) as { ordinal: number; ok: boolean; value?: unknown; error?: string; name?: string };
      const waiter = pending.get(answer.ordinal);
      pending.delete(answer.ordinal);
      if (answer.ok) waiter?.resolve(answer.value);
      else {
        const failed = new Error(answer.error ?? "the call failed");
        if (answer.name !== undefined) failed.name = answer.name;
        waiter?.reject(failed);
      }
    }
  });
  // The parent is gone: nobody is left to answer, so the process ends instead of waiting for ever.
  process.stdin.on("end", () => exitWith(1));

  try {
    const declared = await loadScript();
    const args: unknown = JSON.parse(argsJson ?? "null");
    // A script that starts on records is given the record; any other is given its input, parsed and with the defaults put in.
    const input = isZod(declared.declaration.input) ? await declared.declaration.input.parseAsync(args) : args;
    const result = await (declared.declaration.input === undefined && declared.declaration.on === undefined ? declared.run() : declared.run(input));
    say({ kind: "done", result: result ?? null }, () => exitWith(0));
  } catch (error) {
    // The name goes with the message: the host tells an `ask` that ended with no answer from any other error.
    say(
      { kind: "failed", error: error instanceof Error ? error.message : String(error), ...(error instanceof Error ? { name: error.name } : {}) },
      () => exitWith(0),
    );
  }
}
