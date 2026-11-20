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
  /** Run the session in a new git worktree; removed at the end when clean with no new commit, else the answer carries `worktree`. */
  worktree?: true | { repo?: string; base?: string; description?: string };
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
  agent<S extends import("zod").z.ZodType>(
    prompt: string,
    opts: AgentCallOptions & { schema: S; worktree: NonNullable<AgentCallOptions["worktree"]> },
  ): Promise<import("zod").z.output<S> & { worktree?: AgentWorktree }>;
  agent(prompt: string, opts: AgentCallOptions & { worktree: NonNullable<AgentCallOptions["worktree"]> }): Promise<{ answer: string; worktree?: AgentWorktree }>;
  agent<S extends import("zod").z.ZodType>(prompt: string, opts: AgentCallOptions & { schema: S }): Promise<import("zod").z.output<S>>;
  agent(prompt: string, opts?: AgentCallOptions): Promise<{ answer: string }>;
  /**
   * The data of the first record of a type that holds every field of `filter`, or `{ timedOut: true }`.
   * Without a `timeout` it waits for ever; the wait survives a restart of the host.
   */
  wait(type: string, opts?: { filter?: Record<string, unknown>; timeout?: Duration; label?: string }): Promise<any>;
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
    /** The records of the journal: `{ from, types, stream, limit }`. */
    records(query?: Record<string, unknown>, opts?: CallOptions): Promise<any>;
  };
  /** The clock of the host, recorded: a replay reads the same moment. */
  now(opts?: CallOptions): Promise<number>;
  /** A random number, recorded: a replay reads the same one. */
  random(opts?: CallOptions): Promise<number>;
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
