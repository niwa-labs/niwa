// The contracts of a plugin: what a plugin is given and what it hands over.
import type { z } from "zod";
import type { SEAL_VERSION } from "./plugin.ts";
import type { Subscribable } from "./trigger.ts";

import type {
  Action,
  ArtifactStore,
  ActionRef,
  Effect,
  AdjustFn,
  Ask,
  Asker,
  AuthorizeHow,
  Caller,
  EmitOptions,
  EmitBatch,
  Grant,
  GuardFn,
  Handler,
  JournalReader,
  LiveFrame,
  PluginName,
  PluginVersion,
  RecordType,
  SecretStore,
  StoredRecord,
  Timestamp,
  Token,
  Verb,
  Narrowed,
  RecordQuery,
  PathFilter,
  RuleSpec,
} from "@niwa-labs/core";

/**
 * Where a new subscription starts: `"now"`, the position of the journal when it is installed, or
 * `"start"`, the beginning of the journal. A subscription that was installed before goes on from
 * the position it reached, whatever this says.
 */
export type SubscriptionStart = "now" | "start";

/** How deep a subscription may wake on records its own invocations caused. */
export interface Reentry {
  /** How many of its own invocations may stand on the chain of causes of a record that wakes it. */
  readonly depth: number;
}

export interface HandlerOptions<T = unknown> {
  /** Handler name inside the plugin. Default: the record type name. */
  id?: string;
  /**
   * Equality on fields of the data, by field name or dotted path: only records whose data holds
   * every field wake the handler. What equality cannot say, the handler checks itself.
   */
  filter?: PathFilter<T>;
  /** Where the subscription starts when it is new. Default: `"now"`. */
  from?: SubscriptionStart;
  /**
   * How many records of the subscription run at once. Default: 1, one after the other: the next
   * record starts when the one before it is done, and a record that waits or is paused holds the
   * ones after it. `Infinity` lets every record run as soon as it is admitted.
   */
  concurrency?: number;
  /**
   * A subscription is not woken by a record its own invocations caused. A reentrant one is, down to
   * the depth it gives; past it the record is passed over and the host says so.
   */
  reentrant?: Reentry;
  /**
   * The record types this handler needs another plugin to declare, because the work it does
   * writes or waits for them (a durable sleep needs the timers). The host refuses to serve when
   * one of them is declared by nobody: the handler would fail or wait for ever. Name the plugin
   * that produces a type in its `provider`, so the refusal can say what to install.
   */
  requires?: readonly RecordType<any>[];
}

/**
 * A query a subscription is woken by: the one query of the core, without a position of its own. A
 * query value that does carry a `from` is refused by the host when it reads the subscriber.
 */
export type SubscriberQuery = Omit<RecordQuery<any>, "from">;

/**
 * A subscription a plugin reads from the journal: its own records are data, not code registered at
 * setup. Its id, with the plugin's name, is its identity: its position and its own chain of causes.
 */
export interface Subscriber {
  /** Its name inside the plugin; it has no "/". */
  readonly id: string;
  /**
   * The records it is woken by: a record that answers any of the queries, each the query of the core
   * (types as names or families, equality on paths of their data, the stream). The position it
   * reads after is `from` below, never the query's own.
   */
  readonly queries: ReadonlyArray<SubscriberQuery>;
  /** The position it starts after when it is new: where it was made. */
  readonly from: number;
  /** The position after which it admits nothing: where it ended. */
  readonly until?: number;
  /** How many of its records run at once. Default 1. */
  readonly concurrency?: number;
  readonly handler: Handler<unknown>;
}

/**
 * The state of one plugin: values by key, owned by that plugin.
 *
 * A change is one named operation, not a read followed later by a write, so two handlers cannot
 * lose each other's updates. Inside an invocation a read is recorded: on a replay it returns
 * what was read the first time, so code never sees today's state while it is continuing
 * yesterday's computation.
 */
export interface StateHandle<T> {
  /** The name of this key inside its plugin. */
  readonly name: string;
  /** The current value. Inside an invocation this is a recorded read. */
  get(): T;
  /** Replace the value. This is one committed change. */
  set(value: T): T;
  /**
   * Change the value with a function of the current one.
   *
   * The function runs against the value as it is at this moment and the change is committed in
   * the same turn, so a concurrent update cannot be lost between the two.
   */
  update(fn: (current: T) => T): T;
  /**
   * Return the current value and reset it to the initial one, in one committed change.
   *
   * A task that finishes while the batch is taken lands in the next batch, not in a hole. After a
   * crash and a restart the same invocation takes the same batch again.
   */
  take(): T;
}

/**
 * What a service is given when it starts.
 *
 * A service is work the host runs for as long as it serves: a scheduler, a poller, a ticker.
 * It is not a handler and not an invocation: nothing wakes it, and it has no step.
 */
export interface ServiceContext {
  /**
   * Write an external input: it starts its own chain (root = its own id, cause = null).
   *
   * Only a type the plugin declared is accepted. With an explicit id the write is idempotent:
   * the same id with the same content returns the record that is already committed.
   */
  emit<T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord>;
  emitAll<const T extends readonly RecordType<any>[]>(entries: EmitBatch<T, EmitOptions>): Promise<StoredRecord[]>;
  /** The clock, in milliseconds since the epoch. */
  now(): Timestamp;
  /**
   * Run `fn` at the moment `at`, in milliseconds since the epoch.
   *
   * The returned function cancels it: a moment that will not come must not fire. The moment is
   * read from the clock of the host, so a test may move the time of the host instead of waiting.
   */
  schedule(at: number, fn: () => void | Promise<void>): () => void;
}

/**
 * A service: work the host runs while it serves.
 *
 * It returns the function that stops it. The host calls that when the host closes or when the
 * plugin is unloaded, and waits for it when it is a promise: what the service owns must be
 * released before the host is gone.
 */
export type Service = (ctx: ServiceContext) => () => void | Promise<void>;

/**
 * A point where plugins offer something to another plugin that reads it: the built-in workflows a
 * plugin ships go to the workflow module, the timers it needs to the timers. Offers are matched by
 * the name of the key, as actions are by theirs, so the offering plugin need not import the reader.
 *
 * `reader` is the plugin that reads the point: a host where a plugin offers to a reader that is not
 * installed refuses to serve, as it does for a trigger nobody declares.
 */
export interface OfferKey<T> {
  readonly kind: "offer";
  readonly name: string;
  readonly reader: string;
  /** The type of what is offered; never set, only carried. */
  readonly _value?: T;
}

/** One offer, with the plugin that made it: the host says who offered, the offer does not. */
export interface Offered<T> {
  readonly plugin: PluginName;
  readonly value: T;
}

/** What a plugin needs the host to serve: see `PluginApi.needs`. */
export interface PluginNeeds {
  /** Actions the plugin calls, by reference or by name. */
  readonly actions?: ReadonlyArray<ActionRef<any, any, any> | string>;
  /** Record types the plugin writes or waits for, by declaration or by name. */
  readonly types?: ReadonlyArray<RecordType<any> | string>;
}

/** What a plugin's setup function receives. */
export interface PluginApi {
  /** Declare record types this plugin writes or handles. */
  declare(...types: RecordType<any>[]): void;
  /** Offer a value at a point another plugin reads (`OfferKey`): the host records which plugin offered it. */
  offer<T>(key: OfferKey<T>, value: T): void;
  /**
   * What the plugins offer at a point, in the order they were installed, with who offered each.
   *
   * Read in the setup, it holds the offers of the plugins installed before this one and its own,
   * as `recordType` does, and a plugin installed later that offers there is refused: install it
   * first. Read later (a service, an action), it holds the offers of every installed plugin.
   */
  offers<T>(key: OfferKey<T>): Offered<T>[];
  /**
   * Run work for as long as the host serves.
   *
   * The service starts when the host starts serving, and stops when the host closes or the
   * plugin is unloaded. What it writes through `ctx.emit` starts its own chain: a service is
   * not inside an invocation, so it has no cause to give it.
   */
  service(start: Service): void;
  /** Register an action callable by name from handlers and clients. */
  action(a: Action<any, any>): void;
  /**
   * Actions that grow from the journal: read at every lookup and every description, so an action a
   * record made is served from the moment it is committed. A declared action of the same name wins.
   */
  catalog(read: () => readonly Action<any, any>[]): void;
  /**
   * Run before an action and may change its input. The intercept is kept by the action's name,
   * so a typed reference is enough: a plugin need not hold the action it adjusts.
   *
   * The intercept sees the parsed input, `I`, not what a caller may write down (`In`): it runs
   * after the schema, so a branded field is branded here.
   */
  adjust<I, In = I>(action: ActionRef<I, any, In>, fn: AdjustFn<NoInfer<I>>): void;
  /** Run before an action and may deny it. Like `adjust`, a typed reference is enough. */
  guard<I, In = I>(action: ActionRef<I, any, In>, fn: GuardFn<NoInfer<I>>): void;
  /**
   * Send a live frame on a channel.
   *
   * A frame is not a record: it is never written to the journal, and a subscriber that is not
   * connected misses it. Nothing may depend on having received
   * a frame; the complete message is committed as a record when it is complete.
   */
  live(channel: string, frame: LiveFrame): void;
  /**
   * Handle the records of a type, or of a trigger over one (`timer.daily("21:00")`): one invocation
   * for each record, admitted once. See `HandlerOptions` for where it starts, what it lets through
   * and how many run at once.
   */
  on<T>(source: Subscribable<T>, handler: Handler<T>): void;
  on<T>(source: Subscribable<T>, opts: HandlerOptions<NoInfer<T>>, handler: Handler<T>): void;
  /**
   * Subscriptions that grow from the journal, as `catalog` is for actions: read at every look for new
   * work, each served like a handler of this plugin under its own id. An installed workflow is one.
   */
  subscribers(read: () => readonly Subscriber[]): void;
  /**
   * Declare a value of this plugin's state.
   *
   * The value belongs to the plugin and only the plugin writes it. Every change is a record, so
   * who changed a value and why is visible without a separate history feature.
   */
  state<T>(name: string, schema: z.ZodType<T>, initial: T): StateHandle<T>;
  /**
   * A few counts of what this plugin holds now (runs by state, open requests), which
   * `niwa.host.status` shows. Read when asked, from the journal or the state the plugin keeps.
   */
  summarize(read: () => Record<string, number>): void;
  /**
   * What this plugin needs the host to serve besides its own registrations: actions it calls and
   * record types it writes or waits for, whoever declares them (`request.ask` of the requests
   * plugin, `timer.fired` of the timers). The host refuses to serve when one is missing and says which
   * plugin needs it. Actions are the ones plugins declare; an action a catalog reads from the journal
   * cannot be needed. May be called more than once: the needs add up.
   */
  needs(needs: PluginNeeds): void;
  /**
   * The record type of this name, when this plugin or one installed before it declares it.
   *
   * For a plugin that is given a type by name: the plugin that declares the type is installed first.
   */
  recordType(name: string): RecordType<any> | undefined;
  /**
   * The journal, when the host is serving.
   *
   * A plugin that builds a read model of what the journal holds needs to read it. It is a
   * function, not a value, because the journal opens when the host starts serving — after the
   * plugin is installed. The answer is undefined before that, and after the host closes, and
   * the plugin must say so rather than call an empty journal empty.
   */
  journal?: () => JournalReader | undefined;
  /**
   * Wait until a record is committed, or `ms` milliseconds have passed: for a read that blocks until
   * something happens. The caller looks again after it; a commit may be a record it does not want.
   */
  untilCommit(ms: number): Promise<void>;
  /**
   * The path of the unix socket this host serves on, with the links of its home resolved: the name a
   * sandbox that works by path matches, and where a process that talks to the host connects. The home
   * exists once the host serves.
   */
  socket(): string;
  /** The home of this host, with the links resolved: where `owner.token` and `host.key` are. */
  home(): string;
  /**
   * The artifacts of this host: data too large for a record (`ARTIFACT_THRESHOLD`), kept whole by its
   * digest and durable before the reference to it is returned. A record holds the reference.
   */
  readonly artifacts: ArtifactStore;
  /** The secrets of the host's owner, resolved by name where they are used. A record holds `secret("name")`. */
  readonly secrets: SecretStore;
  /**
   * Write a record of one of this plugin's own types, from work the plugin runs by itself.
   *
   * An action writes through its own `emit`. This is for what has no calling action — a sign of
   * life that arrives from a harness long after the action that started it returned. Only a type
   * the plugin declared is accepted; the runtime sets the actor (the host) and starts a chain of
   * its own. It fails when the host is not serving.
   *
   * With an explicit id the write is idempotent: the same id with the same content returns the
   * record that is already committed, and the same id with different content is an integrity
   * error. That is what a fact that may arrive twice needs — an update from Telegram, say.
   */
  emit<T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord>;
  emitAll<const T extends readonly RecordType<any>[]>(entries: EmitBatch<T, EmitOptions>): Promise<StoredRecord[]>;
  /**
   * Make a token for a subject this plugin starts: a session or a run. Nothing else — the owner
   * and the plugins are the host's to make. The token is the only time the secret is seen; the
   * journal keeps its HMAC. `grant` is what the subject may do, as `narrow` computed it from the
   * rights of `parent`, who started it.
   */
  issueToken(kind: "session" | "run", id: string, opts: { grant: Grant; parent: Caller }): Token;
  /**
   * The rights of a subject started at `caller`'s request: what `caller` has, narrowed to what was
   * asked for, or the masks that were asked for and are not its own. A caller that nothing
   * limits (the host, a plugin, a handler) is given what it asks.
   */
  narrow(caller: Caller, requested: readonly RuleSpec[]): Narrowed;
  /**
   * What `caller` may do: its grant, or `"unlimited"` when nothing limits it. A caller
   * whose grant was closed, or that the emergency switch stopped, has a grant with no rules.
   * Ask it with `match` from the grant of niwa to know whether a name may be called.
   */
  rights(caller: Caller): Grant | "unlimited";
  /**
   * The effect class of an action the host serves, by its name; undefined for a name nothing
   * serves. What a plugin that narrows rules by itself needs: a mask never grants an
   * irreversible action, so a narrowing is told which names are.
   */
  effectOf(name: string): Effect | undefined;
  /**
   * Hold `caller` to its grant for one `verb` on one `name`, as `decide()` does for a call: the
   * decision of a subject a grant limits is recorded, and a refusal is a `DeniedError` that carries
   * `{ grant, missing }`. A caller that nothing limits is let through. A plugin that acts for a
   * subject of its own (a workflow run) asks it before each thing the subject does. A call that meets
   * a rule that asks puts the question to the owner exactly as a call at the door does, with the
   * `input` and the `reason` of the call; an emit or a read under such a rule is a denial.
   */
  authorize(caller: Caller, verb: Verb, name: string, how?: AuthorizeHow): Promise<void>;
  /**
   * A named grant with no holder, for what this plugin owns: the value the profile has until
   * the owner sets one. It is read when a subject is born, so it may follow state that changes.
   */
  profile(name: string, rules: () => readonly RuleSpec[]): void;
  /**
   * Put the question of an `ask` rule to the owner: what the host calls when a call meets a
   * rule that asks and no answer is in force. A host without one denies such a call.
   */
  asker(ask: Asker): void;
  /**
   * Set a profile this plugin declared with `profile`. The owner's own `access.profile.set`
   * is not open to a plugin; this one is limited to what the plugin owns.
   */
  setProfile(name: string, rules: readonly RuleSpec[], by: Caller): Grant;
}

export interface Plugin {
  kind: "plugin";
  name: PluginName;
  /** Explicit version or a hash of the setup function's source. */
  version: PluginVersion;
  setup(api: PluginApi): void;
  /** Finishes the default version once the setup has run (`sealVersion`); absent when explicit. */
  readonly [SEAL_VERSION]?: (handlers: readonly string[]) => void;
}
