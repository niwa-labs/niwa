/**
 * The types a workflow script is given, with no import: the check of a script can load this one file in place of the
 * package entry, so a script that imports `ScriptApi` does not pull the rest of niwa into the type checker.
 */

/** A duration as a script writes it: milliseconds, or a text such as "500ms", "30s", "5m", "2h", "1d". */
export type Duration = number | string;

/**
 * What every call of a script may carry: the label is the key of the call; the reason is why an
 * action is called, shown to the owner when a rule of the script's grant asks.
 */
export interface CallOptions {
  label?: string;
  reason?: string;
}

/** The worktree an `agent({ worktree })` call left: present when the work changed something in it. */
export interface AgentWorktree {
  id: string;
  path: string;
  branch: string;
  changed: boolean;
}

/** One thing a box asks for: a profile by its name, `"project"`, `"toolchains"`, or a path or a host. */
export type BoxItem = string | { read: string } | { write: string } | { net: string };

/**
 * What an `agent()` call may ask for besides its schema. The options of the harness's kind go in the
 * block named after the kind; the block of another kind is refused. A kind with no option of its own
 * takes an empty block.
 */
export interface AgentCallOptions {
  harness?: string;
  label?: string;
  visible?: string[];
  model?: string;
  effort?: string;
  mode?: "ask" | "auto" | "full";
  cwd?: string;
  /** How long a turn of the session may go with no progress before it counts as stuck: kept in the record of the session. */
  stuckAfter?: Duration;
  /** Run the session in a new git worktree; removed at the end when clean with no new commit, else the answer carries `worktree`. */
  worktree?: true | { repo?: string; base?: string; description?: string };
  /**
   * What the session's box has besides the host's default (`allow`) or instead of it (`only`): `"project"`,
   * `"toolchains"`, a profile by its name, `{ read }`, `{ write }`, `{ net }`. Beyond the default takes the run's `box.*` rules.
   */
  box?: { allow: BoxItem[] } | { only: BoxItem[] };
  /** Claude Code (`claude-code`, `claude-sdk`): `advisor: false` takes its advisor tool away from the session. */
  claude?: { advisor?: boolean };
  codex?: Record<string, never>;
  mcode?: Record<string, never>;
  ncode?: Record<string, never>;
  pi?: Record<string, never>;
  zcode?: Record<string, never>;
}

/** An option of `ask.choice` and `ask.multi`: the id alone, or the id with how it is shown. */
export type AskOption = string | { id: string; label?: string; description?: string };

/** The id of an option: what the script gets back. */
export type AskOptionId<T> = T extends string ? T : T extends { id: infer I extends string } ? I : never;

/** What an `ask.<kind>` call may carry. */
export interface AskCallOptions {
  timeout?: Duration;
  label?: string;
}

/** A phase of a script: its title, which `phase(title)` names, and a line of what is done in it. */
export interface WorkflowPhase {
  title: string;
  detail?: string;
}

/** What a script declares besides its schemas and the record it starts on. */
export interface WorkflowDeclaration {
  name?: string;
  description?: string;
  uses?: string[];
  /** The phases of the script, in order: `phase(title)` enters one, and a run shows which are done, current and ahead. */
  phases?: WorkflowPhase[];
  /** The records the script writes: what `record(name, schema)` gives. */
  emits?: RecordDeclaration[];
}

/** What the default export of a script is: what `workflow(...)` gives. */
export interface WorkflowScript {
  readonly niwaWorkflow: true;
}

/** What a function of a script returns: what its `output` says, or nothing when it has none. */
type WorkflowResult<O extends import("zod").z.ZodType> = [O] extends [never] ? void : import("zod").z.output<O>;

/** What `wait()` answers when the record did not come in time. */
export interface TimedOut {
  timedOut: true;
}

/** What `wait()` answers with: the data of the record, and its position, to wait or read on from. */
export interface ScriptWaited<D = any> {
  data: D;
  at: number;
}

/**
 * A record type a plugin declares, as a script imports it from the plugin's records entry
 * (`import { TaskDone } from "@niwa-labs/tasks/records"`): a wait or a read that names it gives the
 * data its schema gives. The host refuses one it does not know, or of a version it does not write.
 */
export interface ScriptRecordRef<D = unknown> {
  readonly kind: "record";
  readonly name: string;
  readonly version: number;
  readonly schema: { readonly _zod: { readonly output: D } };
}

/** The data of the records of a referenced type. */
export type ScriptRecordData<R> = R extends { readonly schema: { readonly _zod: { readonly output: infer D } } } ? D : unknown;

/** The dotted paths into data: a field, or a field of a field, four levels deep at most. */
export type ScriptDataPath<D, Depth extends unknown[] = []> = Depth["length"] extends 4
  ? never
  : D extends readonly unknown[]
    ? never
    : D extends object
      ? { [K in keyof D & string]-?: K | `${K}.${ScriptDataPath<NonNullable<D[K]>, [...Depth, 0]>}` }[keyof D & string]
      : never;

/** The value at a dotted path into data. */
export type ScriptDataAt<D, P extends string> = D extends unknown
  ? P extends keyof D
    ? D[P]
    : P extends `${infer Head}.${infer Rest}`
      ? Head extends keyof D
        ? ScriptDataAt<NonNullable<D[Head]>, Rest>
        : never
      : never
  : never;

/** The filter of a wait or a read of a referenced type: values for fields of its data, by field name or dotted path. */
export type ScriptFilter<D> = unknown extends D ? Record<string, unknown> : { [P in ScriptDataPath<D>]?: ScriptDataAt<D, P> };

/** A query of one referenced type and a filter on its data, as a plugin's query builder gives it (`taskDone(task)`). */
export interface ScriptTypeQuery<R> {
  readonly types: readonly [R];
  readonly filter?: ScriptFilter<ScriptRecordData<R>>;
  readonly from?: number;
  /** A wait looks at every stream: a query that names one is for a read, not a wait. */
  readonly stream?: undefined;
}

/**
 * Which records a script reads or waits for: the types as exact names, families written `prefix.*`
 * or references, equality on paths of the data, a stream, and the position to look after.
 */
export interface ScriptRecordQuery {
  from?: number;
  types?: ReadonlyArray<string | ScriptRecordRef<any>>;
  filter?: Record<string, unknown>;
  stream?: string;
}

/** Where a read starts, what stream it reads, and how much. */
export interface ScriptReadOptions {
  from?: number;
  stream?: string;
  limit?: number;
  tail?: number;
}

/** A record a read answers with: as the journal keeps it, with its data. */
export interface ScriptStoredRecord<D = any> {
  id: string;
  seq: number;
  stream: string;
  type: string;
  schema: number;
  data: D;
  cause: string | null;
  root: string;
  at: number;
  actor: { kind: string };
}

/**
 * Whether a list of record types is known to name only referenced types: a tuple of at least one reference. A list that
 * may be empty (a record type list built at run time) selects every type when it is, and one that holds a name
 * written as text has no data type to give.
 */
export type ScriptRefsOnly<T extends readonly unknown[]> = T extends readonly [] ? false : number extends T["length"] ? false : T[number] extends ScriptRecordRef<any> ? true : false;

/** The filter of a read of a list of record types: by the data of the references when every one is, else by any field. */
export type ScriptTypesFilter<T extends readonly unknown[]> = ScriptRefsOnly<T> extends true ? ScriptFilter<ScriptRecordData<T[number]>> : Record<string, unknown>;

/** A record of one referenced type, with its data typed by it; spread over a union of references, one record type each. */
export type ScriptRecordOf<R> = R extends unknown ? ScriptStoredRecord<ScriptRecordData<R>> : never;

/** The records a read of a list of record types answers with: typed by the references when every type is one, else of data of unknown shape. */
export type ScriptTypesRecords<T extends readonly unknown[]> = ScriptRefsOnly<T> extends true ? ScriptRecordOf<T[number]> : ScriptStoredRecord<unknown>;

/**
 * What a script is given. The globals are declared in a script with
 * `declare const wait: ScriptApi["wait"]` and so on: a declaration for the whole project would
 * put names like `sleep` and `log` in front of every module. The answers are `any`: they are
 * typed by `workflow.guide`, which generates the declarations of the actions from `describe()`.
 */
export interface ScriptApi {
  /** zod, a global of the script: `z.object({ ... })` for `input`, `output` and the schema of `agent`. */
  z: typeof import("zod").z;
  /**
   * The script: `export default workflow({ description, input, output, uses }, async (input) => { ... })`. The function
   * is given `input` parsed (a script with no `input` is given nothing) and returns what `output` says (a script with
   * no `output` returns nothing).
   */
  workflow<I extends import("zod").z.ZodObject = never, O extends import("zod").z.ZodType = never>(
    declaration: WorkflowDeclaration & { input?: I; output?: O; on?: undefined },
    run: (...input: [I] extends [never] ? [] : [import("zod").z.output<I>]) => Promise<WorkflowResult<O>>,
  ): WorkflowScript;
  /** A script that niwa starts on records: `on` lists them, and the function is given the record, of the type the script writes. */
  workflow<Trigger, O extends import("zod").z.ZodType = never>(
    declaration: WorkflowDeclaration & { on: Array<string | { type: string; filter?: Record<string, unknown> }>; input?: undefined; output?: O },
    run: (trigger: Trigger) => Promise<WorkflowResult<O>>,
  ): WorkflowScript;
  /** Call any action by name. A finished call is not repeated on a replay. */
  call(name: string, input: unknown, opts?: CallOptions): Promise<any>;
  /** `niwa.task.create(input, { label })` is `call("task.create", input, { label })`; the wrappers are generated. */
  niwa: ActionGroup;
  /**
   * Start a session in a harness and ask it. `visible` names the actions the session sees besides the one that answers.
   * With a zod `schema` the answer is that value, parsed and typed as the schema says; without one it is `{ answer }`, the text.
   */
  agent<S extends import("zod").z.ZodObject | import("zod").z.ZodRecord>(
    prompt: string,
    opts: AgentCallOptions & { schema: S; worktree: NonNullable<AgentCallOptions["worktree"]> },
  ): Promise<import("zod").z.output<S> & { worktree?: AgentWorktree }>;
  agent(prompt: string, opts: AgentCallOptions & { schema?: undefined; worktree: NonNullable<AgentCallOptions["worktree"]> }): Promise<{ answer: string; worktree?: AgentWorktree }>;
  agent<S extends import("zod").z.ZodType>(prompt: string, opts: AgentCallOptions & { schema: S; worktree?: undefined }): Promise<import("zod").z.output<S>>;
  agent(prompt: string, opts?: AgentCallOptions & { schema?: undefined; worktree?: undefined }): Promise<{ answer: string }>;
  /**
   * The first record of a type whose data holds every field of `filter`, written after `from` — a
   * position an earlier wait or read answered — or after the wait began: its data and its position.
   * Without a `timeout` it waits for ever; the wait survives a restart of the host.
   */
  wait<R extends ScriptRecordRef<any>>(
    type: R,
    opts?: { filter?: ScriptFilter<ScriptRecordData<R>>; from?: number; label?: string; timeout?: undefined },
  ): Promise<ScriptWaited<ScriptRecordData<R>>>;
  /** The same, or `{ timedOut: true }` at the end of the timeout: options that may hold a `timeout` give both. */
  wait<R extends ScriptRecordRef<any>>(
    type: R,
    opts: { filter?: ScriptFilter<ScriptRecordData<R>>; from?: number; label?: string; timeout?: Duration },
  ): Promise<ScriptWaited<ScriptRecordData<R>> | TimedOut>;
  /** The first record that answers a query of one referenced type, as a plugin's query builder gives it: after `from` (the option, else the query's). */
  wait<R extends ScriptRecordRef<any>>(query: ScriptTypeQuery<R>, opts?: { from?: number; label?: string; timeout?: undefined }): Promise<ScriptWaited<ScriptRecordData<R>>>;
  wait<R extends ScriptRecordRef<any>>(query: ScriptTypeQuery<R>, opts: { from?: number; label?: string; timeout?: Duration }): Promise<ScriptWaited<ScriptRecordData<R>> | TimedOut>;
  /** A type named as text: the data is of any shape. */
  wait(type: string, opts?: { filter?: Record<string, unknown>; from?: number; label?: string; timeout?: undefined }): Promise<ScriptWaited>;
  wait(type: string, opts: { filter?: Record<string, unknown>; from?: number; label?: string; timeout?: Duration }): Promise<ScriptWaited | TimedOut>;
  /** Sleep. The wake-up moment is recorded on the first pass: a replay does not sleep from the start. */
  sleep(duration: Duration, opts?: CallOptions): Promise<void>;
  /**
   * Ask the owner. Each kind gives a typed value: `choice` the id picked, `multi` the ids, `confirm` a boolean,
   * `text` a string, `form` what the zod schema parses. A cancel, or no answer within the timeout, throws
   * `AskCancelled` or `AskExpired`, which the script may catch.
   */
  ask: {
    choice<const O extends readonly AskOption[]>(text: string, options: O, opts?: AskCallOptions): Promise<AskOptionId<O[number]>>;
    multi<const O extends readonly AskOption[]>(text: string, options: O, opts?: AskCallOptions): Promise<AskOptionId<O[number]>[]>;
    confirm(text: string, opts?: AskCallOptions): Promise<boolean>;
    text(text: string, opts?: AskCallOptions): Promise<string>;
    form<S extends import("zod").z.ZodType>(text: string, schema: S, opts?: AskCallOptions): Promise<import("zod").z.output<S>>;
  };
  /** Declare a record the script writes: its name, under the script's own `wf.<name>.`, and the zod schema of its data. */
  record<S extends import("zod").z.ZodType>(name: string, schema: S): RecordDeclaration<S>;
  /** Write a record the script lists in `workflow({ emits })`: the data is held to the record's schema. */
  emit<S extends import("zod").z.ZodType>(record: RecordDeclaration<S>, data: import("zod").z.input<S>, opts?: CallOptions): Promise<void>;
  read: {
    /** The state of a plugin, as it was when the script read it. */
    state(plugin: string, opts?: CallOptions): Promise<any>;
    /**
     * The records of a referenced type that answer a query, and the position to read on from:
     * `{ records, next }`. A wait from `next` misses nothing written after the read.
     */
    records<R extends ScriptRecordRef<any>>(
      type: R,
      query?: ScriptReadOptions & { filter?: ScriptFilter<ScriptRecordData<R>> },
      opts?: CallOptions,
    ): Promise<{ records: Array<ScriptStoredRecord<ScriptRecordData<R>>>; next: number }>;
    /**
     * The records of a list of types: names as text, families written `prefix.*` or references. A list of references written
     * out (`[Ping, Pong]`, or the list a plugin's query builder gives) types the filter and the data of each record by its
     * type; any other list, one that may be empty or has a name as text, takes a filter on any field and gives data of unknown shape.
     */
    records<const T extends ReadonlyArray<string | ScriptRecordRef<any>> = readonly []>(
      query?: ScriptReadOptions & { types?: T; filter?: ScriptTypesFilter<T> },
      opts?: CallOptions,
    ): Promise<{ records: Array<ScriptTypesRecords<T>>; next: number }>;
  };
  /** Open a scope: a group of branches that never outlive it. */
  scope<T>(name: string, opts: (ScopeOptions & { deadline?: undefined }) | undefined, fn: (s: Scope) => Promise<T>): Promise<T>;
  /** With a deadline that fails, the scope gives its value or throws `DeadlineExceeded`. */
  scope<T>(name: string, opts: ScopeOptions & { deadline: Duration; onDeadline: "fail" }, fn: (s: Scope) => Promise<T>): Promise<T>;
  /** With a deadline that may skip (the default), the scope past it gives undefined. */
  scope<T>(name: string, opts: ScopeOptions | undefined, fn: (s: Scope) => Promise<T>): Promise<T | undefined>;
  scope<T>(name: string, fn: (s: Scope) => Promise<T>): Promise<T>;
  /** Branches at once, by the index of a list or the keys of an object; a branch that fails cancels the others. */
  parallel<T>(branches: Array<() => T | Promise<T>>, opts?: { concurrency?: number }): Promise<Awaited<T>[]>;
  parallel<B extends Record<string, () => unknown>>(branches: B, opts?: { concurrency?: number }): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
  stream<K extends string, T>(name: string, branches: Record<K, () => T | Promise<T>>, opts?: { concurrency?: number }): Stream<K, Awaited<T>>;
  /** The first branch to succeed, with its key; the others are cancelled. */
  race<K extends string, T>(name: string, branches: Record<K, () => T | Promise<T>>): Promise<{ key: K; value: Awaited<T> }>;
  /** The block for at most the duration: past it, undefined. */
  moveOnAfter<T>(name: string, duration: Duration, fn: () => Promise<T>): Promise<T | undefined>;
  /** The block for at most the duration: past it, `DeadlineExceeded` is thrown. */
  failAfter<T>(name: string, duration: Duration, fn: () => Promise<T>): Promise<T>;
  /** Stages one after another; each is given what the one before gave, awaited, and the call gives all of them. From two to four stages. */
  pipeline<A, B>(stages: [() => A, (previous: Awaited<A>) => B]): Promise<[Awaited<A>, Awaited<B>]>;
  pipeline<A, B, C>(stages: [() => A, (previous: Awaited<A>) => B, (previous: Awaited<B>) => C]): Promise<[Awaited<A>, Awaited<B>, Awaited<C>]>;
  pipeline<A, B, C, D>(
    stages: [() => A, (previous: Awaited<A>) => B, (previous: Awaited<B>) => C, (previous: Awaited<C>) => D],
  ): Promise<[Awaited<A>, Awaited<B>, Awaited<C>, Awaited<D>]>;
  /** Enter a phase the script declares in `workflow({ phases })`: the steps after it belong to it. */
  phase(title: string): void;
  /** A line of the run's output. */
  log(text: string): void;
  /** The clock of the host, recorded: a replay reads the same moment. */
  now(opts?: CallOptions): Promise<number>;
  /** A random number, recorded: a replay reads the same one. */
  random(opts?: CallOptions): Promise<number>;
}

/** How a branch ended: its value, or its error by name and message. A cancelled branch is named `Cancelled`. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } };

/** A branch of a scope: its key, its outcome, and its value, which throws what the branch threw. */
export interface ScopeBranch<R> {
  readonly key: string;
  settled(): Promise<Settled<R>>;
  value(): Promise<R>;
}

/** What a scope takes: how many branches run at once, what leaving it does, its deadline, and whether it is a shield. */
export interface ScopeOptions {
  concurrency?: number;
  /** Leaving the block normally waits for the branches left (the default) or cancels them. A block that throws cancels them. */
  onExit?: "wait" | "cancel";
  /** Past it the scope is cancelled; `onDeadline` says whether the call gives undefined or throws `DeadlineExceeded`. */
  deadline?: Duration;
  onDeadline?: "skip" | "fail";
  /** An outer cancel waits for the block to end; the owner can still stop it by force. */
  shield?: boolean;
}

/**
 * A group of branches of structured concurrency. Nothing started in it outlives it; the host keeps
 * its branches, their outcomes and the order they were committed in, so a replay reads them in the
 * order the script read them.
 */
export interface Scope {
  readonly path: string[];
  start<R>(key: string, fn: () => R | Promise<R>): ScopeBranch<Awaited<R>>;
  /** A branch that is a run of a registered workflow, a child of this run. */
  run<R = unknown>(key: string, child: { id: string; version?: string; args?: unknown }): ScopeBranch<R>;
  /** The next outcome after the ones read, or null when every branch ended and was read. */
  next(): Promise<{ key: string; result: Settled<unknown> } | null>;
  ready(): Promise<Array<{ key: string; result: Settled<unknown> }>>;
  rest(): Promise<Record<string, Settled<unknown>>>;
  pending(): Promise<string[]>;
  cancel(reason?: string, keys?: string[]): Promise<void>;
}

/** A stream of branches: their outcomes one at a time, in the order the host committed them. Closing it cancels the rest. */
export interface Stream<K extends string, T> extends AsyncIterable<{ key: K; result: Settled<T> }> {
  next(): Promise<{ key: K; result: Settled<T> } | null>;
  ready(): Promise<Array<{ key: K; result: Settled<T> }>>;
  rest(): Promise<Record<K, Settled<T>>>;
  pending(): Promise<K[]>;
  cancel(keys?: K[]): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** What `record(name, schema)` gives: a record a script lists in `workflow({ emits })` and writes with `emit`. */
export interface RecordDeclaration<S extends import("zod").z.ZodType = import("zod").z.ZodType> {
  readonly niwaRecord: true;
  readonly name: string;
  readonly schema: S;
}

/** `niwa.task` is a group, `niwa.task.create` an action: any depth, the name is the path. */
export interface ActionGroup {
  (input?: unknown, opts?: CallOptions): Promise<any>;
  [name: string]: any;
}
