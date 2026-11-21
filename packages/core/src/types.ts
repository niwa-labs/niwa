// Shared contracts of the core. Every core file implements against these types.
// Changing this file is a design decision, not an implementation detail.

import type { z } from "zod";

import type { JsonSchemaValue } from "./question.ts";
import type { PathFilter, ResolvedQuery } from "./record-query.ts";

/** Domain identifiers. Branded: a bare string is not accepted where one of these is expected. */
type Brand<T, B extends string> = T & { readonly __brand: B };
export type RecordId = Brand<string, "RecordId">;
export type Seq = Brand<number, "Seq">;
export type StreamId = Brand<string, "StreamId">;
export type RecordTypeName = Brand<string, "RecordTypeName">;
export type ActionName = Brand<string, "ActionName">;
export type PluginName = Brand<string, "PluginName">;
export type PluginVersion = Brand<string, "PluginVersion">;
/** `${pluginName}/${handlerName}` */
export type HandlerId = Brand<string, "HandlerId">;
/** `inv:${handlerId}:${recordId}` */
export type InvocationId = Brand<string, "InvocationId">;
/** Explicit key or the ordinal of key-less calls. */
export type StepKey = Brand<string, "StepKey">;
/** `${invocationId}/${stepKey}`; stable across repeats of the same step. */
export type OperationId = Brand<string, "OperationId">;
export type ClientId = Brand<string, "ClientId">;
/** The record that issued a grant: what a decision, a record and a child point back to. */
export type GrantId = Brand<string, "GrantId">;
/** What a rule names: exact, `group.*`, or `*`. */
export type Mask = Brand<string, "Mask">;
/** A short secret a connection shows in `hello` to say who it is. */
export type Token = Brand<string, "Token">;
/** What a principal is called: `owner`, a session's mark, a run id, a plugin name, a client label. */
export type PrincipalId = Brand<string, "PrincipalId">;
/** The HMAC of a token under the host's key: what the journal keeps instead of the token. */
export type TokenMac = Brand<string, "TokenMac">;
/** Milliseconds since epoch. */
export type Timestamp = Brand<number, "Timestamp">;

/** What kind of subject a principal is. */
export type PrincipalKind = "owner" | "session" | "run" | "plugin" | "client";

/** Who a connection is, as its token says: the host decides it, the client's label decides nothing. */
export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: PrincipalId;
}

/** What a rule is about: a call, an emitted record type, a harness tool, a directory, a host. */
export type Verb = "call" | "emit" | "tool" | "write" | "net";

/** One line of a grant: `verb:name[@target]`, and whether the owner is asked at the moment of the call. */
export interface Rule {
  readonly verb: Verb;
  readonly name: Mask;
  readonly target?: Mask;
  readonly ask: boolean;
}

/** A flat allow-list: what is not in it is forbidden. No deny, no order; the longest match wins. */
export interface Grant {
  readonly rules: readonly Rule[];
}

/**
 * Who did something. Bound by the runtime or the transport, never by a payload.
 *
 * A client carries the principal its token gave the connection and, when that token limits it,
 * the grant in force; a client with no principal is a plain `client` principal.
 */
export type Caller =
  | { kind: "host" }
  | { kind: "client"; id: ClientId; principal?: Principal; grant?: GrantId }
  | { kind: "handler"; handler: HandlerId; invocation: InvocationId };

/** A committed record as stored in the journal. */
export interface StoredRecord {
  id: RecordId;
  seq: Seq;
  stream: StreamId;
  type: RecordTypeName;
  schema: number;
  data: unknown;
  actor: Caller;
  cause: RecordId | null;
  root: RecordId;
  at: Timestamp;
}

/** What is passed to the journal to append. seq and at are assigned at commit. */
export interface NewRecord {
  id: RecordId;
  stream: StreamId;
  type: RecordTypeName;
  schema: number;
  data: unknown;
  actor: Caller;
  cause: RecordId | null;
  root: RecordId;
}

/** A declared record type: `record("ci.build-failed", schema)`. */
export interface RecordType<T> {
  kind: "record";
  name: RecordTypeName;
  version: number;
  schema: z.ZodType<T>;
  /** The plugin that produces the records of this type, so a missing one can be named. */
  provider?: string;
  /**
   * Any client may write this type over the wire. A type is closed by default: only the plugin
   * that declares it writes it.
   */
  open?: boolean;
}

/** A JSON Schema, as it travels: a plain document, never a class. */
export type JsonSchema = JsonSchemaValue;

/**
 * What wakes a wait, as the host indexes it: a field of the record data and the value that field
 * must have, taken from the wait's filter. It is recorded with the wait, so a restart rebuilds the
 * host's index of waiters from the journal. A record whose field differs is never the answer.
 */
export interface WaitKey {
  readonly field: string;
  readonly equals: string;
}

/**
 * What a wait is for: equality on paths of the data, and the position to look after. Without a
 * position the answer is a record committed after the wait began.
 */
export interface WaitQuery<T> {
  readonly filter?: PathFilter<T>;
  readonly from?: Seq;
}

/**
 * The answer of a wait: the data of the record, and its position. A wait that goes on from that
 * position finds the next record and misses none in between.
 */
export interface Waited<T> {
  readonly data: T;
  readonly at: Seq;
}

/** One of the types a wait for the first of several is for, with the filter on its data. */
export interface WaitEntry<T> {
  readonly type: RecordType<T>;
  readonly filter?: PathFilter<T>;
}

/**
 * The answer of a wait for the first of several record types: which type arrived, its data, and
 * its position.
 *
 * The type is a union of the types waited for, so the caller reads the data of the one it
 * expects without a cast, and the type of the answer tells it which one arrived.
 */
export type AnyWaited<Type extends RecordType<any>> = Type extends RecordType<any>
  ? {
      readonly type: Type["name"];
      readonly data: Type extends RecordType<infer Data> ? Data : never;
      readonly at: Seq;
    }
  : never;

/**
 * One action as niwa describes itself.
 *
 * The list of actions is the single source for the MCP tools, the CLI commands and this
 * description: the schemas here are the same schemas the
 * action is called with, rendered as JSON Schema.
 */
export interface ActionDescription {
  name: ActionName;
  /** What the action does, in a sentence: for agents and for the CLI. */
  description: string;
  /** What may be done after a call that was cut off: "repeat" | "repeat-with-key" | "do-not-repeat". */
  recovery: Recovery;
  /** The schema of the input, as JSON Schema. */
  input: JsonSchema;
  /** The schema of the output, as JSON Schema. */
  output: JsonSchema;
}

/** One record type as niwa describes itself. */
export interface RecordDescription {
  name: RecordTypeName;
  /** The version of this type's schema. */
  version: number;
  /** The schema of the data, as JSON Schema. */
  schema: JsonSchema;
}

/** What niwa is: its actions and its record types, with their schemas. */
export interface Description {
  actions: ActionDescription[];
  types: RecordDescription[];
}

/**
 * One live frame: something an interface needs at once and nobody needs later.
 *
 * A live frame is never a source of truth and nothing may depend on having received one.
 * The complete message is committed as a record when it is
 * complete; a frame that nobody received is simply lost.
 *
 * The shape of the payload belongs to whoever owns the channel; the frame itself carries the
 * channel it came from, so a consumer that listens to several channels can tell them apart.
 */
export interface LiveFrame<T = unknown> {
  /** The channel the frame was sent on. */
  channel: string;
  /** The payload of the frame. */
  data: T;
}

export type Recovery = "repeat" | "repeat-with-key" | "do-not-repeat";

export interface ActionContext {
  /** Stable across repeats of the same step. */
  operationId: OperationId;
  caller: Caller;
  /**
   * The invocation this call runs in, as a step of it. Absent for a call made outside an
   * invocation, which cannot wait: an action that waits for a record may answer at once instead.
   */
  invocation?: InvocationId;
  /**
   * The owner's answer that let this very call through at the door, when the call asked and was
   * answered. Absent for a call that did not ask, and for any call made inside an action.
   */
  answered?: AskScope;
  /**
   * Write a record of a type the action's own plugin declares.
   *
   * The runtime places the record: the actor is the caller, and the cause and the root come
   * from the invocation this call runs in; a call outside an invocation starts its own chain.
   * The id follows the operation, so a repeat of the same step returns the record it wrote.
   */
  emit<T>(type: RecordType<T>, data: T): Promise<StoredRecord>;
  /**
   * Wait for a record of a declared type, of its version, whose data holds the filter.
   *
   * The wait suspends the invocation the call runs in: it ends as "waiting", and it is
   * resumed when such a record arrives. The wait survives a restart, and it does not miss a
   * record that arrived while it was looking.
   *
   * The answer is looked for after `from` when it is given, and after the wait began when not;
   * it carries the record's position, to wait or read on from. A call outside an invocation
   * cannot wait: there is no invocation to suspend, so the answer is looked for and its absence
   * is reported.
   */
  wait<T>(type: RecordType<T>, query?: WaitQuery<NoInfer<T>>): Promise<Waited<T>>;
  /**
   * Wait for the first of several record types to arrive, each with its own filter.
   *
   * The answer carries the type, the data and the position of the record that arrived, so the
   * caller knows what happened without a cast.
   */
  waitAnyOf<Entries extends readonly WaitEntry<any>[]>(
    entries: Entries,
    opts?: { readonly from?: Seq },
  ): Promise<AnyWaited<Entries[number]["type"]>>;
  /**
   * Call another action as a step of this one.
   *
   * Inside an invocation the nested call is a step of the same invocation, under the key
   * `<stepKey>.step-N`: the intent, the outcome, the replay and the recovery contract are
   * those of a top-level step, and the call survives a restart. Outside an invocation there
   * is nothing to record it in, so it is a direct call with the same caller.
   *
   * The action may be given by value, by typed reference or by name. A reference is looked up by
   * its name, as a name is. A name nobody serves is a failed step.
   */
  step: ActionStep;
}

/**
 * The step function an action is given: it calls another action the way a handler does.
 *
 * It is the same contract as the handler's step, with one difference: the key of a nested
 * step belongs to the step that made it, so it never takes a number away from the steps of
 * the handler.
 */
export interface ActionStep {
  /**
   * Returns the value; any other outcome pauses the invocation.
   */
  <I, O, In = I>(action: ActionTarget<I, O, In>, input: NoInfer<In>): Promise<O>;
  /** Returns the outcome to the code instead of pausing. */
  outcome<I, O, In = I>(
    action: ActionTarget<I, O, In>,
    input: NoInfer<In>,
  ): Promise<Outcome<O>>;
}

/** What a check sees: it reads the outcome, it never writes. */
export type CheckContext = Omit<ActionContext, "emit" | "wait" | "waitAnyOf" | "step">;

/**
 * The client-side face of an action: its name and its two schemas, with nothing to run.
 *
 * A typed reference is what a caller holds to call an action it does not own: `niwa.call(ref,
 * input)` is checked by the type checker for the input and the output, on the host and on a
 * client. The module that serves the action builds its real action from the same reference
 * (`action(ref, { recovery, run })`), so the schemas on both sides are one value.
 *
 * `I` is what the schema produces and `In` is what it accepts: a caller passes what the schema
 * takes, not what it produces. A branded or transformed field — a `TaskId`, a `SessionRef`, a
 * prompt that becomes sections — is given as it is written down, and the schema does the rest.
 * `In` defaults to `I`, so a schema that takes what it produces needs no third parameter.
 */
export interface ActionRef<I, O, In = I> {
  name: ActionName;
  description: string;
  input: z.ZodType<I, In>;
  output: z.ZodType<O>;
  /**
   * The `@target` of a call: what a rule `name@target` of a grant is matched against, such as the
   * area of `rin.decide`. Absent for an action whose rules have no target.
   */
  target?(input: I): string | undefined;
}

/** What a call, a step or an adjustment accepts: a typed reference, an action, or a bare name. */
export type ActionTarget<I, O, In = I> = ActionRef<I, O, In> | ActionName;

/** A declared action: `action("telegram.send", { ... })`. It is a reference that also runs. */
export interface Action<I, O, In = I> extends ActionRef<I, O, In> {
  kind: "action";
  recovery: Recovery;
  run(input: I, ctx: ActionContext): Promise<O>;
  /**
   * What happened to a call that was cut off, asked by its operation id.
   *
   * It turns unknown into completed or failed. It is checking an outcome, not reattaching to
   * live work: the answer says whether the effect happened, not whether it is still running.
   */
  check?(operationId: OperationId, ctx: CheckContext): Promise<CheckResult<O>>;
}

/**
 * What a check says about a call that was cut off.
 *
 * "unknown" is the honest answer: the other side cannot say whether the effect happened.
 */
export type CheckResult<O> =
  | { status: "completed"; value: O }
  | { status: "failed"; error: string }
  | { status: "unknown" };

export type Outcome<O> =
  | { status: "completed"; value: O }
  | { status: "denied"; reason: string }
  | { status: "failed"; error: string; effectPossible: boolean }
  | { status: "unknown" };

export interface StepOptions {
  /** Explicit step key. Default: ordinal of the call inside the invocation ("1", "2", ...). */
  key?: string; // becomes a StepKey
  /** Why the step makes its call: shown to the owner when a rule asks about it. */
  reason?: string;
  /**
   * Make the call as this principal, not as the handler: the action sees a caller bound to it, so
   * what it trusts a handler for (an owner's word, a sender's address) it does not trust here. The
   * records of the step stay the handler's own. What the action calls inside itself is not made as
   * this principal: it is the action's own work.
   */
  as?: Principal;
}

/** What a caller may say with a call. */
export interface CallOptions {
  /** Why the caller makes this call: shown in the question when a rule of its grant asks. */
  reason?: string;
}

/** Options for writing a record that may be linked to other records. */
export interface EmitOptions {
  /**
   * An explicit id. The same id with the same content returns the existing record; the same id
   * with different content is an integrity error.
   */
  id?: string;
  /** Records this one depends on, apart from its cause: the other dependencies of a merge. */
  links?: RecordId[];
}

/** Options for a record written from inside a handler. */
export interface StepEmitOptions {
  /** Explicit key. Default: ordinal of the emits by this invocation ("1", "2", ...). */
  key?: string;
  /** Records this one depends on, apart from its cause. */
  links?: RecordId[];
}

/** The step function handed to a handler. */
export interface Step {
  /**
   * Returns the value; any other outcome pauses the invocation.
   *
   * The action may be given by value, by typed reference or by name; a reference is looked up by
   * its name, and only an action by value runs as it is. A name is the contract between two modules:
   * the module that owns the action checks the input and the answer, and the caller knows
   * neither. A name nobody serves is a failed step.
   */
  <I, O, In = I>(
    action: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    opts?: StepOptions,
  ): Promise<O>;
  /** Returns the outcome to the code instead of pausing. */
  outcome<I, O, In = I>(
    action: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    opts?: StepOptions,
  ): Promise<Outcome<O>>;
  /**
   * Waits for a record of `type`, of its version, whose data holds the filter: committed after
   * `from` when it is given, after this step's intent when not. The invocation is "waiting" until
   * then; the wait survives a restart, and a replay answers with the same record and position.
   */
  wait<T>(type: RecordType<T>, opts?: StepOptions & WaitQuery<NoInfer<T>>): Promise<Waited<T>>;
  /**
   * Write a record from inside the handler: the waking record is its cause, the root of the
   * waking record is its root, and the handler is its actor.
   *
   * The id is deterministic — `${invocation}/emit/${key}` — so a replay returns the record that
   * was written the first time instead of writing a second one.
   */
  emit<T>(type: RecordType<T>, data: T, opts?: StepEmitOptions): Promise<StoredRecord>;
  /**
   * Say that the work of this invocation is no longer wanted (the run it serves was cancelled).
   * A step that does not complete after that does not pause the invocation, and the step that
   * was in flight ends the invocation as done instead of leaving a decision nobody needs.
   */
  abandon(): void;
  /**
   * The clock, read as a step: the value is recorded, so a replay reads the same moment again.
   */
  now(opts?: StepOptions): Promise<number>;
  /**
   * A random number, read as a step: the value is recorded, so a replay reads the same one again.
   */
  random(opts?: StepOptions): Promise<number>;
}

/** What an owner can decide about a paused invocation. */
export type PauseChoice = "retry" | "skip" | "cancel";

/** The choices a paused invocation offers. */
export const PAUSE_CHOICES: readonly PauseChoice[] = ["retry", "skip", "cancel"];

export type Handler<T> = (data: T, step: Step, record: StoredRecord) => Promise<void> | void;

/** What a call carries when its caller is held to the grant: the input the question shows, and why. */
export interface AuthorizeHow {
  readonly input?: unknown;
  readonly reason?: string;
}

/** What the owner may answer to a question of a grant. */
export const ASK_SCOPES = ["once", "run", "always"] as const;

/** `once`: this call. `run`: this action for the subject's lifetime. `always`: written into its grant. */
export type AskScope = (typeof ASK_SCOPES)[number];

/** What a question to the owner comes to: an answer that lets the call through, or none that does. */
export type AskOutcome = AskScope | "refused" | "unanswered";

/** One call that waits for the owner's answer: who, what, with which input, and the caller's reason. */
export interface AskQuestion {
  readonly principal: Principal;
  readonly grant: GrantId;
  /** The action called. */
  readonly name: string;
  /** The `@target` of the call, when the action has one. */
  readonly target?: string;
  /** The rule that asks, as the grant states it. */
  readonly rule: string;
  readonly input: unknown;
  /** Why the caller says it needs this, when it said. */
  readonly reason?: string;
}

/** Ask the owner about a call and wait: the host answers from the answers in force, or by a request. */
export type Ask = (question: AskQuestion) => Promise<AskOutcome>;

/**
 * What a plugin gives the host to put a question to the owner (`PluginApi.asker`): the requests
 * module. `now` is the clock of the host, for a deadline. It never rejects: no owner to ask is "unanswered".
 */
export type Asker = (question: AskQuestion, now: Timestamp) => Promise<AskOutcome>;

/** A refusal: what a guard returns to stop a call, and the reason it is recorded with. */
export interface Denial {
  readonly kind: "denial";
  /** Why the call was refused. It is recorded with the decision. */
  readonly reason: string;
}

/** What an intercept sees: the caller of the call, and the action it is about. */
export interface InterceptContext {
  /** Who is calling. Bound by the runtime or the transport, never by a payload. */
  readonly caller: Caller;
  /** The action being called. */
  readonly action: ActionName;
  /**
   * The step function of the invocation that is calling the action.
   *
   * An intercept that itself needs a call to the outside makes it as a step of that invocation: the call is recorded, and a replay answers with what was
   * recorded. The keys of the steps it makes are namespaced under the intercepted step, so they
   * are not the steps of the handler and not the steps of another intercept.
   *
   * Absent when the call is made outside an invocation: there is no invocation to make a step of.
   */
  readonly step?: Step;
}

/**
 * An adjust: it receives the input and may return a changed one.
 *
 * Returning nothing leaves the input as it was. The returned input is validated again, so an
 * adjust cannot smuggle in something the action would refuse.
 */
export type AdjustFn<I> = (
  input: I,
  ctx: InterceptContext,
) => I | undefined | Promise<I | undefined>;

/**
 * A guard: it receives the final input and may deny the call.
 *
 * Returning nothing allows the call. One denial is enough: the first guard that denies stops the
 * rest.
 */
export type GuardFn<I> = (
  input: I,
  ctx: InterceptContext,
) => void | Denial | Promise<void | Denial>;

export type InvocationState = "admitted" | "running" | "waiting" | "done" | "paused";

/** Subscription filter for observation. */
export interface RecordFilter {
  type?: RecordType<any> | RecordTypeName;
  /** The stream to observe; every stream when absent. */
  stream?: StreamId;
}

/** What a one-shot read of the history asks for. */
export interface ReadOptions extends RecordFilter {
  /** The record types to read; every type when absent. */
  types?: readonly (RecordType<any> | RecordTypeName)[];
  /** At most this many records, a positive integer. Every record that is committed when absent. */
  limit?: number;
}

/** A record in a trace: the record, and how far down from the start it is. */
export interface TracedRecord extends StoredRecord {
  /** 0 for the record the trace started from, 1 for what it grew into, and so on. */
  depth: number;
}

/** Query over the journal: records of one type, optionally with data[field] === equals, after a position. */
export interface JournalQuery {
  type: RecordTypeName;
  field?: string;
  equals?: string | number;
  after?: Seq;
}

/** A record to append, with the links it declares. */
export interface AppendEntry {
  record: NewRecord;
  /** Records this one depends on, apart from its cause. */
  links?: RecordId[];
}

/** What a plugin may read of the journal. */
export interface JournalReader {
  get(id: RecordId): StoredRecord | undefined;
  /** Records with seq > from, ascending; optionally only these types, optionally at most `limit`. */
  since(from: Seq, types?: RecordTypeName[], limit?: number, stream?: StreamId): StoredRecord[];
  find(q: JournalQuery): StoredRecord[];
  /** The records that answer a query, in commit order; at most `limit` of them when it is given. */
  query(q: ResolvedQuery, limit?: number): StoredRecord[];
  /** Highest committed seq, 0 when empty. */
  last(): Seq;
}

/** The journal: one SQLite file, one writer. Synchronous; every method is one transaction. */
export interface Journal extends JournalReader {
  /** Random id of this writer, recorded in the database when the journal was opened. */
  readonly instance: string;
  /** Idempotent by id: same content returns the existing record, different content throws IntegrityError. */
  append(rec: NewRecord): StoredRecord;
  /** All or nothing, in one transaction. */
  appendMany(recs: NewRecord[]): StoredRecord[];
  /** All or nothing, in one transaction, each record with the links it declares. */
  appendAll(entries: AppendEntry[]): StoredRecord[];
  /** The records a record depends on, apart from its cause. */
  linksOf(id: RecordId): RecordId[];
  /** The records that grew from a record: what it caused, and what depends on it through a link. */
  dependentsOf(id: RecordId): RecordId[];
  close(): void;
}

/** Built-in record type names written by the core itself. */
export const CORE = {
  invocationAdmitted: "niwa.invocation.admitted", // { invocation, handler, record, pluginVersion }
  invocationState: "niwa.invocation.state",       // { invocation, state, reason?, choices?, key? }
  invocationResolved: "niwa.invocation.resolved", // { invocation, key, choice }
  invocationMoved: "niwa.invocation.moved",       // { invocation, from, to }
  stepDecision: "niwa.step.decision",             // { invocation, key, attempt, requested, final, denied, reason? }
  stepIntent: "niwa.step.intent",                 // { invocation, key, action, input, operationId }
  stepOutcome: "niwa.step.outcome",               // { invocation, key, outcome }
  stateChanged: "niwa.state.changed",             // { plugin, name, op, value }
  stateRead: "niwa.state.read",                   // { plugin, name, op, value }
  accessIssued: "niwa.access.issued",             // { mac, principal }
  accessGranted: "niwa.access.granted",           // { principal, rules, parent? }
  accessClosed: "niwa.access.closed",             // { grant, principal, reason }
  accessDecided: "niwa.access.decided",           // { principal, verb, name, grant, outcome, rule?, reason?, missing? }
  accessProfile: "niwa.access.profile",           // { name, rules }
  accessSwitched: "niwa.access.switched",         // { all }
  accessAnswered: "niwa.access.answered",         // { grant, principal, name, target?, scope, request? }
  pluginInstalled: "niwa.plugin.installed",       // { plugin, version, module, hash }
  subscriptionPosition: "niwa.subscription.position", // { subscription, seq, reason }
} as const;
