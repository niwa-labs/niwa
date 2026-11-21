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
import { AGENT_REQUEST_FIELDS, PROTOCOL_PREFIX, WorkflowPhases, durationMs } from "./language.ts";
import type { AgentOptions, ScriptRequest } from "./language.ts";

const [mode, scriptUrl, argsJson] = process.argv.slice(2);

let calls = 0;
let outside = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; branch?: Branch | undefined; parked?: boolean; clock?: boolean }>();

/**
 * Let the process end once nothing is left for it to do.
 *
 * A call the host parked (a wait for a record that has not arrived) is answered by a later start of
 * the run, not by this process, and a wait for the deadline of a scope is answered when the process
 * is gone. When every call in flight is one of those, stdin no longer holds the process: it ends
 * once the script's own code has nothing more to run, and the run waits. Any other call holds it.
 */
function holdWhileNeeded(): void {
  const calls = [...pending.values()];
  if (calls.some((one) => one.parked === true) && calls.every((one) => one.parked === true || one.clock === true)) process.stdin.unref();
  else process.stdin.ref();
}

/** The branch a call belongs to: its path in the script, and the calls made in it. */
interface Branch {
  /** The path of the branch: the branches of a parallel and the stages of a pipeline. */
  readonly path: string;
  /** The group the branch belongs to: the one whose member or whose block it is. */
  readonly group?: Group;
  /** The member of the group the branch runs, when it is not the block of the group. */
  readonly member?: Member;
  /** The streams opened in the branch and not closed yet: they close when it ends. */
  readonly streams: Set<StreamHandle>;
  /** How many calls the branch has made: the number of an unlabeled call within it. */
  ordinal: number;
  /** How many groups (a parallel or a pipeline) the branch has started: the number of the next. */
  groups: number;
  /** The declared phase the branch is in: the one it was made in, until it enters another. */
  phase: string | undefined;
  /** How many times the branch entered a phase: the number of the next change, 0 being the one it was made in. */
  phases: number;
  /** A call of the branch ran instead of being taken from an earlier start: the calls after it lie after a change. */
  diverged: boolean;
}

/** The branch the call is made in. The script itself is the branch of no path. */
const BRANCH = new AsyncLocalStorage<Branch>();

/** How many groups the script itself has started: the script is the branch of no path. */
let outsideGroups = 0;

/** A call of the script itself ran instead of being taken from an earlier start. */
let outsideDiverged = false;

/** Whether the calls of a branch (the script itself when absent) lie after a change. */
const divergedIn = (branch: Branch | undefined): boolean => (branch === undefined ? outsideDiverged : branch.diverged);

/** The calls of a branch lie after a change from now on. */
function diverge(branch: Branch | undefined): void {
  if (branch === undefined) outsideDiverged = true;
  else branch.diverged = true;
}

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
  const branch: Branch = { path, ordinal: 0, groups: 0, phase, phases: 0, streams: new Set(), diverged: divergedIn(parent) };
  return BRANCH.run(branch, async () => {
    if (phase !== undefined) say({ kind: "phase", branch: path, ordinal: 0, phase });
    try {
      return await body();
    } finally {
      // A stage that ran a call leaves the stages after it after a change.
      if (branch.diverged) diverge(parent);
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
    // In a scope the key of a labeled call starts with the path of its branch, so a cancel of the branch holds it.
    const inScope = BRANCH.getStore();
    return inScope !== undefined && inScope.path.includes("@") ? `${inScope.path}.label:${label}` : `label:${label}`;
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
  // A labeled call outside a scope is keyed by its label alone: a cancel of its branch names it while it is in flight.
  const branch = BRANCH.getStore();
  if (branch !== undefined && key.startsWith("label:")) inflightLabels.set(key, branch.path);
  const after = divergedIn(branch);
  return new Promise((resolve, reject) => {
    pending.set(ordinal, { resolve, reject, branch });
    holdWhileNeeded();
    say({ kind: "call", ordinal, key, ...(phase === undefined ? {} : { phase }), ...(after ? { after: true } : {}), request: body });
  }).finally(() => inflightLabels.delete(key));
}

/** The labeled calls in flight outside any scope, by key: the path of the branch each one is in. */
const inflightLabels = new Map<string, string>();

/** Ask the parent something about a group, under a key the group gives it: it takes no number from the calls. */
function requestAt(body: ScriptRequest, key: string): Promise<unknown> {
  const ordinal = ++calls;
  return new Promise((resolve, reject) => {
    pending.set(ordinal, { resolve, reject, ...(body.op === "scope-deadline" ? { clock: true } : {}) });
    holdWhileNeeded();
    say({ kind: "call", ordinal, key, request: body });
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
  let stuckAfter: number | undefined;
  try {
    stuckAfter = opts.stuckAfter === undefined ? undefined : durationMs(opts.stuckAfter);
    schema = opts.schema === undefined ? undefined : answerSchema(opts.schema);
    blocks = blocksOf(opts, AGENT_REQUEST_FIELDS);
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
        ...(stuckAfter === undefined ? {} : { stuckAfter }),
        ...(opts.box === undefined ? {} : { box: opts.box }),
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

/** A record type a plugin declares, as a script imports it from the plugin's records entry: its name and version. */
interface RecordRef {
  readonly kind: "record";
  readonly name: string;
  readonly version: number;
}

const isRecordRef = (value: unknown): value is RecordRef =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "record" &&
  typeof (value as { name?: unknown }).name === "string" &&
  typeof (value as { version?: unknown }).version === "number";

/**
 * The name of a type a wait or a read names, and the version a reference holds: the host waits for and
 * reads the type it knows, and refuses a reference to a version it does not write.
 */
function typeNamed(type: unknown, call: string): { name: string; version?: number } {
  if (typeof type === "string") return { name: type };
  if (isRecordRef(type)) return { name: type.name, version: type.version };
  if (isDeclaredRecord(type)) {
    throw new TypeError(`${call}: "${type.name}" is a record a script writes: name its type as text, "wf.<name>.${type.name}"`);
  }
  throw new TypeError(`${call}: a type is a name, or a record type imported from the records entry of a plugin`);
}

/** What a wait is given besides its type. */
interface WaitOptions {
  filter?: Record<string, unknown>;
  from?: number;
  timeout?: Duration;
  label?: string;
}

/**
 * The type of a wait and what it is given: a type, or a query of one type, as a plugin's query builder gives it, whose
 * filter and position are the wait's (the options say the position when they say one).
 */
function waitOf(first: unknown, opts: WaitOptions): { named: { name: string; version?: number }; filter?: Record<string, unknown>; from?: number } {
  const query = typeof first === "object" && first !== null && "types" in first ? (first as { types?: unknown; filter?: Record<string, unknown>; from?: number; stream?: unknown }) : undefined;
  if (query === undefined) {
    return { named: typeNamed(first, "wait(type)"), ...(opts.filter === undefined ? {} : { filter: opts.filter }), ...(opts.from === undefined ? {} : { from: opts.from }) };
  }
  if (!Array.isArray(query.types) || query.types.length !== 1) throw new TypeError("wait(query): a wait waits for one type, and the query names " + (Array.isArray(query.types) ? String(query.types.length) : "none"));
  if (query.stream !== undefined) throw new TypeError("wait(query): a wait looks at every stream, and the query names one");
  const filter = query.filter === undefined && opts.filter === undefined ? undefined : { ...query.filter, ...opts.filter };
  const from = opts.from ?? query.from;
  return { named: typeNamed(query.types[0], "wait(query)"), ...(filter === undefined ? {} : { filter }), ...(from === undefined ? {} : { from }) };
}

globals.wait = (type: unknown, opts: WaitOptions = {}): Promise<unknown> => {
  let wanted: ReturnType<typeof waitOf>;
  try {
    wanted = waitOf(type, opts);
  } catch (error) {
    return Promise.reject(error);
  }
  return request(
    {
      op: "wait",
      type: wanted.named.name,
      ...(wanted.named.version === undefined ? {} : { version: wanted.named.version }),
      ...(wanted.filter === undefined ? {} : { filter: wanted.filter }),
      ...(wanted.from === undefined ? {} : { from: wanted.from }),
      ...(opts.timeout === undefined ? {} : { timeoutMs: durationMs(opts.timeout) }),
    },
    opts.label,
  );
};

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

/**
 * The query of a read with its types as names, and the versions its references hold: `read.records(Type, query)`
 * is `read.records({ ...query, types: [Type] })`.
 */
function readQuery(first: unknown, second: unknown): { query: Record<string, unknown>; versions: Record<string, number> } {
  const given = (isRecordRef(first) ? { ...(second as Record<string, unknown> | undefined), types: [first] } : (first ?? {})) as Record<string, unknown>;
  if (!Array.isArray(given.types)) return { query: given, versions: {} };
  const versions: Record<string, number> = {};
  const types = given.types.map((type: unknown) => {
    const named = typeNamed(type, "read.records({ types })");
    if (named.version !== undefined) versions[named.name] = named.version;
    return named.name;
  });
  return { query: { ...given, types }, versions };
}

globals.read = {
  state: (plugin: string, opts: CallOptions = {}): Promise<unknown> => request({ op: "read-state", plugin }, opts.label),
  records: (first: unknown, second?: unknown, third?: CallOptions): Promise<unknown> => {
    const opts = (isRecordRef(first) ? third : (second as CallOptions | undefined)) ?? {};
    let read: ReturnType<typeof readQuery>;
    try {
      read = readQuery(first, second);
    } catch (error) {
      return Promise.reject(error);
    }
    const versions = Object.keys(read.versions).length === 0 ? {} : { versions: read.versions };
    return request({ op: "read-records", query: read.query, ...versions }, opts.label);
  },
};

globals.now = (opts: CallOptions = {}): Promise<unknown> => request({ op: "now" }, opts.label);
globals.random = (opts: CallOptions = {}): Promise<unknown> => request({ op: "random" }, opts.label);

// --- groups of branches ------------------------------------------------------------------
//
// A group is a scope of structured concurrency: the branches started in it never outlive it.
// Leaving the block waits for the branches (`onExit: "wait"`) or cancels them (`"cancel"`); a
// block that throws cancels them. The host keeps the group: its branches, their outcomes in the
// order they were committed, its deadline and whether it is shielded, so a replay meets the
// outcomes in the order the script met them.

/** How a branch ended, as the script sees it. */
type Settled = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

/** A branch of a group. */
interface Member {
  readonly key: string;
  /** The key prefix of the branch: the path of the group and the key. */
  readonly path: string;
  /** The outcome, once the branch ended and the host committed it. */
  result?: Settled;
  /** The error the branch threw, as it was thrown: what `parallel` throws again. */
  error?: unknown;
  /** The place of the outcome among the outcomes of the group. */
  order?: number;
  /** Why the branch was cancelled, when it was. */
  cancelled?: string;
  /** Ends when the branch has ended and its outcome is committed. */
  done: Promise<Settled>;
}

/** What `scope()` takes. */
interface ScopeOptions {
  concurrency?: number;
  onExit?: "wait" | "cancel";
  deadline?: Duration;
  onDeadline?: "skip" | "fail";
  shield?: boolean;
}

/** What the host answers when a group opens. */
interface OpenAnswer {
  concurrency?: number;
  deadline?: number;
  known: Array<{ key: string; order: number; outcome: string }>;
  closed?: "done" | "failed" | "deadline";
}

/** A group the script opened. */
interface Group {
  readonly path: string;
  readonly segments: readonly string[];
  /** The branch the group was opened in; the script itself when absent. */
  readonly within: Branch | undefined;
  readonly shield: boolean;
  readonly members: Map<string, Member>;
  /** The outcomes committed in this process, by their place. */
  readonly settled: Map<number, Member>;
  /** The places the run committed before for branches that have not ended in this process yet: key by place. */
  readonly expected: Map<number, string>;
  /** The places already given to the script. */
  readonly given: Set<number>;
  readonly listeners: Set<() => void>;
  readonly queue: Array<() => void>;
  limit: number;
  running: number;
  /** Why the whole group, its block with it, was cancelled. */
  cancelled: string | undefined;
  /** Why the branches of the group were cancelled: a branch started after that starts cancelled. */
  branchesCancelled: string | undefined;
  /** An error that pauses the run, met by a branch: the group throws it to whoever reads it. */
  pausedBy: unknown;
  /** A branch of the group ran a call: once the group closes, what comes after it lies after a change. */
  diverged: boolean;
  open: boolean;
  requests: number;
}

/** A stream: a group whose branches are listened to one outcome at a time, closed when it is disposed. */
interface StreamHandle {
  /** Close it, and throw the error of its opening when it had one. */
  close(): Promise<void>;
  /** Close it as the end of its branch or of the script does: an error of its opening that a read gave already is not thrown again. */
  release(): Promise<void>;
}

/** The error a scope with `onDeadline: "fail"` throws when it runs out of time. */
class DeadlineExceeded extends Error {
  override name = "DeadlineExceeded";
}
globals.DeadlineExceeded = DeadlineExceeded;

/** The errors that pause the run: a step did not complete. A branch that meets one does not end with it; its group throws it. */
const pausing = new WeakSet<object>();

/** Whether an error pauses the run. */
const pausesRun = (error: unknown): boolean => typeof error === "object" && error !== null && pausing.has(error);

/** The paths of the groups opened in this run: a path names one group. */
const opened = new Set<string>();

/** A key of a branch, or a name of a scope: one part of a key prefix, so none of the marks a key is made of. */
function checkPart(part: unknown, what: string): string {
  if (typeof part !== "string" || part === "") throw new TypeError(`${what} is a text that is not empty`);
  if (/[.~/:\s]/.test(part) || part.startsWith("@") || /^call-\d+$/.test(part)) {
    throw new TypeError(`${what} "${part}" may not hold ".", "~", "/", ":" or a space, start with "@" or be call-<n>`);
  }
  return part;
}

/** Why the branches of a group are cancelled from outside it: the group's own cancel, or one above it up to a shield. */
function groupCancelled(group: Group): string | undefined {
  return group.cancelled ?? (group.shield ? undefined : cancelledFor(group.within));
}

/** Why a branch is cancelled: its own cancel, its group's, or a cancel of the branch its group is in, up to a shield. */
function cancelledFor(branch: Branch | undefined): string | undefined {
  for (let at = branch; at !== undefined; ) {
    if (at.member?.cancelled !== undefined) return at.member.cancelled;
    const group = at.group;
    if (group === undefined) return undefined;
    if (group.cancelled !== undefined) return group.cancelled;
    if (group.shield) return undefined;
    at = group.within;
  }
  return undefined;
}

/** Tell those who wait on a group that something changed in it. */
function changed(group: Group): void {
  for (const listener of [...group.listeners]) listener();
}

/** Wait until something changes in the group. */
function nextChange(group: Group): Promise<void> {
  return new Promise((resolve) => {
    const listener = (): void => {
      group.listeners.delete(listener);
      resolve();
    };
    group.listeners.add(listener);
  });
}

/** Take a place to run a branch: a group with a limit runs no more branches than that at once. */
async function enter(group: Group): Promise<void> {
  if (group.running < group.limit) {
    group.running += 1;
    return;
  }
  // The place is handed on by the branch that leaves it.
  await new Promise<void>((resolve) => group.queue.push(resolve));
}

function leave(group: Group): void {
  const next = group.queue.shift();
  if (next !== undefined) next();
  else group.running -= 1;
}

/** Run the block or a branch of a group in a branch of its own, with the path it is keyed under. */
function inGroup<T>(group: Group, path: string, member: Member | undefined, body: () => T | Promise<T>): Promise<T> {
  const parent = BRANCH.getStore();
  const phase = parent === undefined ? outsidePhase : parent.phase;
  const branch: Branch = {
    path,
    ordinal: 0,
    groups: 0,
    phase,
    phases: 0,
    group,
    ...(member === undefined ? {} : { member }),
    streams: new Set(),
    diverged: divergedIn(parent),
  };
  // The block of a group is the branch it was opened in, as far as phases go: only a member is a branch with a phase of its own.
  const own = member !== undefined;
  return BRANCH.run(branch, async () => {
    if (own && phase !== undefined) say({ kind: "phase", branch: path, ordinal: 0, phase });
    try {
      return await body();
    } finally {
      await closeStreams(branch.streams);
      if (branch.diverged) group.diverged = true;
      if (own && branch.phase !== undefined) say({ kind: "left", branch: path });
    }
  });
}

/** Close the streams a branch left open: nothing started in a branch outlives it. */
async function closeStreams(streams: Set<StreamHandle>): Promise<void> {
  for (const stream of [...streams]) await stream.release();
}

/** What a thrown value says as an outcome: a cancel when the branch was cancelled or a step of it was. */
function failureOf(error: unknown, cancelled: string | undefined): Settled {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "StepCancelled" || cancelled !== undefined) return { ok: false, error: { name: "Cancelled", message: cancelled ?? message } };
  return { ok: false, error: { name, message } };
}

/** Start a branch of a group: it joins the group at once, and runs when the group has a place for it. */
function startMember(group: Group, key: string, fn: () => unknown): Member {
  checkPart(key, "the key of a branch");
  if (!group.open) throw new Error(`the scope "${group.segments.join("/")}" is closed: start its branches inside its block`);
  if (group.members.has(key)) throw new Error(`the scope "${group.segments.join("/")}" has a branch "${key}" already: a key names one branch`);
  const path = `${group.path}.${key}`;
  say({ kind: "branched", scope: group.path, key });
  const member: Member = { key, path, done: Promise.resolve({ ok: true, value: undefined }) };
  if (group.branchesCancelled !== undefined) member.cancelled = group.branchesCancelled;
  group.members.set(key, member);
  member.done = (async (): Promise<Settled> => {
    let result: Settled;
    await enter(group);
    try {
      const cancelled = member.cancelled ?? groupCancelled(group);
      if (cancelled !== undefined) result = { ok: false, error: { name: "Cancelled", message: cancelled } };
      else result = { ok: true, value: await inGroup(group, path, member, () => Promise.resolve().then(fn)) };
    } catch (error) {
      member.error = error;
      result = failureOf(error, member.cancelled ?? groupCancelled(group));
    } finally {
      leave(group);
    }
    if (pausesRun(member.error)) {
      // The run pauses on a step of the branch: the branch has no outcome, and the group throws the error to whoever reads it.
      group.pausedBy ??= member.error;
      changed(group);
      return result;
    }
    const outcome = result.ok ? "done" : result.error.name === "Cancelled" ? "cancelled" : "failed";
    const committed = (await requestAt(
      { op: "scope-settled", scope: group.path, key, outcome, ...(result.ok ? {} : { error: result.error }) },
      `${path}~settled`,
    )) as { order: number };
    member.result = result;
    member.order = committed.order;
    for (const [order, expected] of group.expected) if (expected === key) group.expected.delete(order);
    group.settled.set(committed.order, member);
    changed(group);
    return result;
  })();
  return member;
}

/**
 * The next outcome of a group, in the order the host committed them.
 *
 * A place the run committed before for a branch that is going is waited for: the outcomes come
 * in the order the script met them the first time, whichever branch ends first now.
 */
async function nextOf(group: Group): Promise<{ key: string; result: Settled } | null> {
  for (;;) {
    if (group.pausedBy !== undefined) throw group.pausedBy;
    let best: number | undefined;
    for (const order of group.settled.keys()) if (!group.given.has(order) && (best === undefined || order < best)) best = order;
    for (const [order, key] of group.expected) {
      const member = group.members.get(key);
      if (member !== undefined && member.result === undefined && (best === undefined || order < best)) best = order;
    }
    const member = best === undefined ? undefined : group.settled.get(best);
    if (best !== undefined && member?.result !== undefined) {
      group.given.add(best);
      return { key: member.key, result: member.result };
    }
    if (best === undefined && [...group.members.values()].every((one) => one.result !== undefined)) return null;
    await nextChange(group);
  }
}

/** Record what the group sees now, so a replay sees the same. */
async function snapshot(group: Group, keys: string[]): Promise<string[]> {
  return (await requestAt({ op: "scope-snapshot", scope: group.path, keys }, `snapshot:${group.path}:${String(++group.requests)}`)) as string[];
}

/**
 * Cancel branches of a group: the host ends their steps, and those of the groups inside them up to a shield.
 *
 * The prefixes are a step the host checks on a replay, so they are what the script decided and not
 * which branches happen to have ended by now: a branch that ended keeps its recorded outcome under a
 * cancel. Only the branches still going are marked cancelled here.
 */
async function cancelMembers(group: Group, reason: string, targets: readonly Member[], whole: boolean): Promise<void> {
  const prefixes = whole ? [group.path] : targets.map((member) => member.path);
  for (const member of targets) if (member.result === undefined) member.cancelled ??= reason;
  if (prefixes.length === 0) return;
  for (const [key, path] of inflightLabels) {
    if (prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) prefixes.push(key);
  }
  await requestAt({ op: "scope-cancel", scope: group.path, prefixes, reason }, `cancel:${group.path}:${String(++group.requests)}`);
}

/** The scope a block of a group is given. */
function scopeApi(group: Group) {
  const branchOf = (member: Member) => ({
    key: member.key,
    settled: async (): Promise<Settled> => {
      const result = await member.done;
      if (group.pausedBy !== undefined) throw group.pausedBy;
      return result;
    },
    value: async (): Promise<unknown> => {
      const result = await member.done;
      if (group.pausedBy !== undefined) throw group.pausedBy;
      if (result.ok) return result.value;
      throw member.error ?? Object.assign(new Error(result.error.message), { name: result.error.name });
    },
  });
  const api = {
    path: group.segments,
    start: (key: string, fn: () => unknown) => branchOf(startMember(group, key, fn)),
    run: (key: string, child: { id: string; version?: string; args?: unknown }) => {
      if (typeof child?.id !== "string") throw new TypeError("run(key, { id, args }): the child is a registered workflow, by its id");
      return branchOf(startMember(group, key, () => callOf(`flow.${child.id}`, child.args ?? {}, undefined)));
    },
    next: () => nextOf(group),
    ready: async (): Promise<Array<{ key: string; result: Settled }>> => {
      const now = [...group.settled.entries()].filter(([order]) => !group.given.has(order)).sort(([a], [b]) => a - b);
      const keys = await snapshot(group, now.map(([, member]) => member.key));
      const out: Array<{ key: string; result: Settled }> = [];
      for (const key of keys) {
        const member = group.members.get(key);
        if (member === undefined) continue;
        const result = await member.done;
        if (group.pausedBy !== undefined) throw group.pausedBy;
        if (member.order !== undefined) group.given.add(member.order);
        out.push({ key, result });
      }
      return out;
    },
    rest: async (): Promise<Record<string, Settled>> => {
      // A key is any text a branch may have, `__proto__` among them: the outcomes are kept in a map and then made properties.
      const all = new Map<string, Settled>();
      for (const member of [...group.members.values()]) {
        all.set(member.key, await member.done);
        if (group.pausedBy !== undefined) throw group.pausedBy;
        if (member.order !== undefined) group.given.add(member.order);
      }
      return Object.fromEntries(all);
    },
    pending: (): Promise<string[]> =>
      snapshot(group, [...group.members.values()].filter((member) => member.result === undefined).map((member) => member.key)),
    cancel: async (reason?: string, keys?: string[]): Promise<void> => {
      const why = reason ?? "cancelled by the script";
      if (keys === undefined) group.branchesCancelled ??= why;
      const targets = (keys ?? [...group.members.keys()]).flatMap((key) => {
        const member = group.members.get(key);
        return member === undefined ? [] : [member];
      });
      await cancelMembers(group, why, targets, false);
    },
  };
  groups.set(api, group);
  return api;
}

type ScopeApi = ReturnType<typeof scopeApi>;

/**
 * Open a group under a path, run its block, and close it: nothing started in it outlives it.
 *
 * The block runs keyed under the path of the group, so a cancel of the whole group (its deadline)
 * holds the block's own steps as well as those of its branches.
 */
async function runGroup<T>(path: string, segments: readonly string[], opts: ScopeOptions, fn: (s: ScopeApi) => Promise<T>): Promise<T | undefined> {
  if (opened.has(path)) throw new Error(`the scope "${segments.join("/")}" is opened twice: give each scope its own name`);
  opened.add(path);
  const within = BRANCH.getStore();
  const onExit = opts.onExit ?? "wait";
  const answer = (await requestAt(
    {
      op: "scope-open",
      scope: path,
      onExit,
      ...(opts.deadline === undefined ? {} : { deadlineMs: durationMs(opts.deadline) }),
      ...(opts.onDeadline === undefined ? {} : { onDeadline: opts.onDeadline }),
      ...(opts.shield === true ? { shield: true } : {}),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    },
    `${path}~open`,
  )) as OpenAnswer;
  const group: Group = {
    path,
    segments,
    within,
    shield: opts.shield === true,
    members: new Map(),
    settled: new Map(),
    expected: new Map(answer.known.map((known) => [known.order, known.key])),
    given: new Set(),
    listeners: new Set(),
    queue: [],
    limit: Math.min(opts.concurrency ?? Number.POSITIVE_INFINITY, answer.concurrency ?? Number.POSITIVE_INFINITY),
    running: 0,
    cancelled: undefined,
    branchesCancelled: undefined,
    pausedBy: undefined,
    diverged: false,
    open: true,
    requests: 0,
  };
  let blockDone = false;
  // The deadline is the host's: it answers when its clock reaches the moment, and a group that closed before keeps how it closed.
  let ranOut = answer.closed === "deadline";
  if (ranOut) group.cancelled = "the deadline passed";
  if (answer.deadline !== undefined && answer.closed === undefined) {
    void requestAt({ op: "scope-deadline", scope: path, at: answer.deadline }, `${path}~deadline`).then(async (reply) => {
      if (blockDone || (reply as { fired?: boolean }).fired !== true) return;
      ranOut = true;
      group.cancelled = "the deadline passed";
      changed(group);
      await cancelMembers(group, "the deadline passed", [...group.members.values()].filter((member) => member.result === undefined), true);
    });
  }
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await inGroup(group, path, undefined, () => fn(scopeApi(group)));
  } catch (error) {
    failed = true;
    failure = error;
  }
  blockDone = true;
  // A step did not complete and the run pauses on it: nothing is waited for, the script ends here.
  if (failed && pausesRun(failure)) throw failure;
  if (group.pausedBy !== undefined) throw group.pausedBy;
  if (failed || onExit === "cancel") {
    // The branches the script was not given an outcome of: the outcomes are given in the order the run committed them, on a replay too.
    const left = [...group.members.values()].filter((member) => member.order === undefined || !group.given.has(member.order));
    group.branchesCancelled ??= failed ? "the scope failed" : "the scope was left";
    await cancelMembers(group, group.branchesCancelled, left, false);
  }
  group.open = false;
  while (group.pausedBy === undefined && [...group.members.values()].some((member) => member.result === undefined)) await nextChange(group);
  // A step of a branch did not complete: the run pauses on it, and the group does not close.
  if (group.pausedBy !== undefined) throw group.pausedBy;
  const outcome = ranOut ? "deadline" : failed ? "failed" : "done";
  await requestAt({ op: "scope-close", scope: path, outcome }, `${path}~close`);
  // A branch that ran a call leaves what comes after the group after a change.
  if (group.diverged) diverge(within);
  if (ranOut) {
    if (opts.onDeadline === "fail") throw new DeadlineExceeded(`the scope "${segments.join("/")}" ran out of time`);
    return undefined;
  }
  if (failed) throw failure;
  return result;
}

/** The path of a named scope opened where the caller is, and its segments. */
function namedPath(name: string): { path: string; segments: string[] } {
  checkPart(name, "the name of a scope");
  const branch = BRANCH.getStore();
  const segments = [...(branch?.group?.segments ?? []), ...(branch?.member === undefined ? [] : [branch.member.key]), name];
  return { path: branch === undefined ? `@${name}` : `${branch.path}.@${name}`, segments };
}

/** The path of a numbered group (`parallel`) opened where the caller is. */
function numberedPath(): { path: string; segments: string[] } {
  const name = nextGroup("p");
  const branch = BRANCH.getStore();
  const segments = [...(branch?.group?.segments ?? []), ...(branch?.member === undefined ? [] : [branch.member.key]), name];
  return { path: branch === undefined ? name : `${branch.path}.${name}`, segments };
}

globals.scope = (name: string, opts: ScopeOptions | ((s: ScopeApi) => Promise<unknown>) | undefined, fn?: (s: ScopeApi) => Promise<unknown>): Promise<unknown> => {
  const block = typeof opts === "function" ? opts : fn;
  const options = typeof opts === "function" || opts === undefined ? {} : opts;
  if (typeof block !== "function") return Promise.reject(new TypeError("scope(name, opts, async (s) => { ... }): the block is a function"));
  try {
    const { path, segments } = namedPath(name);
    return runGroup(path, segments, options, block);
  } catch (error) {
    return Promise.reject(error);
  }
};

globals.moveOnAfter = (name: string, deadline: Duration, fn: () => Promise<unknown>): Promise<unknown> =>
  (globals.scope as (n: string, o: ScopeOptions, f: () => Promise<unknown>) => Promise<unknown>)(name, { deadline, onDeadline: "skip" }, () => fn());

globals.failAfter = (name: string, deadline: Duration, fn: () => Promise<unknown>): Promise<unknown> =>
  (globals.scope as (n: string, o: ScopeOptions, f: () => Promise<unknown>) => Promise<unknown>)(name, { deadline, onDeadline: "fail" }, () => fn());

/**
 * Branches at once, keyed by the index of a list or the keys of an object. The answer is in the
 * same shape. A branch that fails cancels the others, and its error is thrown once they ended.
 */
globals.parallel = async (branches: Array<() => unknown> | Record<string, () => unknown>, opts: { concurrency?: number } = {}): Promise<unknown> => {
  const entries: Array<[string, () => unknown]> = Array.isArray(branches)
    ? branches.map((fn, index) => [String(index), fn])
    : Object.entries(branches);
  for (const [key, fn] of entries) {
    checkPart(key, "the key of a branch");
    if (typeof fn !== "function") throw new TypeError(`parallel: the branch "${key}" is not a function`);
  }
  const { path, segments } = numberedPath();
  const results = (await runGroup(path, segments, { ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, async (s) => {
    const members = entries.map(([key, fn]) => [key, startMember(groupOf(s), key, fn)] as const);
    const out = new Map<string, unknown>();
    for (let got = await s.next(); got !== null; got = await s.next()) {
      if (!got.result.ok) {
        const failedMember = members.find(([key]) => key === got?.key)?.[1];
        throw failedMember?.error ?? Object.assign(new Error(got.result.error.message), { name: got.result.error.name });
      }
      out.set(got.key, got.result.value);
    }
    return Object.fromEntries(out);
  })) as Record<string, unknown>;
  return Array.isArray(branches) ? entries.map(([key]) => results[key]) : results;
};

/** The group behind a scope a block was given. */
const groups = new WeakMap<object, Group>();
function groupOf(s: ScopeApi): Group {
  const group = groups.get(s);
  if (group === undefined) throw new Error("not a scope of this script");
  return group;
}

/**
 * A stream: the branches start at once, and the outcomes are read one at a time in the order the
 * host committed them. Closing it (or leaving the branch it was opened in) cancels what is left.
 */
globals.stream = (name: string, branches: Record<string, () => unknown>, opts: { concurrency?: number } = {}) => {
  const { path, segments } = namedPath(name);
  const owner = BRANCH.getStore();
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let ready: (s: ScopeApi) => void = () => undefined;
  let refuse: (error: unknown) => void = () => undefined;
  const begun = new Promise<ScopeApi>((resolve, reject) => {
    ready = resolve;
    refuse = reject;
  });
  // A stream that could not be opened gives every read the error of its opening, and a read that has is the one that saw it.
  let opening = true;
  let openFailed = false;
  let seen = false;
  begun.catch(() => undefined);
  const opened = async (): Promise<ScopeApi> => {
    try {
      return await begun;
    } catch (error) {
      seen = true;
      throw error;
    }
  };
  const done = runGroup(path, segments, { onExit: "cancel", ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) }, async (s) => {
    for (const [key, fn] of Object.entries(branches)) s.start(key, fn);
    opening = false;
    ready(s);
    await closed;
  });
  done.catch((error: unknown) => {
    if (!opening) return;
    openFailed = true;
    refuse(error);
  });
  const streams = owner?.streams ?? rootStreams;
  const finish = async (explicit: boolean): Promise<void> => {
    streams.delete(handle);
    close();
    try {
      await done;
    } catch (error) {
      // Leaving the branch the stream was opened in, or the script, does not say again what a read said already.
      if (explicit || !openFailed || !seen) throw error;
    }
  };
  const handle = {
    next: async () => (await opened()).next(),
    ready: async () => (await opened()).ready(),
    rest: async () => (await opened()).rest(),
    pending: async () => (await opened()).pending(),
    cancel: async (keys?: string[]) => (await opened()).cancel("cancelled by the script", keys),
    close: (): Promise<void> => finish(true),
    release: (): Promise<void> => finish(false),
    async *[Symbol.asyncIterator]() {
      for (let got = await handle.next(); got !== null; got = await handle.next()) yield got;
    },
    [Symbol.asyncDispose]: (): Promise<void> => finish(false),
  };
  streams.add(handle);
  return handle;
};

/** The streams the script itself opened and did not close: they close when the script ends. */
const rootStreams = new Set<StreamHandle>();

/** The first branch to succeed: its key and value. The others are cancelled; when every branch fails, the first error is thrown. */
globals.race = (name: string, branches: Record<string, () => unknown>): Promise<unknown> => {
  try {
    const { path, segments } = namedPath(name);
    return runGroup(path, segments, { onExit: "cancel" }, async (s) => {
      const group = groupOf(s);
      for (const [key, fn] of Object.entries(branches)) startMember(group, key, fn);
      let first: unknown;
      for (let got = await s.next(); got !== null; got = await s.next()) {
        if (got.result.ok) return { key: got.key, value: got.result.value };
        first ??= group.members.get(got.key)?.error ?? new Error(got.result.error.message);
      }
      throw first ?? new Error(`race "${name}": no branch to run`);
    });
  } catch (error) {
    return Promise.reject(error);
  }
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
  for (const name of ["agent", "call", "wait", "sleep", "emit", "now", "random", "scope", "parallel", "stream", "race", "moveOnAfter", "failAfter", "pipeline", "phase", "log"]) {
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
      const answer = JSON.parse(line) as { ordinal: number; ok?: boolean; parked?: boolean; value?: unknown; error?: string; name?: string; pauses?: boolean; fresh?: boolean };
      const waiter = pending.get(answer.ordinal);
      if (answer.parked === true) {
        // The call waits for a record: a later start of the run gets its answer.
        if (waiter !== undefined) waiter.parked = true;
        holdWhileNeeded();
        continue;
      }
      pending.delete(answer.ordinal);
      holdWhileNeeded();
      // The call ran instead of being taken from an earlier start: what comes after it in its branch runs too.
      if (answer.fresh === true && waiter !== undefined) diverge(waiter.branch);
      if (answer.ok) waiter?.resolve(answer.value);
      else {
        const failed = new Error(answer.error ?? "the call failed");
        if (answer.name !== undefined) failed.name = answer.name;
        if (answer.pauses === true) pausing.add(failed);
        waiter?.reject(failed);
      }
    }
  });
  // The parent is gone: nobody is left to answer, so the process ends instead of waiting for ever.
  process.stdin.on("end", () => exitWith(1));

  // The script runs outside the top level of the module: a top level that is still waiting would hold
  // the process, and one whose calls are all parked must be free to end.
  void (async (): Promise<void> => {
    try {
      const declared = await loadScript();
      const args: unknown = JSON.parse(argsJson ?? "null");
      // A script that starts on records is given the record; any other is given its input, parsed and with the defaults put in.
      const input = isZod(declared.declaration.input) ? await declared.declaration.input.parseAsync(args) : args;
      const result = await (declared.declaration.input === undefined && declared.declaration.on === undefined ? declared.run() : declared.run(input));
      // A stream the script left open is closed: nothing it started outlives it.
      await closeStreams(rootStreams);
      say({ kind: "done", result: result ?? null }, () => exitWith(0));
    } catch (error) {
      // The name goes with the message: the host tells an `ask` that ended with no answer from any other error.
      say(
        { kind: "failed", error: error instanceof Error ? error.message : String(error), ...(error instanceof Error ? { name: error.name } : {}) },
        () => exitWith(0),
      );
    }
  })();
}
