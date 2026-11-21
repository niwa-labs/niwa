// The host: the one process that owns the journal and runs the plugins.
//
// The rules this file keeps:
// - one writer: the journal is opened once, and only here;
// - append first, publish after: nobody sees a record before it is committed;
// - delivery is at-least-once: the identity of an invocation is deterministic, so admitting it
//   twice is harmless;
// - an invocation is pinned to the version of the plugin it was admitted on: work in
//   flight finishes on its own code;
// - a client is named by the host from the connection, never by what it sends.

import { chmodSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { z } from "zod";

import {
  action,
  actionName,
  realClock,
  IntegrityError,
  PluginInstallFailed,
  CatchableError,
  LostOwnership,
  MissingProvider,
  MissingReader,
  UnknownAction,
  UnknownType,
  ValidationError,
  WriterBusy,
  causes,
  trace,
  DeniedError,
  WAIT_ACTION,
  offeredChoices,
  OWNER,
  OWNER_TOKEN_FILE,
  principalOf,
  MOVE_ACTION,
  RESOLVE_ACTION,
  attemptRecordId,
  attemptsOf,
  resolveId,
  shortInvocation,
  CORE_TYPES,
  newId,
  newRecordId,
  recordId,
  recordTypeName,
  seq,
  streamId,
  timestamp,
  readFiltered,
  targetName,
  holds,
  matchesQuery,
  overlaps,
  resolveQuery,
  selectsType,
} from "@niwa-labs/core";
import type {
  Clock,
  DeniedDetails,
  Found,
  ActionRef,
  ActionTarget,
  Action,
  ActionName,
  ActionStep,
  Ask,
  AskOutcome,
  AuthorizeHow,
  Asker,
  CallOptions,
  Grant,
  AdjustFn,
  AnyWaited,
  AppendEntry,
  Caller,
  ClientId,
  Description,
  EmitOptions,
  GuardFn,
  Handler,
  HandlerId,
  InvocationId,
  Journal,
  LiveFrame,
  NewRecord,
  OperationId,
  Outcome,
  PluginName,
  PluginVersion,
  Principal,
  RecordId,
  RecordType,
  RecordTypeName,
  Seq,
  StreamId,
  Timestamp,
  StepKey,
  StoredRecord,
  Token,
  TracedRecord,
  Verb,
  RecordReadQuery,
  RecordQuery,
  ResolvedQuery,
  WaitEntry,
  WaitKey,
  WaitQuery,
  Waited,
} from "@niwa-labs/core";
import { describe as buildDescription } from "./describe.ts";
import {
  NO_INTERCEPTS,
  decide,
  newIntercepts,
  permit,
  settleAsk,
  admits,
  findWaited,
  invocationId,
  runInvocation,
  stepKey,
  openJournal,
} from "@niwa-labs/core/journal";
import type { Intercepts, Permit, Placement, RunnerDeps } from "@niwa-labs/core/journal";
import { Doors, loadHostKey } from "./doors.ts";
import {
  readOwnerToken,
  LiveBus,
  LiveFeed,
  channelName,
  frameFor,
  decodeClientMessage,
  encode,
  lineDecoder,
  requestIdOf,
  socketPath,
  CAUSES_ACTION,
  DESCRIBE_ACTION,
  RECORDS_READ_ACTION,
  CATALOG_ACTION,
  CatalogOutput,
  RECORDS_SEARCH_ACTION,
  STATUS_ACTION,
  STOP_ACTION,
  StatusOutput,
  TRACE_ACTION,
  DescriptionOutput,
  RecordWalkInput,
  RecordList,
  RecordsOutput,
  RecordsReadInput,
  RecordsSearchInput,
  TracedRecordsOutput,
} from "@niwa-labs/client";
import { AccessControl } from "./access-control.ts";
import { accessActions } from "./access-actions.ts";
import { installationOf, pluginInstallAction, removeCopyIfStale, removeStaleCopies } from "./plugin-install.ts";
import { COCKPIT_MODULE, handlerSource, pluginVersion, pluginName, sealVersion } from "@niwa-labs/plugin";
import { catalogOf } from "./cockpit-catalog.ts";
import { StateStore } from "./state.ts";
import type { HostMessage } from "@niwa-labs/client";
import { isTrigger } from "@niwa-labs/plugin";
import type { OfferKey, Offered, HandlerOptions, Plugin, Service, ServiceContext, StateHandle, Subscribable, Subscriber, SubscriptionStart } from "@niwa-labs/plugin";
import type { Host, HostOptions } from "./host-types.ts";

/** The reader of an offer point that the host itself reads. */
const HOST_READER = "host";

type AnyType = RecordType<any>;
type AnyAction = Action<any, any>;

// The brand constructors this file needs: each name is built here from parts that are valid.

function handlerIdOf(value: string): HandlerId {
  return value as HandlerId;
}

function clientIdOf(value: string): ClientId {
  return value as ClientId;
}

function newOperationId(): OperationId {
  return newId("op") as OperationId;
}

/** The pseudo-key of a pause that is not about a step. */
const NO_STEP = "" as StepKey;

/**
 * The clock of the transport: the real time.
 *
 * The probe of the socket is about the transport, not about the domain time of the host, so it
 * waits on the real clock and not on the clock of the host: a host whose clock is moved by hand
 * must not hang its own start.
 */
const TRANSPORT_CLOCK: Clock = realClock();

/**
 * What a call outside an invocation ended with.
 *
 * A call that was denied, or whose input or output did not fit, ends here and not with an
 * exception: `step.outcome` asks for the outcome, and the code that asked decides what to do
 * with it.
 */
type OutsideCall<O> =
  | { kind: "completed"; value: O }
  | { kind: "unknown-action"; action: ActionName }
  | { kind: "denied"; reason: string; denied?: DeniedDetails }
  | { kind: "invalid-input"; message: string; issues: unknown }
  | { kind: "invalid-output"; message: string; issues: unknown };

/** The records the table of the doors is folded from. */
const ACCESS_TYPES = new Set<string>([
  CORE_TYPES.accessIssued,
  CORE_TYPES.accessGranted,
  CORE_TYPES.accessClosed,
  CORE_TYPES.accessProfile,
  CORE_TYPES.accessSwitched,
  CORE_TYPES.accessAnswered,
]);

/** The types the core writes itself: nothing outside writes them. */
const CORE_TYPE_NAMES = new Set<string>(Object.values(CORE_TYPES));

/** What the core wrote into an admitted record that the host reads back. */
const AdmittedData = z.object({
  handler: z.string().includes("/"),
  record: z.string(),
  pluginVersion: z.string().min(1),
});
const AdmittedWithPosition = AdmittedData.extend({ recordSeq: z.number(), recordType: z.string() });
const PositionData = z.object({ subscription: z.string(), seq: z.number().int().nonnegative(), reason: z.string() });

/** Why a subscription's position moved past records without admitting them. */
type PassReason = "installed" | "filtered" | "schema" | "self" | "reentry";
const StateData = z.object({
  invocation: z.string(),
  state: z.string(),
  key: z.string().optional(),
  choices: z.array(z.string()).optional(),
});
const MovedData = z.object({ to: z.string().min(1) });
const IntentData = z.object({
  invocation: z.string().optional(),
  key: z.string().optional(),
  action: z.string(),
  input: z
    .object({
      type: z.string().optional(),
      types: z.array(z.string()).optional(),
      // A key that does not parse is no key: the wait is indexed by its type alone, which wakes
      // it for more records than it needs but never for fewer. Failing the whole intent instead
      // would drop the wait from the index and lose its wake.
      key: z.object({ field: z.string(), equals: z.string() }).optional().catch(undefined),
    })
    .optional(),
});

/** What a handler says about the records it subscribes to, checked when it is registered. */
interface Subscribing {
  /** Equality on paths of the data: records that do not hold it advance the position and wake nothing. */
  readonly filter: Readonly<Record<string, unknown>> | undefined;
  /** Where a new subscription starts: now, the start, or the position a subscriber from the journal gives. */
  readonly from: SubscriptionStart | Seq;
  /** How many of its invocations may be unfinished at once. */
  readonly concurrency: number;
  /** How many of its own invocations may stand on the chain of a record that wakes it; 0 when none may. */
  readonly depth: number;
}

/** The subscribing of a handler that says nothing: from now, one at a time, never its own records. */
const SUBSCRIBING: Subscribing = { filter: undefined, from: "now", concurrency: 1, depth: 0 };

/** The options of a handler as the host keeps them, refused when they cannot be served. */
function subscribingOf(where: string, options: HandlerOptions<any>): Subscribing {
  const concurrency = options.concurrency ?? 1;
  if (!(concurrency === Number.POSITIVE_INFINITY || (Number.isInteger(concurrency) && concurrency >= 1))) {
    throw new TypeError(`${where}: concurrency is a whole number from 1 or Infinity, not ${String(concurrency)}`);
  }
  const depth = options.reentrant?.depth ?? 0;
  if (options.reentrant !== undefined && !(Number.isInteger(depth) && depth >= 1)) {
    throw new TypeError(`${where}: the depth of a reentrant handler is a whole number from 1, not ${String(depth)}`);
  }
  const from = options.from ?? "now";
  if (from !== "now" && from !== "start") throw new TypeError(`${where}: from is "now" or "start", not ${String(from)}`);
  const filter = options.filter as Readonly<Record<string, unknown>> | undefined;
  if (filter !== undefined && (typeof filter !== "object" || filter === null || Array.isArray(filter))) {
    throw new TypeError(`${where}: a filter is an object of values by field name or dotted path`);
  }
  return { filter, from, concurrency, depth };
}

/** One handler a plugin declared. */
interface HandlerEntry {
  readonly name: string;
  readonly type: AnyType;
  readonly handler: Handler<any>;
  /** The record types another plugin has to declare for this handler to work. */
  readonly requires: readonly AnyType[];
  readonly subscribing: Subscribing;
  /** The types of other plugins it writes. */
  readonly emits: readonly AnyType[];
  /** Set when the handler subscribes to a trigger: the plugin named as the one that writes its records. */
  readonly trigger?: { readonly provider: string | undefined };
}

/** A subscription the host serves: a handler a plugin registered, or a subscriber it reads from the journal. */
interface Served {
  /** The record types it reads, as names or families: every type of its selectors. */
  readonly types: readonly RecordTypeName[];
  /** What wakes it: a record of one selector's types whose data holds that selector's filter. */
  readonly selectors: readonly Selector[];
  /** The version of the schema a record must have to be read through the handler's type; any when absent. */
  readonly schema: number | undefined;
  readonly version: PluginVersion;
  readonly handler: Handler<any>;
  readonly subscribing: Subscribing;
  /** The types of other plugins it writes, by name. */
  readonly emits: ReadonlySet<string>;
  /** The position after which it admits nothing: the end of a subscriber that ended. */
  readonly until?: Seq;
}

/** One part of what wakes a subscription: types, and equality on the paths of their data. */
interface Selector {
  readonly types: readonly RecordTypeName[];
  readonly filter: Readonly<Record<string, unknown>> | undefined;
}

/** The type a subscriber's handler reads its records through: any data, as it was written. */
const ANY_DATA = z.unknown();

/** What one installed version of a plugin declared while its setup function ran. */
interface Installed {
  readonly source: Plugin;
  /** Known once the setup has run: the default version covers the handlers it registered. */
  version: PluginVersion;
  readonly types: AnyType[];
  readonly actions: AnyAction[];
  readonly handlers: HandlerEntry[];
  /** The intercepts the plugin registered, by the name of the action they are on. */
  readonly intercepts: Map<ActionName, Intercepts>;
  /** The services the plugin declared: they run while the host serves. */
  readonly services: Service[];
  /** The profiles the plugin declared: the only ones it may set. */
  readonly profiles: Set<string>;
  /** The actions the plugin reads from the journal as it grows, besides the ones it declared. */
  readonly catalogs: Array<() => readonly AnyAction[]>;
  /** The subscriptions the plugin reads from the journal as it grows, besides the handlers it registered. */
  readonly subscribers: Array<() => readonly Subscriber[]>;
  /** How the plugin puts the question of an `ask` rule to the owner, when it does. */
  asker?: Asker;
  /** The counts the plugin shows in the status of the host. */
  summary?: () => Record<string, number>;
  /** What the plugin offers at the points other plugins read, by the name of the point. */
  readonly offers: Array<{ readonly key: OfferKey<unknown>; readonly value: unknown }>;
  /** The points the plugin read in its setup: a plugin installed after it may not offer there. */
  readonly readInSetup: Set<string>;
}

/** A handler of one version of one plugin, kept so work in flight can finish on it. */
interface Pinned {
  readonly handler: Handler<any>;
  readonly type: AnyType;
}

/** One invocation the host has to run, as its admitted record says. */
interface RunSpec {
  readonly invocation: InvocationId;
  readonly handlerId: HandlerId;
  readonly record: StoredRecord;
  readonly version: PluginVersion;
}

/** The index slot a wait sits in: its type alone, or the type with the field and value of its key. */
function indexSlot(type: RecordTypeName, key: WaitKey | undefined): string {
  return key === undefined ? type : JSON.stringify([type, key.field, key.equals]);
}

/** One thing a waiting invocation waits for: a record type, and the key a record of it must carry. */
interface WaitSlot {
  readonly type: RecordTypeName;
  readonly key: WaitKey | undefined;
}

/** What a step intent waits for: nothing when it is not a wait, else each type under its key. */
function slotsOf(intent: z.infer<typeof IntentData>): WaitSlot[] {
  if (intent.action !== WAIT_ACTION || intent.input === undefined) return [];
  const { type, types, key } = intent.input;
  return (types ?? (type === undefined ? [] : [type])).map((name) => ({ type: recordTypeName(name), key }));
}

function pinKey(handler: HandlerId, version: PluginVersion): string {
  return `${handler}@${version}`;
}

/**
 * A live view of the journal. It is subscribed before the history is read, so a record
 * committed in between is buffered and not lost; the cursor makes the handover duplicate-free.
 */
class Feed {
  private readonly queue: StoredRecord[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  constructor(private readonly query: ResolvedQuery) {}

  push(record: StoredRecord): void {
    if (this.closed) return;
    if (!matchesQuery({ ...this.query, from: undefined }, record)) return;
    this.queue.push(record);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  /** The records that arrive from here on, after the position given, until the feed is closed. */
  async *iterate(from: Seq): AsyncGenerator<StoredRecord, void, undefined> {
    let cursor = from;
    while (!this.closed) {
      const record = this.queue.shift();
      if (record === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      } else if (record.seq > cursor) {
        cursor = record.seq;
        yield record;
      }
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/** Live frames a client may have waiting in its socket queue; the frames past it are dropped. */
const MAX_LIVE_BACKLOG = 256;

/** One connection of a client. Its caller is named by the host: the label is only for people. */
class Connection {
  /** The subscriptions this connection opened: closed with it. */
  readonly feeds = new Set<Feed>();
  /** The live channels this connection listens to: closed with it. */
  readonly liveFeeds = new Set<LiveFeed>();
  private readonly receive: (chunk: Uint8Array | string) => void;
  /** The frames the socket did not take yet; the head may be partly written. */
  private readonly queue: Uint8Array[] = [];
  private open = true;
  private greeted = false;
  private id: ClientId;
  /** Who the token of the connection says it is; a connection with none is a plain client. */
  private who: Principal;

  constructor(
    private readonly socket: Bun.Socket<Connection>,
    private readonly number: number,
    onMessage: (connection: Connection, raw: unknown) => void,
  ) {
    this.id = clientIdOf(`client#${number}`);
    this.who = principalOf("client", this.id);
    // A line that is too long or is not JSON breaks the framing: the connection is not trusted on.
    this.receive = lineDecoder((raw) => onMessage(this, raw), { onError: () => this.end() });
  }

  get caller(): ClientId {
    return this.id;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get principal(): Principal {
    return this.who;
  }

  /**
   * Take the label the client gives itself, and the principal its token gave it; only once.
   * Returns false when it was said before. The label is only a name: it decides nothing.
   */
  greet(label: ClientId, principal: Principal | undefined): boolean {
    if (this.greeted) return false;
    this.greeted = true;
    this.id = clientIdOf(`${label}#${this.number}`);
    this.who = principal ?? principalOf("client", this.id);
    return true;
  }

  receiveBytes(chunk: Uint8Array | string): void {
    this.receive(chunk);
  }

  /** Write one frame, whole: what the socket does not take waits for the drain. */
  send(message: HostMessage): void {
    if (!this.open) return;
    this.queue.push(new TextEncoder().encode(encode(message)));
    this.flush();
  }

  /**
   * Write a live frame, unless the client is already behind: a frame is not worth waiting for
   * and must not grow the queue of a slow client without bound.
   */
  sendLive(message: HostMessage): void {
    if (this.queue.length >= MAX_LIVE_BACKLOG) return;
    this.send(message);
  }

  flush(): void {
    try {
      for (let head = this.queue[0]; head !== undefined; head = this.queue[0]) {
        const written = this.socket.write(head);
        if (written <= 0) return;
        if (written < head.length) this.queue[0] = head.subarray(written);
        else this.queue.shift();
      }
    } catch {
      this.end();
    }
  }

  /** The socket is gone: nothing more is written, the subscriptions stop. */
  drop(): void {
    this.open = false;
    this.queue.length = 0;
    for (const feed of this.feeds) feed.close();
    for (const feed of this.liveFeeds) feed.close();
  }

  /** The host gives the connection up. */
  end(): void {
    this.drop();
    this.socket.end();
  }
}

/** The state of one invocation, as the last state record says. */
function latestStates(journal: Journal): Map<string, string> {
  const states = new Map<string, string>();
  for (const row of journal.find({ type: CORE_TYPES.invocationState })) {
    const data = StateData.safeParse(row.data);
    if (data.success) states.set(data.data.invocation, data.data.state);
  }
  return states;
}

const MoveInput = z.object({ invocation: z.string() });

const ResolveInput = z
  .object({
    invocation: z.string().optional(),
    /** Instead of the invocation: the run whose one paused invocation it is. */
    run: z.string().optional(),
    choice: z.enum(["retry", "skip", "cancel"]),
    key: z.string().optional(),
  })
  .refine((input) => (input.invocation === undefined) !== (input.run === undefined), "give the invocation (id, or a unique start or end of it), or the run whose paused invocation it is");

/** The longest the host waits for one service to release what it owns. */
const STOP_TIMEOUT_MS = 5_000;

/** The longest delay a timer takes: a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What the host does about itself is the owner's: a client of another principal is refused, whatever its grant says. */
function requireOwner(caller: Caller, what: string): void {
  if (caller.kind === "client" && caller.principal?.kind !== "owner") throw new DeniedError(`only the owner ${what}`);
}

/** The answer to a request to stop is sent before the host closes. */
const STOP_DELAY_MS = 100;

/** A stop that hangs must not hang the host: it is given up on after a bound wait. */
function boundedStop(stopping: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not stop within ${STOP_TIMEOUT_MS} ms`)), STOP_TIMEOUT_MS);
  });
  return Promise.race([stopping, timeout]).finally(() => clearTimeout(timer));
}

class Niwa implements Host {
  private readonly home: string;
  private readonly plugins = new Map<PluginName, Installed>();
  /** Every version of every handler that was installed: work in flight finishes on its own. */
  private readonly pinned = new Map<string, Pinned>();
  private readonly types = new Map<RecordTypeName, AnyType>();
  /** Reads that wait for a commit: each is called when a record is committed. */
  private readonly commitWaiters = new Set<() => void>();
  /** The types declared as a family (`wf.*`): every name under the prefix is one of them, with the family's schema. */
  private readonly families: AnyType[] = [];
  /** The plugin that declares each type: the only one that writes it over the wire unless it is open. */
  private readonly typeOwners = new Map<RecordTypeName, PluginName>();
  /** The tokens and the grants this host made, folded from the journal; present while the host serves. */
  private doors: Doors | undefined;
  /** The grants and the profiles: what writes the records of access. */
  private readonly access = new AccessControl({
    doors: () => this.requireDoors(),
    commit: (records) => this.append(records),
    read: (id) => this.journal?.get(id),
  });
  /** The actions of access: the host registers them for itself. */
  private readonly accessActionList = accessActions(this.access, () => this.requireDoors());
  /** The types each action may write: the ones its own plugin declares. */
  private readonly typesOf = new Map<ActionName, Set<RecordTypeName>>();
  private readonly actions = new Map<ActionName, AnyAction>();
  /** The intercepts of the current plugins, by the name of the action they are on. */
  private readonly intercepts = new Map<ActionName, Intercepts>();
  private readonly handlers = new Map<HandlerId, Served>();
  /** Everything that watches the journal: the host's own subscriptions and the clients'. */
  private readonly feeds = new Set<Feed>();
  private readonly connections = new Set<Connection>();
  /** The invocations that run; `again` says a run was asked for while it ran. */
  private readonly running = new Map<InvocationId, { again: boolean; woken: boolean }>();
  /** The invocations suspended on a wait, with what each of their open waits waits for. */
  private readonly waiting = new Map<InvocationId, { slots: readonly WaitSlot[]; spec: RunSpec }>();
  /**
   * The waiting invocations by what wakes them: a wait without a key under its type, a keyed one
   * under (type, field, value). A record looks up only the entries it can match, so it does not
   * walk every waiter. Rebuilt by park() from the journal's wait intents, so it needs no storage.
   */
  private readonly waitIndex = new Map<string, Set<InvocationId>>();
  /** For each type, the key fields some keyed waiter uses, with how many: the fields a record checks. */
  private readonly waitFields = new Map<RecordTypeName, Map<string, number>>();
  /** How far each subscription has looked: read from the journal on first use. */
  private readonly positions = new Map<HandlerId, Seq>();
  /** How far each subscription's position is kept in the journal: by a position record or an admission. */
  private readonly kept = new Map<HandlerId, Seq>();
  /** The unfinished invocations of each subscription: admitted and not done, the waiting and the paused too. */
  private readonly active = new Map<HandlerId, Set<InvocationId>>();
  /** The subscribers read from the journal at the last look: they are read again at the next. */
  private readonly dynamic = new Set<HandlerId>();
  /** The subscription of each unfinished invocation, to free its place when it is done. */
  private readonly activeOf = new Map<InvocationId, HandlerId>();
  /** The state of the plugins: values by key, projected from the journal. */
  private readonly states = new StateStore();
  /** The functions that stop the running services, by the plugin that declared them. */
  private readonly stoppers = new Map<PluginName, Array<() => void | Promise<void>>>();
  /** What the services are still releasing: the host waits for it before it is gone. */
  private readonly stopping: Array<Promise<void>> = [];
  private readonly resolver = this.resolveAction();
  private readonly mover = this.moveAction();
  private readonly installer = pluginInstallAction({
    install: (plugin) => this.use(plugin),
    record: async (caller, data) => {
      const journal = this.requireJournal();
      const before = installationOf(journal, data.plugin);
      const id = newRecordId("plg");
      this.append([{ id, stream: streamId("plugin"), type: CORE_TYPES.pluginInstalled, schema: 1, data, actor: caller, cause: null, root: id }]);
      // The file the plugin was installed from before is not the one it is made from now: its copy goes when nothing else is made from it.
      if (before !== undefined) await removeCopyIfStale(journal, before);
    },
  });
  /** The actions the host registers for itself: observation and the description. */
  private readonly readers = [
    this.recordsReadAction(),
    this.recordsSearchAction(),
    this.traceAction(),
    this.causesAction(),
    this.describeAction(),
    this.statusAction(),
    this.stopAction(),
    this.catalogAction(),
  ];
  /** The live frames: they go to the listeners of the moment and are never written down. */
  private readonly liveBus = new LiveBus();
  /** This host takes the journal even from a living holder. */
  private readonly takeover: boolean;
  /** The clock of this host: everything that reads the time or waits for it asks here. */
  private readonly clock: Clock;
  /** The identity of the socket file this host bound: only that file is this host's to remove. */
  private socketFile: string | undefined;
  private journal: Journal | undefined;
  private server: Bun.UnixSocketListener<Connection> | undefined;
  private serving: Promise<void> | undefined;
  private pumpQueued = false;
  private connectionCount = 0;
  private closed = false;

  /** What a request to stop does. */
  private readonly onStop: () => void;

  constructor(opts: { home: string; takeover?: boolean; clock?: Clock; onStop?: () => void }) {
    this.onStop = opts.onStop ?? (() => void this.close());
    this.home = expandHome(opts.home);
    this.takeover = opts.takeover === true;
    this.clock = opts.clock ?? realClock();
    // The actions of the host are registered before any plugin is: a host with none still has them.
    this.rebuild();
  }

  // --- plugins ---------------------------------------------------------------

  use(...plugins: Plugin[]): void {
    for (const [index, plugin] of plugins.entries()) {
      try {
        this.install(plugin);
      } catch (error) {
        throw new PluginInstallFailed(
          plugin.name,
          plugins.slice(0, index).map((done) => done.name),
          plugins.slice(index + 1).map((rest) => rest.name),
          error,
        );
      }
    }
  }

  /**
   * The offers at a point, in the order the plugins were installed. `settingUp` is the plugin whose setup
   * reads them: its own offers count, and its earlier version's do not.
   */
  private offersAt<T>(key: OfferKey<T>, settingUp: Installed | undefined): Offered<T>[] {
    const found: Offered<T>[] = [];
    const add = (name: PluginName, installed: Installed): void => {
      for (const one of installed.offers) if (one.key.name === key.name) found.push({ plugin: name, value: one.value as T });
    };
    for (const [name, installed] of this.plugins) {
      if (settingUp !== undefined && name === settingUp.source.name) continue;
      add(name, installed);
    }
    if (settingUp !== undefined) add(settingUp.source.name, settingUp);
    return found;
  }

  /** The type of this name that an installed plugin declares. */
  private declaredBefore(name: string): AnyType | undefined {
    for (const installed of this.plugins.values()) {
      const found = installed.types.find((type) => type.name === name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * Install a plugin, or replace the one of its name.
   *
   * The plugin is staged first: its setup runs against a copy of what it may change in the host
   * besides its own registrations (the profiles and the keys of state it declares). Only a setup
   * that ran to its end is swapped in. Any other outcome puts the shared things back and leaves the
   * installed plugin as it was.
   */
  private install(plugin: Plugin): void {
    const profiles = this.access.declaredProfiles();
    const keys = this.states.declared();
    // Set when the install is refused: the api of the plugin then changes nothing in the host.
    let refused = false;
    const live = (): void => {
      if (refused) throw new Error(`plugin "${plugin.name}" was not installed: its api changes nothing any more`);
    };
    try {
      this.stage(plugin, live);
    } catch (error) {
      refused = true;
      this.access.restoreProfiles(profiles);
      this.states.restore(keys);
      throw error;
    }
  }

  private stage(plugin: Plugin, live: () => void): void {
    const sources: string[] = [];
    const installed: Installed = {
      source: plugin,
      version: plugin.version,
      types: [],
      actions: [],
      handlers: [],
      intercepts: new Map(),
      services: [],
      profiles: new Set(),
      catalogs: [],
      subscribers: [],
      offers: [],
      readInSetup: new Set(),
    };
    let inSetup = true;
    const offer = <T>(key: OfferKey<T>, value: T): void => {
        // A plugin that read the point when it was installed would never see this offer: it is refused, not lost. A
        // new version of a plugin installed before the reader keeps its place, and its offers are read as it is.
        for (const [name, other] of this.plugins) {
          if (name === plugin.name) break;
          if (other.readInSetup.has(key.name)) {
            throw new TypeError(`plugin "${plugin.name}" offers "${key.name}", which "${name}" read when it was installed: install "${plugin.name}" before "${name}"`);
          }
        }
        installed.offers.push({ key, value });
    };
    const returned: unknown = plugin.setup({
      declare: (...types: AnyType[]) => {
        // A trigger is a view of a type, not a type: declaring one would replace the type it narrows.
        for (const type of types as ReadonlyArray<Subscribable<any>>) {
          if (isTrigger(type)) {
            throw new TypeError(`"${type.name}" is a trigger: declare the type it narrows, "${type.type.name}", not the trigger`);
          }
        }
        installed.types.push(...types);
      },
      offer: <T>(key: OfferKey<T>, value: T) => offer(key, value),
      offers: <T>(key: OfferKey<T>): Offered<T>[] => {
        if (inSetup) installed.readInSetup.add(key.name);
        return this.offersAt(key, inSetup ? installed : undefined);
      },
      service: (start: Service) => {
        installed.services.push(start);
      },
      action: (a: AnyAction) => {
        installed.actions.push(a);
      },
      catalog: (read: () => readonly AnyAction[]) => {
        installed.catalogs.push(read);
      },
      subscribers: (read: () => readonly Subscriber[]) => {
        installed.subscribers.push(read);
      },
      adjust: (target: ActionRef<any, any>, fn: AdjustFn<any>) => {
        const set = installed.intercepts.get(target.name) ?? newIntercepts();
        set.adjusts.push(fn);
        installed.intercepts.set(target.name, set);
      },
      guard: (target: ActionRef<any, any>, fn: GuardFn<any>) => {
        const set = installed.intercepts.get(target.name) ?? newIntercepts();
        set.guards.push(fn);
        installed.intercepts.set(target.name, set);
      },
      live: (channel: string, frame: LiveFrame) => {
        this.liveBus.send(channelName(channel), frameFor(channel, frame));
      },
      on: (
        source: Subscribable<any>,
        optsOrHandler: HandlerOptions<any> | Handler<any>,
        maybeHandler?: Handler<any>,
      ) => {
        const type = isTrigger(source) ? source.type : source;
        const [options, handler]: [HandlerOptions<any>, Handler<any> | undefined] =
          typeof optsOrHandler === "function"
            ? [{}, optsOrHandler]
            : [optsOrHandler, maybeHandler];
        if (handler === undefined) throw new TypeError(`a handler of "${type.name}" is missing`);
        // A trigger names its handlers after what it watches, so two triggers of the same type are two
        // different handlers.
        const name = options.id ?? source.name;
        if (name.includes("/")) {
          throw new TypeError(
            `plugin "${plugin.name}" names a handler "${name}": a handler id is the name of the plugin, a "/" and the handler's own name, so the name has none`,
          );
        }
        // The journal holds the handler id, not the function: two with one id could not be told apart.
        if (installed.handlers.some((entry) => entry.name === name)) {
          throw new Error(
            `plugin "${plugin.name}" declares two handlers with the id "${name}": a handler id must name one handler`,
          );
        }
        const filter = isTrigger(source) ? { ...source.filter, ...options.filter } : options.filter;
        const subscribing = subscribingOf(`plugin "${plugin.name}", handler "${name}"`, { ...options, filter });
        // What a trigger needs offered for its records to be written at all, the subscribing plugin offers.
        if (isTrigger(source) && source.offer !== undefined) offer(source.offer.key, source.offer.value);
        installed.handlers.push({
          name,
          type,
          handler,
          requires: options.requires ?? [],
          emits: options.emits ?? [],
          subscribing,
          ...(isTrigger(source) ? { trigger: { provider: source.provider } } : {}),
        });
        sources.push(handlerSource(name, handler));
      },
      // The reader is a function: the journal opens when the host starts serving, which is
      // after the plugin is installed. A plugin asks for it when it needs it, and gets
      // undefined before the journal is open.
      journal: () => this.journal,
      summarize: (read) => {
        installed.summary = read;
      },
      recordType: (name) => installed.types.find((type) => type.name === name) ?? this.declaredBefore(name),
      untilCommit: (ms) => this.untilCommit(ms),
      socket: () => socketPath(realpathSync(this.home)),
      home: () => realpathSync(this.home),
      emit: async <T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord> => {
        if (!installed.types.some((own) => own.name === type.name)) {
          throw new UnknownType(type.name);
        }
        return this.write({ kind: "host" }, type.name, data, opts);
      },
      state: <T>(name: string, schema: z.ZodType<T>, initial: T): StateHandle<T> => {
        live();
        return this.states.define(plugin.name, name, schema, initial);
      },
      // A plugin starts sessions and runs; the owner and the plugins are the host's to make.
      issueToken: (kind, id, opts) => {
        if (kind !== "session" && kind !== "run") throw new TypeError(`a plugin makes no token for "${String(kind)}"`);
        return this.issue(principalOf(kind, id), opts);
      },
      narrow: (caller, requested) => this.access.narrowFor(caller, requested),
      rights: (caller) => this.access.rightsOf(caller),
      profile: (name, rules) => {
        live();
        installed.profiles.add(name);
        this.access.declareProfile(name, rules);
      },
      asker: (ask) => {
        installed.asker = ask;
      },
      setProfile: (name, rules, by) => {
        if (!installed.profiles.has(name)) {
          throw new TypeError(`plugin "${plugin.name}" did not declare the profile "${name}": it sets only its own`);
        }
        return this.access.setProfile(by, name, rules);
      },
      authorize: (caller, verb, name, how) => this.authorize(caller, verb, name, how),
    });

    inSetup = false;
    if (isThenable(returned)) {
      // What the promise does later is nobody's to see: it must not fail the process on its own.
      Promise.resolve(returned).catch(() => undefined);
      throw new TypeError(
        `plugin "${plugin.name}" has an asynchronous setup: a setup runs to its end before the plugin is installed, so it must not return a promise`,
      );
    }
    // The version of a plugin without an explicit one covers the handlers it registered, wherever
    // they are defined: the setup has run, so they are known now.
    sealVersion(plugin, sources);
    installed.version = plugin.version;
    // Earlier versions stay pinned: they were pinned when they were installed.
    for (const entry of installed.handlers) {
      this.pinned.set(pinKey(handlerIdOf(`${plugin.name}/${entry.name}`), plugin.version), {
        handler: entry.handler,
        type: entry.type,
      });
    }
    // The owner of a record type is one plugin: two would each be refused the other's writes, and a
    // name under another plugin's family would have two schemas.
    for (const [name, other] of this.plugins) {
      if (name === plugin.name) continue;
      for (const type of installed.types) {
        const taken = other.types.find((theirs) => overlaps(theirs.name, type.name));
        if (taken !== undefined) {
          throw new TypeError(
            `plugin "${plugin.name}" declares "${type.name}", which "${name}" owns as "${taken.name}": a record type has one owner`,
          );
        }
      }
    }
    // A plugin that replaces another takes its services over: the old ones stop, the new ones
    // start when the host is already serving.
    this.stopServicesOf(plugin.name);
    this.plugins.set(plugin.name, installed);
    this.rebuild();
    if (this.journal !== undefined) this.startServicesOf(plugin.name);
  }

  installed(name: PluginName): Plugin | undefined {
    return this.plugins.get(name)?.source;
  }

  unload(name: PluginName): void {
    this.stopServicesOf(name);
    this.plugins.delete(name);
    this.rebuild();
  }

  /**
   * Start the services of the plugins that are installed.
   *
   * A service runs while the host serves and stops when it does not. It is started after the
   * journal is open, so what it writes lands in the journal of this host.
   */
  private startServices(): void {
    for (const name of this.plugins.keys()) this.startServicesOf(name);
  }

  /** Start the services of one installed plugin. */
  private startServicesOf(name: PluginName): void {
    for (const start of this.plugins.get(name)?.services ?? []) {
      const run = { stopped: false };
      try {
        const stop = start(this.serviceContext(name, run));
        this.stoppers.set(name, [
          ...(this.stoppers.get(name) ?? []),
          () => {
            run.stopped = true;
            return stop();
          },
        ]);
      } catch (error) {
        run.stopped = true;
        this.fail(`starting the service of "${name}"`, error);
      }
    }
  }

  /** Stop the services of one plugin: they do not outlive the plugin that declared them. */
  private stopServicesOf(name: PluginName): void {
    const stoppers = this.stoppers.get(name);
    if (stoppers === undefined) return;
    this.stoppers.delete(name);
    for (const stop of stoppers) {
      try {
        const stopping = stop();
        if (stopping instanceof Promise) {
          // A service that owns something releases it asynchronously: the host waits for it, so
          // what the service owns is gone before the host is gone.
          this.stopping.push(
            boundedStop(stopping).catch((error: unknown) => {
              this.fail(`stopping the service of "${name}"`, error);
            }),
          );
        }
      } catch (error) {
        this.fail(`stopping the service of "${name}"`, error);
      }
    }
  }

  /** What a service of one plugin is given: it writes only what that plugin declared. */
  private serviceContext(name: PluginName, run: { stopped: boolean }): ServiceContext {
    const installed = this.plugins.get(name);
    const own = installed?.types ?? [];
    return {
      emit: async <T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord> => {
        if (run.stopped) throw new Error(`the service of "${name}" has stopped: it writes nothing more`);
        if (!own.some((declared) => declared.name === type.name)) {
          throw new UnknownType(type.name);
        }
        return this.write({ kind: "host" }, type.name, data, opts);
      },
      now: (): Timestamp => timestamp(this.clock.now()),
      schedule: (at, fn) => this.clock.schedule(at, fn),
    };
  }

  /**
   * The action the host registers for itself: read the records of the journal.
   *
   * The read is one-shot: it answers with the records that are committed now and ends. It reads
   * the history and never waits for more, so a caller knows when the answer is the whole thing.
   */
  private recordsReadAction(): AnyAction {
    return action(RECORDS_READ_ACTION, {
      description:
        "The records of the journal after a position that answer a record query: types as exact names or prefix.* families, equality on paths of the data, a stream. In commit order, up to the ones committed now.",
      input: RecordsReadInput,
      output: RecordsOutput,
      // A read writes nothing: it may be made again.
      recovery: "repeat",
      run: async (input: z.infer<typeof RecordsReadInput>) =>
        this.untilFound(input.waitMs, () => this.readQuery(input)),
    });
  }

  /**
   * The action the host registers for itself: search the records as a person looks for them — by
   * who wrote them, what they are about, a text, a span of time. It is not a record query: what it
   * finds may depend on the journal around a record (a run is all it grew into).
   */
  private recordsSearchAction(): AnyAction {
    return action(RECORDS_SEARCH_ACTION, {
      description:
        "Search the records of the journal after a position: type patterns, an actor, a run, session, request or task, a text in the data, a span of time or of positions.",
      input: RecordsSearchInput,
      output: RecordsOutput,
      recovery: "repeat",
      run: async (input: z.infer<typeof RecordsSearchInput>) =>
        this.untilFound(input.waitMs, () =>
          readFiltered(this.requireJournal(), seq(input.from ?? 0), input.filter ?? {}, {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.tail === undefined ? {} : { tail: input.tail }),
            ...(input.stream === undefined ? {} : { stream: streamId(input.stream) }),
          }),
        ),
    });
  }

  /** Read until something is found or the time is over: a read with nothing waits for a commit and looks again. */
  private async untilFound(waitMs: number | undefined, read: () => Found): Promise<Found> {
    const deadline = Date.now() + (waitMs ?? 0);
    for (;;) {
      const found = read();
      const left = deadline - Date.now();
      if (found.records.length > 0 || left <= 0) return found;
      // The wait is registered in the step that looked, so a record committed in between is not missed.
      await this.untilCommit(left);
    }
  }

  /** What a read asks for, answered: the records that answer its query now, and where the next read goes on. */
  private readQuery(input: z.infer<typeof RecordsReadInput>): Found {
    const journal = this.requireJournal();
    const from = seq(input.from ?? 0);
    const query = resolveQuery({
      from,
      ...(input.types === undefined ? {} : { types: input.types }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.stream === undefined ? {} : { stream: input.stream }),
    });
    const end = journal.last();
    if (input.tail !== undefined) {
      return { records: journal.query(query).slice(-input.tail), next: seq(Math.max(end, from)) };
    }
    const records = journal.query(query, input.limit);
    const full = input.limit !== undefined && records.length === input.limit;
    return { records, next: full ? seq(records[records.length - 1]?.seq ?? from) : seq(Math.max(end, from)) };
  }

  /** Wait until a record is committed, or the time is over. */
  private untilCommit(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.commitWaiters.delete(done);
        resolve();
      };
      // A timer longer than the runtime's limit fires at once, and a wait would then spin.
      const timer = setTimeout(done, Math.min(ms, MAX_TIMER_MS));
      this.commitWaiters.add(done);
    });
  }

  /**
   * The action the host registers for itself: everything that grew from a record.
   *
   * The walk goes down, through causes and links, depth-first, each record once.
   */
  private traceAction(): AnyAction {
    return action(TRACE_ACTION, {
      description:
        "Everything that grew from a record, depth-first, each record once, with its depth.",
      input: RecordWalkInput,
      output: TracedRecordsOutput,
      // A walk reads the records and writes nothing: it may be made again.
      recovery: "repeat",
      run: async (input: z.infer<typeof RecordWalkInput>) =>
        trace(this.requireJournal(), recordId(input.id)),
    });
  }

  /**
   * The action the host registers for itself: what a record depends on.
   *
   * The walk goes up, through the cause and the links of the record.
   */
  private causesAction(): AnyAction {
    return action(CAUSES_ACTION, {
      description: "What a record depends on: up through its cause and its links.",
      input: RecordWalkInput,
      output: RecordList,
      // A walk reads the records and writes nothing: it may be made again.
      recovery: "repeat",
      run: async (input: z.infer<typeof RecordWalkInput>) =>
        causes(this.requireJournal(), recordId(input.id)),
    });
  }

  /**
   * The action the host registers for itself: say what niwa is.
   *
   * The description is the list of the actions and the record types, with their schemas. It is
   * an action like any other, so a surface that lists what it may do reads it from here.
   */
  private describeAction(): AnyAction {
    return action(DESCRIBE_ACTION, {
      description: "What niwa is: its actions and its record types, with their schemas.",
      input: z.object({}),
      output: DescriptionOutput,
      // A description reads the registrations and writes nothing: it may be made again.
      recovery: "repeat",
      run: async () => this.describe(),
    });
  }

  /** The one paused invocation of a run: the ones whose waking record names the run (a unique start of its id is enough). */
  private pausedOfRun(journal: Journal, run: string, pausedIds: readonly string[]): string {
    const of = pausedIds.filter((id) => {
      const admitted = journal.get(recordId(id));
      const data = admitted === undefined ? undefined : AdmittedData.safeParse(admitted.data);
      const woken = data?.success === true ? journal.get(recordId(data.data.record)) : undefined;
      const named = (woken?.data as { run?: unknown } | undefined)?.run;
      return typeof named === "string" && named.startsWith(run);
    });
    const [only, ...more] = of;
    if (only === undefined) throw new Error(`the run "${run}" has no paused invocation`);
    if (more.length > 0) throw new Error(`the run "${run}" has ${String(of.length)} paused invocations: ${of.join(", ")}: name one`);
    return only;
  }

  /** The action that says whether the host is up and what it holds. */
  private statusAction(): AnyAction {
    return action(STATUS_ACTION, {
      description: "Whether the host is up: its process, its home, the position of its journal, and what each plugin holds (runs by state, open requests, live sessions).",
      input: z.object({}),
      output: StatusOutput,
      // It reads and writes nothing: it may be made again.
      recovery: "repeat",
      run: (_input, ctx) => {
        requireOwner(ctx.caller, "sees the status of the host");
        return {
          pid: process.pid,
          home: this.home,
          seq: this.requireJournal().last(),
          plugins: [...this.plugins].map(([name, installed]) => ({
            name,
            version: installed.version,
            ...(installed.summary === undefined ? {} : { summary: installed.summary() }),
          })),
        };
      },
    });
  }

  /** The action that lists the cockpit modules the plugins offer, with the hash of each one's code. */
  private catalogAction(): AnyAction {
    return action(CATALOG_ACTION, {
      description: "The client modules the installed plugins offer to the cockpit: the id, the plugin and its version, the entry file and the hash of the module's code.",
      input: z.object({}),
      output: CatalogOutput,
      // It reads files and writes nothing: it may be made again.
      recovery: "repeat",
      run: () => catalogOf(this.offersAt(COCKPIT_MODULE, undefined), (plugin) => this.plugins.get(pluginName(plugin))?.version ?? ""),
    });
  }

  /** The action that stops the host: it answers first, and the host closes after. */
  private stopAction(): AnyAction {
    return action(STOP_ACTION, {
      description: "Stop the host gracefully: the work in flight stays in the journal and goes on when the host is served again.",
      input: z.object({}),
      output: z.object({ stopping: z.literal(true) }),
      // A stop that was cut off is not made again: it would stop the host that took its place.
      recovery: "do-not-repeat",
      run: (_input, ctx) => {
        requireOwner(ctx.caller, "stops the host");
        setTimeout(this.onStop, STOP_DELAY_MS);
        return { stopping: true as const };
      },
    });
  }

  /** The declared type of a name: the type itself, or the family whose prefix the name is under. */
  private declaredType(name: RecordTypeName): AnyType | undefined {
    return this.types.get(name) ?? this.families.find((family) => name.startsWith(family.name.slice(0, -1)));
  }

  /** The action of a name: a declared one, or one a plugin's catalog reads from the journal now. */
  private actionOf(name: ActionName): AnyAction | undefined {
    return this.actions.get(name) ?? this.catalogued().find((entry) => entry.action.name === name)?.action;
  }

  /** Every action: the declared ones, then the ones the catalogs read now that no declared one shadows. */
  private allActions(): AnyAction[] {
    const read = this.catalogued().map((entry) => entry.action).filter((entry) => !this.actions.has(entry.name));
    return [...this.actions.values(), ...read];
  }

  /** The record types an action may write: the ones of the plugin that declares or catalogs it. */
  private typesOfAction(name: ActionName): Set<RecordTypeName> | undefined {
    const declared = this.typesOf.get(name);
    if (declared !== undefined) return declared;
    const owner = this.catalogued().find((entry) => entry.action.name === name)?.installed;
    return owner === undefined ? undefined : new Set(owner.types.map((type) => type.name));
  }

  /** The actions the catalogs of the loaded plugins hold now, each with its plugin. */
  private catalogued(): Array<{ action: AnyAction; installed: Installed }> {
    if (this.journal === undefined) return [];
    return [...this.plugins.values()].flatMap((installed) =>
      installed.catalogs.flatMap((read) => read().map((action) => ({ action, installed }))),
    );
  }

  /** The current registrations: what the loaded plugins declare. Then look for new work. */
  private rebuild(): void {
    this.types.clear();
    this.actions.clear();
    this.typesOf.clear();
    this.typeOwners.clear();
    this.families.length = 0;
    this.handlers.clear();
    this.intercepts.clear();
    for (const [name, installed] of this.plugins) {
      for (const type of installed.types) {
        this.types.set(type.name, type);
        this.typeOwners.set(type.name, name);
        if (type.name.endsWith(".*")) this.families.push(type);
      }
      for (const declared of installed.actions) {
        this.actions.set(declared.name, declared);
        this.typesOf.set(declared.name, new Set(installed.types.map((type) => type.name)));
      }
      for (const [target, set] of installed.intercepts) {
        // The intercepts of several plugins on one action are one list, and the order of
        // registration is the order they run in.
        const current = this.intercepts.get(target) ?? newIntercepts();
        current.adjusts.push(...set.adjusts);
        current.guards.push(...set.guards);
        this.intercepts.set(target, current);
      }
      for (const entry of installed.handlers) {
        this.handlers.set(handlerIdOf(`${name}/${entry.name}`), {
          types: [entry.type.name],
          selectors: [{ types: [entry.type.name], filter: entry.subscribing.filter }],
          schema: entry.type.version,
          version: installed.version,
          handler: entry.handler,
          subscribing: entry.subscribing,
          emits: new Set(entry.emits.map((type) => type.name)),
        });
      }
    }
    // The host registers one action for itself: the way an owner answers a paused invocation.
    this.actions.set(this.resolver.name, this.resolver);
    this.actions.set(this.mover.name, this.mover);
    // And one more: the way anyone asks what a plugin would do differently over recorded records.
    // And the install of a plugin from a file: its target is the plugin, so a grant can limit it.
    this.actions.set(this.installer.name, this.installer);
    // And the observation ones: reading what happened is an action, so the surfaces generate
    // their tools and their commands from the same list as everything else.
    for (const reader of this.readers) this.actions.set(reader.name, reader);
    // And the ones of access: profiles, a grant changed or closed, the switch, and the explanation.
    for (const entry of this.accessActionList) this.actions.set(entry.name, entry);
    // A subscription installed while the host serves starts where the journal is now, not where
    // it is when the host next looks for work.
    if (this.journal !== undefined) this.placeSubscriptions(this.journal);
    this.requestPump();
  }

  private requireJournal(): Journal {
    if (this.journal === undefined) throw new Error("the host is not serving");
    return this.journal;
  }

  /** The last state record of an invocation, when it has one. */
  private lastState(
    journal: Journal,
    invocation: InvocationId,
  ): { state: string; key: string | undefined; choices: string[] | undefined } | undefined {
    const rows = journal.find({
      type: CORE_TYPES.invocationState,
      field: "invocation",
      equals: invocation,
    });
    const data = StateData.safeParse(rows.at(-1)?.data);
    return data.success ? { state: data.data.state, key: data.data.key, choices: data.data.choices } : undefined;
  }

  /**
   * The action the host registers for itself: answer a paused invocation.
   *
   * The answer is written as a record first, and then the invocation runs again with it in hand.
   */
  private resolveAction(): AnyAction {
    return action(RESOLVE_ACTION, {
      description: "Answer a paused invocation: retry the step, skip it, or cancel the invocation.",
      input: ResolveInput,
      output: z.object({ resolved: z.boolean() }),
      // The answer is written as a record and the invocation runs again with it: the choice
      // stands whatever happens to the call, so it may be made again.
      recovery: "repeat",
      run: async (input: z.infer<typeof ResolveInput>, ctx) => {
        const journal = this.requireJournal();
        // The invocation is named by its id, or by a unique start, end or short form of the id of one that is paused.
        const pausedIds = [...latestStates(journal)].filter(([, state]) => state === "paused").map(([id]) => String(id));
        // What a part of an id or a run would name is every paused invocation of the host: a client that is not the owner gives the whole id.
        if (input.run !== undefined || journal.get(recordId(input.invocation ?? "")) === undefined) requireOwner(ctx.caller, "names an invocation by a part of its id or by its run");
        const named =
          input.run === undefined
            ? (resolveId(input.invocation ?? "", pausedIds, "paused invocation", shortInvocation) ?? input.invocation ?? "")
            : this.pausedOfRun(journal, input.run, pausedIds);
        const admitted = journal.get(recordId(named));
        const spec =
          admitted?.type === CORE_TYPES.invocationAdmitted
            ? this.specOf(journal, admitted)
            : undefined;
        if (spec === undefined) throw new Error(`unknown invocation "${named}"`);
        const paused = this.lastState(journal, spec.invocation);
        if (paused?.state !== "paused") {
          throw new Error(`invocation "${named}" is not paused`);
        }
        // The step the answer is about: the one it names, or the one the invocation paused on.
        const keyName = input.key ?? paused.key;
        const key = keyName === undefined ? NO_STEP : stepKey(keyName);
        // Only what the pause offers (a wait is only cancelled, a pause on no step has no step to skip): the rule the
        // pause was written with, and the one a surface shows.
        const offered = offeredChoices(journal, spec.invocation, { choices: paused.choices, key });
        if (!offered.includes(input.choice)) {
          const intent = journal.get(attemptRecordId(spec.invocation, key, 0, "intent"));
          const waited = (intent?.data as { action?: unknown } | undefined)?.action === WAIT_ACTION;
          throw new Error(
            waited
              ? `step ${key} is a wait: it can only be cancelled, not ${input.choice}`
              : `the pause of invocation "${named}" does not offer ${input.choice}: it offers ${offered.join(", ")}`,
          );
        }
        // The answer carries the attempt it answers, so it applies to that run and not to later ones.
        const attempt = attemptsOf(journal, spec.invocation, key) - 1;
        const records = [
          this.invocationRecord(spec, "res", CORE_TYPES.invocationResolved, {
            invocation: spec.invocation,
            key,
            choice: input.choice,
            attempt,
          }, ctx.caller),
        ];
        if (input.choice === "cancel") {
          records.push(this.stateRecord(spec, "done", "cancelled"));
        }
        this.append(records);
        // Retry calls the step as a new attempt, skip continues without it.
        if (input.choice !== "cancel") this.schedule(spec);
        return { resolved: true };
      },
    });
  }

  /**
   * The action the host registers for itself: move an unfinished invocation onto the version of
   * its plugin that is installed now.
   *
   * It is the explicit operation: nothing moves work except this call. The move is a record, so
   * a restart keeps it; the invocation then replays its recorded steps on the new code, and a
   * step the new code does not make the same way pauses it as a replay mismatch.
   */
  private moveAction(): AnyAction {
    return action(MOVE_ACTION, {
      description:
        "Move an unfinished invocation onto the installed version of its plugin. Work is never moved by a restart.",
      input: MoveInput,
      output: z.object({ from: z.string(), to: z.string() }),
      // The record of the move is written under the id of the operation: a call made again
      // finds it and moves nothing twice.
      recovery: "repeat",
      run: async (input: z.infer<typeof MoveInput>, ctx) => {
        const journal = this.requireJournal();
        const admitted = journal.get(recordId(input.invocation));
        const spec =
          admitted?.type === CORE_TYPES.invocationAdmitted ? this.specOf(journal, admitted) : undefined;
        if (spec === undefined) throw new Error(`unknown invocation "${input.invocation}"`);
        const id = recordId(`mv:${ctx.operationId}`);
        const done = journal.get(id);
        if (done !== undefined) {
          const data = z.object({ from: z.string(), to: z.string() }).parse(done.data);
          return { from: data.from, to: data.to };
        }
        if (this.lastState(journal, spec.invocation)?.state === "done") {
          throw new Error(`invocation "${input.invocation}" is done: there is nothing to move`);
        }
        const current = this.handlers.get(spec.handlerId);
        if (current === undefined) {
          throw new Error(`no installed plugin has the handler "${spec.handlerId}": there is nothing to move onto`);
        }
        if (current.version === spec.version) {
          throw new Error(`invocation "${input.invocation}" is already on version ${spec.version}`);
        }
        if (this.running.has(spec.invocation)) {
          throw new Error(`invocation "${input.invocation}" is running: move it when it waits or pauses`);
        }
        const move = { from: spec.version, to: current.version };
        this.append([
          {
            ...this.invocationRecord(spec, "mv", CORE_TYPES.invocationMoved, { invocation: spec.invocation, ...move }, ctx.caller),
            id,
          },
        ]);
        this.unpark(spec.invocation);
        this.schedule({ ...spec, version: current.version });
        return move;
      },
    });
  }

  // --- serving ---------------------------------------------------------------

  serve(): Promise<void> {
    this.serving ??= this.start().catch((error: unknown) => {
      this.serving = undefined;
      throw error;
    });
    return this.serving;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error("the host is closed");
    this.requireProviders();
    const path = socketPath(this.home);
    // The socket is checked before the journal is opened: a living host on this home is refused,
    // and taking the journal from it would be a take-over the owner did not ask for. An explicit
    // take-over skips the check: the old host learns it lost the journal from its next write.
    if (!this.takeover && (await isLiveSocket(path))) {
      throw new WriterBusy(`another host is listening on ${path}`);
    }
    const journal = openJournal(this.home, { takeover: this.takeover, clock: this.clock });
    this.journal = journal;
    try {
      this.openDoors(journal);
      // Before anything loads a plugin file again: the copies of files no installation is made from are taken away.
      await removeStaleCopies(journal);
      // The state is a projection of the journal: folded from it here, so a restart sees it.
      this.states.bind({ journal, append: (recs) => this.append(recs) });
      this.positions.clear();
      this.kept.clear();
      this.active.clear();
      this.activeOf.clear();
      this.placeSubscriptions(journal);
      this.resume(journal);
      this.pump(journal);
      rmSync(path, { force: true }); // the old holder's file: this host binds its own
      this.server = Bun.listen<Connection>({
        unix: path,
        socket: {
          open: (socket) => {
            const connection = new Connection(socket, ++this.connectionCount, (c, raw) => {
              void this.handleMessage(c, raw);
            });
            socket.data = connection;
            this.connections.add(connection);
          },
          data: (socket, chunk) => {
            socket.data.receiveBytes(chunk);
          },
          drain: (socket) => {
            socket.data.flush();
          },
          close: (socket) => {
            this.connections.delete(socket.data);
            socket.data.drop();
          },
          error: (socket) => {
            this.connections.delete(socket.data);
            socket.data.drop();
          },
        },
      });
      this.socketFile = socketIdentity(path);
      // Started last: a service that fails to start must not leave a host half-served, and what a
      // service writes lands in the journal that is open now.
      this.startServices();
    } catch (error) {
      // The host could not serve: the journal is given back, so the next host may take it over.
      journal.close();
      this.journal = undefined;
      this.doors = undefined;
      throw error;
    }
  }

  /**
   * The tokens: folded from the journal, so a restart knows every token it made. The owner's
   * token is made on the first start and kept in the home for the owner's own tools; a missing
   * or unknown one is made again, and the old one stops working.
   */
  private openDoors(journal: Journal): void {
    const doors = new Doors(loadHostKey(this.home));
    const types = [
      CORE_TYPES.accessIssued,
      CORE_TYPES.accessGranted,
      CORE_TYPES.accessClosed,
      CORE_TYPES.accessProfile,
      CORE_TYPES.accessSwitched,
      CORE_TYPES.accessAnswered,
    ];
    // The table is what the records say, in the order they were written.
    for (const row of journal.since(seq(0), types)) doors.fold(row);
    this.doors = doors;
    const known = readOwnerToken(this.home);
    if (known !== undefined && doors.holderOf(known)?.kind === "owner") return;
    const secret = this.issue(OWNER, {});
    const path = `${this.home}/${OWNER_TOKEN_FILE}`;
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  private requireDoors(): Doors {
    if (this.doors === undefined) throw new Error("the host is not serving");
    return this.doors;
  }

  /**
   * Make a token for a principal, keep its MAC in the journal, and give the token to the caller.
   * A principal that is given a grant has it recorded with the grant it came from.
   */
  private issue(principal: Principal, opts: { grant?: Grant; parent?: Caller }): Token {
    const doors = this.requireDoors();
    const secret = doors.fresh();
    const id = newRecordId("acc");
    const issued: NewRecord = {
      id,
      stream: streamId("access"),
      type: CORE_TYPES.accessIssued,
      schema: 1,
      data: { mac: doors.macOf(secret), principal },
      actor: { kind: "host" },
      cause: null,
      root: id,
    };
    const parent = opts.parent === undefined ? undefined : this.access.parentOf(opts.parent);
    const granted = opts.grant === undefined ? [] : [this.access.grantRecord(principal, opts.grant, parent)];
    if (this.append([issued, ...granted]).length === 0) throw new Error("the token was not recorded");
    return secret;
  }

  /** The caller of a message of a connection: who its token says it is, and the grant that limits it. */
  private callerOf(connection: Connection): Caller {
    const caller: Caller = { kind: "client", id: connection.caller, principal: connection.principal };
    const grant = this.access.grantIdOf(caller);
    return grant === undefined ? caller : { ...caller, grant };
  }

  /**
   * May this caller write this record type over the wire?
   *
   * An open type is anyone's. A closed one is written by the plugin that declares it, and by a
   * subject whose grant has an `emit:` rule for it. A subject whose grant is closed, or while the
   * switch is off, writes nothing. A type nobody declares is `UnknownType` when written.
   */
  private permitEmit(caller: Caller, type: RecordTypeName): void {
    const standing = this.access.standing(caller);
    const principal = caller.kind === "client" ? caller.principal : undefined;
    const declared = this.declaredType(type);
    const owner = this.typeOwners.get(declared?.name ?? type);
    // A plugin writes its own types: over the wire as its principal, and from a handler of its own.
    const writer = caller.kind === "handler" ? String(caller.handler).split("/")[0] : principal?.kind === "plugin" ? String(principal.id) : undefined;
    const listed = caller.kind === "handler" && this.handlers.get(caller.handler)?.emits.has(declared?.name ?? type) === true;
    const own = listed || (writer !== undefined && writer === String(owner));
    const closed = `"${type}" is closed: only the "${owner}" plugin writes it`;
    let answer: Permit;
    if (standing.kind === "closed" || standing.kind === "off") {
      answer = permit(standing, "emit", type);
    } else if (declared === undefined || declared.open === true || own) {
      answer = { allowed: true };
    } else {
      const found = standing.kind === "limited" ? permit(standing, "emit", type) : undefined;
      answer =
        found === undefined
          ? { allowed: false, reason: closed }
          : found.allowed
            ? found
            : { ...found, reason: found.reason === "ask" ? "ask" : closed };
    }
    const decision = this.access.decided(caller, standing, "emit", type, answer);
    if (!answer.allowed) throw new DeniedError(answer.reason, this.detailsOf(answer, decision));
  }

  /**
   * The question of a rule that asks, for a call a client makes at the door: an answer in
   * force settles it; else the plugin that asks for the host puts it to the owner and the call
   * waits. Nobody to ask, or a question that could not be asked, is no answer.
   */
  private askOwner(): Ask {
    return async (question) => {
      if (this.access.answeredRun(question)) return "run";
      const asker = [...this.plugins.values()].reverse().find((entry) => entry.asker !== undefined)?.asker;
      if (asker === undefined) return "unanswered";
      let outcome: AskOutcome;
      try {
        outcome = await asker(question, timestamp(this.clock.now()));
      } catch {
        return "unanswered";
      }
      if (outcome !== "refused" && outcome !== "unanswered") this.access.answered(question, outcome);
      return outcome;
    };
  }

  /**
   * One `verb` on one `name` of a caller, held to its grant: the decision is recorded, a refusal throws.
   * A call under a rule that asks puts the question to the owner as a call at the door does; an
   * emit or a read under such a rule is a denial.
   */
  private async authorize(caller: Caller, verb: Verb, name: string, how?: AuthorizeHow): Promise<void> {
    const standing = this.access.standing(caller);
    const found = verb === "call" ? this.actionOf(actionName(name)) : undefined;
    const checked = found?.input.safeParse(how?.input);
    const input = checked?.success === true ? checked.data : how?.input;
    const target = found?.target === undefined || checked?.success !== true ? undefined : found.target(checked.data);
    let answer = permit(standing, verb, name, target);
    if (verb === "call") {
      answer = await settleAsk(answer, {
        caller,
        name,
        input,
        ask: this.askOwner(),
        ...(target === undefined ? {} : { target }),
        ...(how?.reason === undefined ? {} : { reason: how.reason }),
      });
    }
    const decision = this.access.decided(caller, standing, verb, name, answer);
    if (!answer.allowed) throw new DeniedError(answer.reason, this.detailsOf(answer, decision));
  }

  private detailsOf(answer: Extract<Permit, { allowed: false }>, record: RecordId | undefined): DeniedDetails | undefined {
    if (answer.grant === undefined || answer.missing === undefined) return undefined;
    return { grant: answer.grant, missing: answer.missing, ...(record === undefined ? {} : { record }) };
  }

  issueToken(principal: Principal, opts?: { grant?: Grant; parent?: Caller }): Token {
    return this.issue(principal, opts ?? {});
  }

  /**
   * A trigger is waited for, so something has to produce it: a handler of a filtered type whose
   * record type no installed plugin declares would wait forever, and the host says so before it
   * serves. A plain type is not checked: its records may come from a client or another host.
   */
  private requireProviders(): void {
    // What a plugin offers is read by another: an offer to a reader that is not installed would be lost.
    for (const [name, entry] of this.plugins) {
      for (const { key } of entry.offers) {
        // The host reads the points that name it: no plugin has to be installed to read them.
        if (key.reader !== HOST_READER && !this.plugins.has(pluginName(key.reader))) {
          throw new MissingReader(name, key.name, key.reader);
        }
      }
    }
    const declared = new Set<string>();
    for (const entry of this.plugins.values()) for (const type of entry.types) declared.add(type.name);
    for (const [name, entry] of this.plugins) {
      for (const handler of entry.handlers) {
        if (handler.trigger === undefined || declared.has(handler.type.name) || CORE_TYPE_NAMES.has(handler.type.name)) continue;
        throw new MissingProvider(name, handler.name, handler.type.name, handler.trigger.provider ?? handler.type.provider);
      }
      // What a handler needs from another plugin is checked for every handler, filtered or not.
      for (const handler of entry.handlers) {
        for (const needed of handler.requires) {
          if (declared.has(needed.name) || CORE_TYPE_NAMES.has(needed.name)) continue;
          throw new MissingProvider(name, handler.name, needed.name, needed.provider, "needs");
        }
      }
    }
  }

  /** Run the invocations that were not finished when the host stopped. */
  private resume(journal: Journal): void {
    const states = latestStates(journal);
    for (const row of journal.find({ type: CORE_TYPES.invocationAdmitted })) {
      const state = states.get(row.id);
      if (state === "done") continue;
      const spec = this.specOf(journal, row);
      if (spec === undefined) continue;
      // A paused invocation is unfinished: it holds its place in its subscription until it is decided.
      this.hold(spec.handlerId, spec.invocation);
      if (state !== "paused") this.schedule(spec);
    }
  }

  /** The spec of an invocation, read from its admitted record. */
  private specOf(
    journal: Journal,
    admitted: StoredRecord,
    known?: StoredRecord,
  ): RunSpec | undefined {
    const data = AdmittedData.safeParse(admitted.data);
    if (!data.success) return undefined;
    const woken = known ?? journal.get(recordId(data.data.record));
    if (woken === undefined) return undefined;
    const handler = handlerIdOf(data.data.handler);
    const invocation = invocationId(handler, woken.id);
    // The version it was admitted on, unless the owner moved it since: the last move wins.
    const moved = MovedData.safeParse(
      journal.find({ type: CORE_TYPES.invocationMoved, field: "invocation", equals: invocation }).at(-1)?.data,
    );
    return {
      invocation,
      handlerId: handler,
      record: woken,
      version: pluginVersion(moved.success ? moved.data.to : data.data.pluginVersion),
    };
  }

  // --- admission -------------------------------------------------------------

  /** Look for new work, once after the current step of the event loop. */
  private requestPump(): void {
    if (this.pumpQueued || this.journal === undefined) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      const journal = this.journal;
      if (journal === undefined) return;
      try {
        this.pump(journal);
      } catch (error) {
        this.fail("admission", error);
      }
    });
  }

  /**
   * Admit the records that no subscription has seen yet. Runs to the end without waiting.
   *
   * A subscription reads the records of its type after its position. A record it admits moves the
   * position in the same commit as the admission, which carries it. A record it passes over — the
   * filter does not hold, another version of the schema, a chain its own invocations caused — moves
   * the position too, by one position record for the stretch it passed with the reason of the last
   * one, so a restart does not read them again. A subscription that has as many unfinished
   * invocations as it may have stops before the next record it would admit, and goes on when one
   * of them is done.
   */
  private pump(journal: Journal): void {
    this.readSubscribers(journal);
    for (const [id, entry] of this.handlers) {
      const subscribing = entry.subscribing;
      let after = this.positions.get(id) ?? this.loadPosition(journal, id, entry.types, subscribing.from);
      if (entry.until !== undefined && after >= entry.until) continue;
      let passed: { seq: Seq; reason: PassReason } | undefined;
      for (const record of journal.query({ types: entry.types, from: after })) {
        if (entry.until !== undefined && record.seq > entry.until) break;
        // The positions of subscriptions are their own bookkeeping: no subscription is woken by one, and
        // passing over one writes nothing, or two subscriptions of the family would answer each other.
        if (record.type === CORE_TYPES.subscriptionPosition) {
          after = record.seq;
          continue;
        }
        const reason = this.passOver(journal, id, entry, record);
        if (reason !== undefined) {
          after = record.seq;
          passed = { seq: record.seq, reason };
          continue;
        }
        if ((this.active.get(id)?.size ?? 0) >= subscribing.concurrency) break;
        const spec = this.admit(journal, id, entry.version, record);
        after = record.seq;
        this.keep(id, record.seq);
        if (spec !== undefined) {
          this.hold(id, spec.invocation);
          this.schedule(spec);
        }
      }
      this.positions.set(id, after);
      if (passed !== undefined && passed.seq > (this.kept.get(id) ?? seq(0))) this.writePosition(id, passed.seq, passed.reason);
    }
  }

  /** Why a subscription does not admit a record of its type, or nothing when it admits it. */
  private passOver(
    journal: Journal,
    id: HandlerId,
    entry: Served,
    record: StoredRecord,
  ): PassReason | undefined {
    // A record of another version of the type is not this handler's business: it is passed over and
    // stays readable, because the journal is the history of what happened.
    if (entry.schema !== undefined && record.schema !== entry.schema) return "schema";
    if (!entry.selectors.some((one) => selectsType(one, record.type) && holds(record.data, one.filter))) return "filtered";
    const chain = this.ownChain(journal, id, record);
    if (chain.length > entry.subscribing.depth) {
      if (entry.subscribing.depth === 0) return "self";
      console.error(
        `niwa: ${id} is not woken by ${record.id}: its own invocations caused it ${String(chain.length)} times, past its depth ${String(entry.subscribing.depth)} (${chain.join(" <- ")})`,
      );
      return "reentry";
    }
    return undefined;
  }

  /**
   * The records on a record's chain of causes, itself first, that the subscription's own invocations
   * wrote: what it would be woken by again if it were woken by this one.
   */
  private ownChain(journal: Journal, id: HandlerId, record: StoredRecord): RecordId[] {
    const own: RecordId[] = [];
    for (let row: StoredRecord | undefined = record; row !== undefined; row = row.cause === null ? undefined : journal.get(row.cause)) {
      if (row.actor.kind === "handler" && row.actor.handler === id) own.push(row.id);
    }
    return own;
  }

  /** Count an invocation among the unfinished ones of its subscription. */
  private hold(id: HandlerId, invocation: InvocationId): void {
    const set = this.active.get(id) ?? new Set<InvocationId>();
    set.add(invocation);
    this.active.set(id, set);
    this.activeOf.set(invocation, id);
  }

  /** An invocation is done: its place in its subscription is free, and the next record may start. */
  private release(invocation: InvocationId): void {
    const id = this.activeOf.get(invocation);
    if (id === undefined) return;
    this.activeOf.delete(invocation);
    this.active.get(id)?.delete(invocation);
    this.requestPump();
  }

  /** The position a subscription has kept in the journal moved to here. */
  private keep(id: HandlerId, at: Seq): void {
    if (at > (this.kept.get(id) ?? seq(0))) this.kept.set(id, at);
  }

  /** Record that a subscription has looked up to a position, and why it admitted nothing on the way. */
  private writePosition(id: HandlerId, at: Seq, reason: PassReason): void {
    this.append([
      {
        id: newRecordId("pos"),
        stream: streamId(`subscription:${id}`),
        type: CORE_TYPES.subscriptionPosition,
        schema: 1,
        data: { subscription: id, seq: at, reason },
        actor: { kind: "host" },
        cause: null,
        root: recordId(`subscription:${id}`),
      },
    ]);
    this.keep(id, at);
  }

  /** Read the positions of the subscriptions, and place the new ones where they start. */
  private placeSubscriptions(journal: Journal): void {
    this.readSubscribers(journal);
    for (const [id, entry] of this.handlers) {
      if (!this.positions.has(id)) this.loadPosition(journal, id, entry.types, entry.subscribing.from);
    }
  }

  /**
   * The subscriptions the plugins read from the journal, served as handlers are: each under the name
   * of its plugin, pinned on the plugin's version so an invocation it admitted runs after a restart.
   * One that is no longer read admits nothing more; what it admitted finishes.
   */
  private readSubscribers(journal: Journal): void {
    for (const id of this.dynamic) this.handlers.delete(id);
    this.dynamic.clear();
    for (const [name, installed] of this.plugins) {
      for (const read of installed.subscribers) {
        let found: readonly Subscriber[];
        try {
          found = read();
        } catch (error) {
          this.fail(`reading the subscribers of "${name}"`, error);
          continue;
        }
        for (const one of found) {
          if (one.id.includes("/")) {
            this.fail(`reading the subscribers of "${name}"`, new TypeError(`a subscriber's id has no "/": "${one.id}"`));
            continue;
          }
          const id = handlerIdOf(`${name}/${one.id}`);
          if (this.handlers.has(id)) continue;
          const subscribing = subscribingOf(`plugin "${name}", subscriber "${one.id}"`, {
            ...(one.concurrency === undefined ? {} : { concurrency: one.concurrency }),
          });
          const selectors = one.queries.map((query) => ({ types: query.types.map((type) => recordTypeName(type)), filter: query.filter }));
          this.handlers.set(id, {
            types: [...new Set(selectors.flatMap((query) => query.types))],
            selectors,
            schema: undefined,
            version: installed.version,
            handler: one.handler,
            subscribing: { ...subscribing, from: seq(one.from) },
            emits: new Set(),
            ...(one.until === undefined ? {} : { until: seq(one.until) }),
          });
          this.dynamic.add(id);
          this.pinned.set(pinKey(id, installed.version), {
            handler: one.handler,
            type: { kind: "record", name: recordTypeName(one.id), version: 1, schema: ANY_DATA },
          });
        }
      }
    }
    void journal;
  }

  /**
   * Commit the admission of one record by one handler. When it was admitted before, on another
   * version, the committed one wins: the invocation runs on the version it was admitted on.
   */
  private admit(
    journal: Journal,
    handler: HandlerId,
    version: PluginVersion,
    record: StoredRecord,
  ): RunSpec | undefined {
    const invocation = invocationId(handler, record.id);
    const admitted: NewRecord = {
      id: recordId(invocation),
      stream: streamId(`invocation:${invocation}`),
      type: CORE_TYPES.invocationAdmitted,
      schema: 1,
      data: {
        invocation,
        handler,
        record: record.id,
        recordSeq: record.seq,
        recordType: record.type,
        pluginVersion: version,
      },
      actor: { kind: "host" },
      cause: record.id,
      root: record.root,
    };
    let committed: StoredRecord | undefined;
    try {
      committed = this.append([admitted])[0];
    } catch (error) {
      if (!(error instanceof IntegrityError)) throw error;
      committed = journal.get(admitted.id);
    }
    return committed === undefined ? undefined : this.specOf(journal, committed, record);
  }

  /**
   * The position of a subscription, from the journal: the later of its last position record and its
   * last admission. A subscription with neither is new: it starts at the beginning of the journal,
   * or where the journal is now, written down once so a restart does not move it.
   */
  private loadPosition(journal: Journal, id: HandlerId, types: readonly RecordTypeName[], from: SubscriptionStart | Seq): Seq {
    let position = seq(0);
    let known = false;
    const last = PositionData.safeParse(
      journal.find({ type: CORE_TYPES.subscriptionPosition, field: "subscription", equals: id }).at(-1)?.data,
    );
    if (last.success) {
      position = seq(last.data.seq);
      known = true;
    }
    const rows = journal.find({ type: CORE_TYPES.invocationAdmitted, field: "handler", equals: id });
    for (const row of rows) {
      const data = AdmittedWithPosition.safeParse(row.data);
      if (!data.success) continue;
      if (!selectsType({ types }, data.data.recordType)) continue;
      known = true;
      if (data.data.recordSeq > position) position = seq(data.data.recordSeq);
    }
    if (!known && typeof from === "number") position = from;
    this.positions.set(id, position);
    this.keep(id, position);
    if (!known && from === "now" && journal.last() > 0) {
      position = journal.last();
      this.positions.set(id, position);
      this.writePosition(id, position, "installed");
    }
    return position;
  }

  // --- running ---------------------------------------------------------------

  /** Run an invocation, or run it once more after the current run when it is running. */
  private schedule(spec: RunSpec, woken = false): void {
    const running = this.running.get(spec.invocation);
    if (running !== undefined) {
      // The run that follows is a wake only when everything that asked for it was one.
      running.woken = running.again ? running.woken && woken : woken;
      running.again = true;
      return;
    }
    const entry = { again: false, woken };
    this.running.set(spec.invocation, entry);
    void (async () => {
      // Not inside the call that scheduled it: that call may be in the middle of a commit.
      await Promise.resolve();
      try {
        do {
          entry.again = false;
          await this.execute(spec, entry.woken);
        } while (entry.again && this.journal !== undefined);
      } finally {
        this.running.delete(spec.invocation);
      }
    })();
  }

  /** One run of an invocation. Never throws: what goes wrong is written down or reported. */
  private async execute(spec: RunSpec, woken: boolean): Promise<void> {
    const journal = this.journal;
    if (journal === undefined) return;
    this.unpark(spec.invocation);
    try {
      const pinned = this.pinned.get(pinKey(spec.handlerId, spec.version));
      if (pinned === undefined) {
        this.append([
          this.stateRecord(
            spec,
            "paused",
            `plugin version unavailable: version ${spec.version} of ${spec.handlerId} is not kept; move it onto the installed version with ${MOVE_ACTION}, or cancel it`,
            ["cancel"],
          ),
        ]);
        return;
      }
      const before = journal.last();
      const result = await runInvocation(this.deps(journal), {
        id: spec.invocation,
        handlerId: spec.handlerId,
        record: spec.record,
        handler: pinned.handler,
        parse: (data: unknown) => pinned.type.schema.parse(data),
        woken,
      });
      if (result === "waiting") this.park(journal, spec, before);
    } catch (error) {
      if (this.journal === undefined) return; // the host is closed: nothing to say it to
      if (error instanceof LostOwnership) {
        this.fail(`running ${spec.invocation}`, error);
        return;
      }
      // Any other failure of the host is recorded as a pause, so an owner sees it.
      const reason = `host error: ${error instanceof Error ? error.message : String(error)}`;
      try {
        this.append([this.stateRecord(spec, "paused", reason)]);
      } catch (writeError) {
        this.fail(`recording the failure of ${spec.invocation}`, writeError);
      }
    }
  }

  /**
   * An invocation suspended on a wait: remember what it waits for, so the record wakes it.
   * A record of that type committed while it was still running would find nobody waiting: it
   * is looked for here, in the same step, so no wake is lost.
   *
   * A wait may name one type or several: a wait for the first of several types is woken by any
   * of them.
   */
  private park(journal: Journal, spec: RunSpec, before: Seq): void {
    const intents = journal.find({
      type: CORE_TYPES.stepIntent,
      field: "invocation",
      equals: spec.invocation,
    });
    // Every wait that has no outcome is open: the invocation may be suspended on several at
    // once (parallel steps that each wait), and a record that answers any of them must wake it.
    // Only the last one would lose the wake of the others: two asks in parallel wait for the same
    // type under different keys.
    const slots = new Map<string, WaitSlot>();
    for (const row of intents) {
      const data = IntentData.safeParse(row.data);
      if (!data.success || data.data.key === undefined) continue;
      const open = slotsOf(data.data);
      if (open.length === 0) continue;
      if (journal.get(attemptRecordId(spec.invocation, stepKey(data.data.key), 0, "outcome")) !== undefined) continue;
      for (const slot of open) slots.set(indexSlot(slot.type, slot.key), slot);
    }
    if (slots.size === 0) return;
    // A record that arrived while it ran wakes it only if it can match one of the waits.
    const arrived = [...slots.values()].some((slot) =>
      journal.find({ type: slot.type, after: before }).some((row) => admits(slot.key, row.data)),
    );
    if (arrived) {
      this.schedule(spec, true);
      return;
    }
    this.index(spec, [...slots.values()]);
  }

  /**
   * A wait begun after its invocation was parked: a parallel branch of the handler that was still
   * going when another branch suspended it. The run has ended, so park() did not see this wait;
   * it is indexed here, or the record that answers it would wake nobody.
   */
  private parkLate(record: StoredRecord): void {
    const data = IntentData.safeParse(record.data);
    if (!data.success || data.data.invocation === undefined) return;
    const waiting = this.waiting.get(data.data.invocation as InvocationId);
    if (waiting === undefined) return;
    this.index(waiting.spec, slotsOf(data.data));
  }

  /** Put a waiting invocation in the index under the slots it waits on, besides those it has. */
  private index(spec: RunSpec, added: readonly WaitSlot[]): void {
    const had = this.waiting.get(spec.invocation)?.slots ?? [];
    const known = new Set(had.map((slot) => indexSlot(slot.type, slot.key)));
    // A slot listed twice (a wait for the same type twice) is indexed once: unpark undoes each slot
    // it holds, so the counts of the fields stay in step with the slots.
    const fresh = added.filter((slot) => {
      const name = indexSlot(slot.type, slot.key);
      if (known.has(name)) return false;
      known.add(name);
      return true;
    });
    this.waiting.set(spec.invocation, { slots: [...had, ...fresh], spec });
    for (const { type, key } of fresh) {
      const slot = indexSlot(type, key);
      const set = this.waitIndex.get(slot) ?? new Set<InvocationId>();
      set.add(spec.invocation);
      this.waitIndex.set(slot, set);
      if (key === undefined) continue;
      const fields = this.waitFields.get(type) ?? new Map<string, number>();
      fields.set(key.field, (fields.get(key.field) ?? 0) + 1);
      this.waitFields.set(type, fields);
    }
  }

  /** Forget a waiting invocation: it is running, moved, or woken. */
  private unpark(invocation: InvocationId): void {
    const waiting = this.waiting.get(invocation);
    if (waiting === undefined) return;
    this.waiting.delete(invocation);
    for (const { type, key } of waiting.slots) {
      const slot = indexSlot(type, key);
      const set = this.waitIndex.get(slot);
      set?.delete(invocation);
      if (set?.size === 0) this.waitIndex.delete(slot);
      if (key === undefined) continue;
      const fields = this.waitFields.get(type);
      const left = (fields?.get(key.field) ?? 1) - 1;
      if (left > 0) fields?.set(key.field, left);
      else fields?.delete(key.field);
      if (fields?.size === 0) this.waitFields.delete(type);
    }
  }

  /** The waiters a record can wake: those without a key on its type, and those whose key it carries. */
  private waitersOf(record: StoredRecord): InvocationId[] {
    const found = new Set<InvocationId>(this.waitIndex.get(indexSlot(record.type, undefined)));
    const data = record.data as Record<string, unknown> | null;
    for (const field of this.waitFields.get(record.type)?.keys() ?? []) {
      const value = data?.[field];
      if (typeof value !== "string") continue;
      for (const id of this.waitIndex.get(indexSlot(record.type, { field, equals: value })) ?? []) found.add(id);
    }
    return [...found];
  }

  private invocationRecord(
    spec: RunSpec,
    prefix: string,
    type: RecordTypeName,
    data: object,
    actor: Caller = { kind: "host" },
  ): NewRecord {
    return {
      id: newRecordId(prefix),
      stream: streamId(`invocation:${spec.invocation}`),
      type,
      schema: 1,
      data,
      actor,
      cause: spec.record.id,
      root: spec.record.root,
    };
  }

  private stateRecord(spec: RunSpec, state: string, reason: string, choices?: string[]): NewRecord {
    return this.invocationRecord(spec, "st", CORE_TYPES.invocationState, {
      invocation: spec.invocation,
      state,
      reason,
      ...(choices === undefined ? {} : { choices }),
    });
  }

  private deps(journal: Journal): RunnerDeps {
    return {
      journal,
      now: () => this.clock.now(),
      append: (records) => this.append(records),
      appendAll: (entries) => this.appendAll(entries),
      resolveAction: (name) => this.resolveActionByName(name),
      interceptsOf: (name) => {
        try {
          return this.intercepts.get(actionName(name)) ?? NO_INTERCEPTS;
        } catch {
          return NO_INTERCEPTS; // not a valid name: no such action
        }
      },
      emit: (action, type, data, caller, place) => this.emitAs(action, type, data, caller, place),
      admitEmit: (caller, name, data) => {
        const declared = this.declaredType(name);
        if (declared === undefined) throw new UnknownType(name);
        this.permitEmit(caller, name);
        const parsed = declared.schema.safeParse(data);
        if (!parsed.success) throw new ValidationError(`the data of "${name}" is not valid`, parsed.error.issues);
        return { data: parsed.data, version: declared.version };
      },
    };
  }

  /** A failure nobody is waiting for: the journal was taken over, or it is told to the operator. */
  private fail(what: string, error: unknown): void {
    if (error instanceof LostOwnership) {
      // The journal was taken over: this host is no longer the writer and writes nothing more.
      console.error(`niwa: ${error.name}: lost the journal of ${this.home}: ${error.message}; this host stops`);
      void this.close();
    } else if (this.journal !== undefined) {
      console.error(`niwa: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- writing ---------------------------------------------------------------

  /** Commit the records, then publish them. */
  private append(records: NewRecord[]): StoredRecord[] {
    return this.appendAll(records.map((record) => ({ record })));
  }

  /** Commit the records with their links, then publish them. */
  private appendAll(entries: AppendEntry[]): StoredRecord[] {
    const committed = this.requireJournal().appendAll(entries);
    // What a record of access says takes effect before anything that watches the journal reacts.
    for (const row of committed) if (ACCESS_TYPES.has(row.type)) this.doors?.fold(row);
    this.publish(committed);
    return committed;
  }

  /**
   * Hand committed records to the observers, and wake the work that waits for them.
   *
   * Every record reaches the feeds before anything reacts: a reaction writes records of its own,
   * and those must not overtake the rest of this commit.
   */
  private publish(records: StoredRecord[]): void {
    for (const wake of [...this.commitWaiters]) wake();
    for (const feed of this.feeds) {
      for (const record of records) feed.push(record);
    }
    for (const record of records) {
      if (record.type === CORE_TYPES.stepIntent) this.parkLate(record);
      if (record.type === CORE_TYPES.invocationState) {
        const state = StateData.safeParse(record.data);
        if (state.success && state.data.state === "done") this.release(state.data.invocation as InvocationId);
      }
      if (CORE_TYPE_NAMES.has(record.type)) {
        // A closed grant is the one core record that plugins react to: they stop what it covered.
        if (record.type === CORE_TYPES.accessClosed) this.requestPump();
        continue;
      }
      for (const invocation of this.waitersOf(record)) {
        const waiting = this.waiting.get(invocation);
        if (waiting === undefined) continue;
        this.unpark(invocation);
        this.schedule(waiting.spec, true);
      }
      this.requestPump();
    }
  }

  // --- the public API --------------------------------------------------------

  async emit<T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord> {
    return this.write({ kind: "host" }, type.name, data, opts);
  }

  async trace(id: RecordId): Promise<TracedRecord[]> {
    return trace(this.requireJournal(), id);
  }

  async causes(id: RecordId): Promise<StoredRecord[]> {
    return causes(this.requireJournal(), id);
  }

  async call<I, O, In = I>(target: ActionTarget<I, O, In>, input: NoInfer<In>, opts?: CallOptions): Promise<O> {
    return this.runAction({ kind: "host" }, target, input, false, opts?.reason);
  }

  readonly records = {
    since: (query?: RecordQuery<any>): AsyncIterable<StoredRecord> => this.subscribe(resolveQuery(query)),
    read: async (query?: RecordReadQuery<any>): Promise<StoredRecord[]> => this.readHistory(resolveQuery(query), query?.limit),
  };

  /**
   * The history that answers a query, read once.
   *
   * The read is a plain question to the journal: the records that are committed now, in commit
   * order, and nothing that comes later. It ends by itself, so a reader never has to guess when
   * the history is read.
   */
  private readHistory(query: ResolvedQuery, limit?: number): StoredRecord[] {
    const journal = this.requireJournal();
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new TypeError(`the limit of a read must be a positive integer, got ${String(limit)}`);
    }
    return journal.query(query, limit);
  }

  /**
   * History after a position, then the live records, with no gap and no duplicate. The feed is
   * registered in the same step that reads the history, so nothing is committed in between.
   */
  private async *subscribe(
    query: ResolvedQuery,
    owner?: Set<Feed>,
  ): AsyncGenerator<StoredRecord, void, undefined> {
    const journal = this.requireJournal();
    const feed = new Feed(query);
    this.feeds.add(feed);
    owner?.add(feed);
    try {
      let cursor = query.from ?? seq(0);
      for (const record of journal.query(query)) {
        cursor = record.seq;
        yield record;
      }
      yield* feed.iterate(cursor);
    } finally {
      this.feeds.delete(feed);
      owner?.delete(feed);
    }
  }

  /** What niwa is: the actions and record types the loaded plugins declared. */
  async describe(): Promise<Description> {
    return buildDescription({ actions: this.allActions(), types: this.types.values() });
  }

  readonly live = {
    send: async (channel: string, frame: LiveFrame): Promise<void> => {
      this.liveBus.send(channelName(channel), frameFor(channel, frame));
    },
    subscribe: (channel: string): AsyncIterable<LiveFrame> => this.liveBus.subscribe(channelName(channel)).iterate(),
  };

  /**
   * Write an external input: it starts its own chain.
   *
   * With an explicit id the write is idempotent: the same id with the same content returns the
   * record that is already committed, and the same id with different content is an integrity
   * error that writes nothing. Only a declared type is written: the core's own are not.
   */
  private async write(
    caller: Caller,
    name: RecordTypeName,
    data: unknown,
    opts?: EmitOptions,
  ): Promise<StoredRecord> {
    const declared = this.declaredType(name);
    if (declared === undefined) throw new UnknownType(name);
    const parsed = declared.schema.safeParse(data);
    if (!parsed.success) {
      throw new ValidationError(`the data of "${name}" is not valid`, parsed.error.issues);
    }
    const id = opts?.id === undefined ? newRecordId("rec") : recordId(opts.id);
    const [committed] = this.appendAll([
      {
        record: {
          id,
          stream: streamId(`input:${name}`),
          type: name,
          schema: declared.version,
          data: parsed.data,
          actor: caller,
          cause: null,
          root: id,
        },
        links: opts?.links,
      },
    ]);
    if (committed === undefined) throw new Error("the record was not committed");
    return committed;
  }

  /**
   * The action of this host under this name, when there is one.
   *
   * A name nobody serves is nothing: the caller is told so instead of being given an action
   * that is not there.
   */
  private resolveActionByName(name: string): AnyAction | undefined {
    try {
      return this.actionOf(actionName(name));
    } catch {
      return undefined; // not a valid name: no such action
    }
  }

  /**
   * Write a record on behalf of a call.
   *
   * The record is written under the stream of the caller: a handler's write belongs to the
   * invocation it runs in, and a call outside an invocation starts a chain of its own. The
   * schema of the type is the one that was declared, so the data is checked before it is kept.
   */
  private async emitAs<T>(
    action: ActionName,
    type: RecordType<T>,
    data: T,
    caller: Caller,
    place: Placement,
  ): Promise<StoredRecord> {
    const declared = this.declaredType(type.name);
    if (declared === undefined || this.typesOfAction(action)?.has(declared.name) !== true) {
      throw new UnknownType(type.name);
    }
    const parsed = declared.schema.safeParse(data);
    if (!parsed.success) {
      throw new ValidationError(`the data of "${type.name}" is not valid`, parsed.error.issues);
    }
    const record: NewRecord = {
      id: place.id,
      stream: place.stream,
      type: type.name,
      schema: declared.version,
      data: parsed.data,
      actor: caller,
      cause: place.cause,
      root: place.root,
    };
    const committed = this.append([record]);
    const first = committed[0];
    if (first === undefined) throw new Error("the record was not committed");
    return first;
  }

  /** Call an action outside any invocation: not a step, not journaled. */
  private async runAction<I, O, In = I>(
    caller: Caller,
    target: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    atDoor = false,
    reason?: string,
  ): Promise<O> {
    const result = await this.outsideCall<I, O, In>(caller, target, input, atDoor, reason);
    switch (result.kind) {
      case "completed":
        return result.value;
      case "unknown-action":
        throw new UnknownAction(result.action);
      case "denied":
        throw new DeniedError(result.reason, result.denied);
      case "invalid-input":
      case "invalid-output":
        throw new ValidationError(result.message, result.issues);
    }
  }

  /**
   * The call itself: the action runs, and what it ended with is here.
   *
   * `atDoor` is the call a client made over the socket: its grant decides it. What an action calls
   * inside itself is the plugin's own work and is not matched against the caller's grant again.
   */
  private async outsideCall<I, O, In = I>(
    caller: Caller,
    target: ActionTarget<I, O, In>,
    input: NoInfer<In>,
    atDoor = false,
    reason?: string,
  ): Promise<OutsideCall<O>> {
    const name = targetName(target);
    const found = this.actionOf(name);
    if (found === undefined) {
      // A subject that may not call a name is not told whether it exists.
      const standing = atDoor ? this.access.standing(caller) : undefined;
      const answer = standing === undefined ? undefined : permit(standing, "call", name);
      if (standing === undefined || answer === undefined || answer.allowed) return { kind: "unknown-action", action: name };
      const record = this.access.decided(caller, standing, "call", name, answer);
      const denied = this.detailsOf(answer, record);
      return { kind: "denied", reason: answer.reason, ...(denied === undefined ? {} : { denied }) };
    }
    // The same point every call passes through: the intercepts decide, and a call that was denied
    // is refused with the code "Denied".
    const standing = atDoor ? this.access.standing(caller) : undefined;
    const decision = await decide({
      intercepts: this.intercepts.get(name) ?? NO_INTERCEPTS,
      action: found,
      input,
      caller,
      ...(standing === undefined ? {} : { standing, ask: this.askOwner() }),
      ...(reason === undefined ? {} : { reason }),
    });
    // A subject a grant limits has every decision written down, whether it ran or not.
    const written =
      standing === undefined || decision.kind === "invalid"
        ? undefined
        : this.access.decided(
            caller,
            standing,
            "call",
            name,
            decision.access ?? (decision.kind === "denied" ? { allowed: false, reason: decision.reason } : { allowed: true }),
          );
    if (decision.kind === "invalid") {
      return {
        kind: "invalid-input",
        // The wire carries only the message, so what the schema said goes in it: a caller that
        // is told only "not valid" cannot tell which field to fix.
        message: refusalMessage(name, decision.issues),
        issues: decision.issues,
      };
    }
    if (decision.kind === "denied") {
      const denied = decision.access === undefined ? undefined : this.detailsOf(decision.access, written);
      return { kind: "denied", reason: decision.reason, ...(denied === undefined ? {} : { denied }) };
    }
    const operation = newOperationId();
    let ordinal = 0;
    const output = await found.run(decision.final, {
      operationId: operation,
      caller,
      ...(decision.access?.allowed === true && decision.access.answered !== undefined ? { answered: decision.access.answered } : {}),
      // A call outside an invocation starts a chain of its own: the first record has no cause
      // and is its own root, and the later ones of the same call belong to it. Every record
      // after the first hangs on the one before it, so the trace down from the root reaches
      // all of them.
      emit: async <T>(type: RecordType<T>, data: T): Promise<StoredRecord> => {
        ordinal += 1;
        return this.emitAs(name, type, data, caller, {
          id: recordId(`${operation}/emit/${ordinal}`),
          stream: streamId(`input:${type.name}`),
          cause: ordinal === 1 ? null : recordId(`${operation}/emit/${ordinal - 1}`),
          root: recordId(`${operation}/emit/1`),
        });
      },
      // A call outside an invocation has no invocation to suspend, so it cannot wait. The
      // answer is looked for and its absence is reported: the caller asked for something that
      // is not there, and that is said rather than waited for.
      wait: async <T>(type: RecordType<T>, query?: WaitQuery<T>): Promise<Waited<T>> => {
        const entry = { type, ...(query?.filter === undefined ? {} : { filter: query.filter }) };
        const found = findWaited(this.requireJournal(), [entry], query?.from ?? seq(0));
        if (found === undefined) throw new Error(`no record of "${type.name}" has arrived`);
        return { data: found.data as T, at: found.at };
      },
      // A call outside an invocation cannot wait either: the answer is looked for and its
      // absence is reported. The oldest record of the types that matches is the answer.
      waitAnyOf: async <Entries extends readonly WaitEntry<any>[]>(
        entries: Entries,
        opts?: { readonly from?: Seq },
      ): Promise<AnyWaited<Entries[number]["type"]>> => {
        const found = findWaited(this.requireJournal(), entries, opts?.from ?? seq(0));
        if (found !== undefined) return found as AnyWaited<Entries[number]["type"]>;
        throw new Error(`no record of ${entries.map((entry) => `"${entry.type.name}"`).join(" or ")} has arrived`);
      },
      // A call made inside a call outside an invocation is a call outside an invocation too:
      // there is no invocation to record it in, so it goes through the same point as any other
      // call, with the same caller.
      step: this.outsideStep(caller),
    });
    const checked = found.output.safeParse(output);
    if (!checked.success) {
      return {
        kind: "invalid-output",
        message: `the output of "${name}" is not valid`,
        issues: checked.error.issues,
      };
    }
    return { kind: "completed", value: checked.data };
  }

  /**
   * The step an action is given outside an invocation.
   *
   * There is no invocation to record the call in, so it is a direct call: it goes through the
   * same point as any other call, with the same caller, and it is not durable — as direct calls
   * are today. The records it writes hang on the record before it, as the records of any other
   * call outside an invocation do.
   */
  private outsideStep(caller: Caller): ActionStep {
    const call = async <I, O, In = I>(
      target: ActionTarget<I, O, In>,
      input: NoInfer<In>,
    ): Promise<O> => {
      const result = await this.outsideCall<I, O, In>(caller, target, input);
      switch (result.kind) {
        case "completed":
          return result.value;
        case "unknown-action":
          throw new UnknownAction(result.action);
        case "denied":
          throw new DeniedError(result.reason);
        case "invalid-input":
        case "invalid-output":
          throw new ValidationError(result.message, result.issues);
      }
    };
    return Object.assign(call, {
      outcome: async <I, O, In = I>(
        target: ActionTarget<I, O, In>,
        input: NoInfer<In>,
      ): Promise<Outcome<O>> => {
        let result: Awaited<ReturnType<typeof this.outsideCall<I, O, In>>>;
        try {
          result = await this.outsideCall<I, O, In>(caller, target, input);
        } catch (error) {
          // An error the caller catches belongs to the code that called the action, here as in an
          // invocation.
          if (error instanceof CatchableError) throw error;
          // An action that throws is a failed outcome, as it is for a step inside an invocation:
          // the code asked for the outcome, not for an exception.
          return { status: "failed", error: error instanceof Error ? error.message : String(error), effectPossible: true };
        }
        switch (result.kind) {
          case "completed":
            return { status: "completed", value: result.value };
          case "denied":
            return { status: "denied", reason: result.reason };
          case "unknown-action":
            return {
              status: "failed",
              error: new UnknownAction(result.action).message,
              effectPossible: false,
            };
          // The body never started: nothing can have happened.
          case "invalid-input":
            return { status: "failed", error: result.message, effectPossible: false };
          // The body ran and its answer was refused: what it did may have happened.
          case "invalid-output":
            return { status: "failed", error: result.message, effectPossible: true };
        }
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // A read that waits for a commit is let go: the host serves no more.
    for (const wake of [...this.commitWaiters]) wake();
    // Bun removes the socket path when a listener stops, so a listener is stopped only while
    // the file on the path is still this host's: after a take-over it is the new holder's.
    const owned = this.ownsSocketFile();
    if (owned) this.server?.stop(true);
    this.server = undefined;
    for (const connection of this.connections) connection.drop();
    this.connections.clear();
    for (const feed of this.feeds) feed.close();
    this.feeds.clear();
    this.liveBus.close();
    this.waiting.clear();
    this.waitIndex.clear();
    this.waitFields.clear();
    // The services stop before the journal closes: a service that is still writing must find the
    // journal open, and a service that writes after the close would fail for no good reason.
    for (const name of [...this.stoppers.keys()]) this.stopServicesOf(name);
    // A service that owns processes releases them asynchronously: the host waits for it, so no
    // child of the host outlives the host.
    while (this.stopping.length > 0) {
      await Promise.all(this.stopping.splice(0));
    }
    this.journal?.close();
    this.journal = undefined;
    this.doors = undefined;
    this.socketFile = undefined;
  }

  /** Is the socket file on the path still the one this host bound? */
  private ownsSocketFile(): boolean {
    return this.socketFile !== undefined && socketIdentity(socketPath(this.home)) === this.socketFile;
  }

  // --- the socket ------------------------------------------------------------

  private async handleMessage(connection: Connection, raw: unknown): Promise<void> {
    let message;
    try {
      message = decodeClientMessage(raw);
    } catch (error) {
      const id = requestIdOf(raw);
      if (id !== undefined) refuse(connection, id, error);
      return;
    }
    const caller = this.callerOf(connection);
    switch (message.op) {
      case "hello":
        if (connection.greet(message.client, this.doors?.holderOf(message.token))) {
          connection.send({ id: message.id, ok: true, value: { client: connection.caller } });
        } else {
          refuse(connection, message.id, new Error("this connection said hello already"));
        }
        return;
      case "call": {
        const { action: target, input } = message;
        return reply(connection, message.id, async () => {
          return this.runAction(caller, target, input, true, message.reason);
        });
      }
      case "emit": {
        const { type, data, record, links } = message;
        return reply(connection, message.id, async () => {
          this.permitEmit(caller, type);
          return this.write(caller, type, data, { id: record, links });
        });
      }
      case "trace":
        return reply(connection, message.id, async () => {
          await this.authorize(caller, "call", TRACE_ACTION);
          return this.trace(message.record);
        });
      case "causes":
        return reply(connection, message.id, async () => {
          await this.authorize(caller, "call", CAUSES_ACTION);
          return this.causes(message.record);
        });
      case "describe":
        return reply(connection, message.id, () => this.describe());
      case "live.send": {
        const { channel, data } = message;
        return reply(connection, message.id, async () => {
          this.liveBus.send(channel, { channel, data });
          return null;
        });
      }
      case "live.subscribe": {
        const { id, channel } = message;
        // Registered before the answer goes out: a frame sent right after it is not lost.
        const feed = this.liveBus.subscribe(channel);
        connection.liveFeeds.add(feed);
        connection.send({ id, ok: true, value: null });
        try {
          for await (const frame of feed.iterate()) {
            if (!connection.isOpen) break;
            connection.sendLive({ id, frame });
          }
        } finally {
          feed.close();
          connection.liveFeeds.delete(feed);
        }
        return;
      }
      case "read": {
        const { query, limit } = message;
        return reply(connection, message.id, async () => {
          await this.authorize(caller, "call", RECORDS_READ_ACTION);
          return this.readHistory(resolveQuery(query), limit);
        });
      }
      case "since": {
        const { id, query } = message;
        // The subscription is a read of the same journal: it is held to the same grant, and a
        // refusal is the first answer, before any record.
        try {
          await this.authorize(caller, "call", RECORDS_READ_ACTION);
        } catch (error) {
          refuse(connection, id, error);
          return;
        }
        connection.send({ id, ok: true, value: null });
        try {
          for await (const record of this.subscribe(resolveQuery(query), connection.feeds)) {
            if (!connection.isOpen) break;
            connection.send({ id, record });
          }
        } catch {
          connection.end();
        }
        return;
      }
    }
  }
}

/** Answer a request with what the work gives, or say what went wrong. */
async function reply(
  connection: Connection,
  id: number,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    connection.send({ id, ok: true, value: await work() });
  } catch (error) {
    refuse(connection, id, error);
  }
}

/** Tell the client that the request failed, and why. */
function refuse(connection: Connection, id: number, error: unknown): void {
  connection.send({
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof Error ? error.name : undefined,
    ...(error instanceof DeniedError && error.denied !== undefined ? { denied: error.denied } : {}),
  });
}

/** The host: create it with a home directory. */
export function createNiwa(opts: HostOptions): Host {
  return new Niwa(opts);
}

/** Does a value behave as a promise? */
function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** `~` at the start of a home is the home of the user. */
function expandHome(home: string): string {
  if (home === "~") return homedir();
  if (home.startsWith("~/")) return `${homedir()}${home.slice(1)}`;
  return home;
}

/** The device and inode of the socket file on a path; undefined when there is none. */
function socketIdentity(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

/** Is another host listening on this socket? */
async function isLiveSocket(path: string): Promise<boolean> {
  let cancel: (() => void) | undefined;
  try {
    const socket = await Promise.race([
      Bun.connect({ unix: path, socket: { data: () => undefined } }),
      new Promise<never>((_resolve, reject) => {
        // The transport waits on the real clock: the probe is about the socket, not about the
        // domain time of the host, and a clock a test moves by hand must not hang it.
        cancel = TRANSPORT_CLOCK.schedule(Date.now() + 500, () => reject(new Error("timeout")));
      }),
    ]);
    socket.end();
    return true;
  } catch {
    return false;
  } finally {
    cancel?.();
  }
}

/** The most issues, and the most characters, a refusal message carries: keys the caller sent are echoed by the schema. */
const REFUSAL_ISSUES_MAX = 8;
const REFUSAL_TEXT_MAX = 600;

function refusalMessage(
  name: string,
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>,
): string {
  const lines = issues
    .slice(0, REFUSAL_ISSUES_MAX)
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>"}: ${issue.message}`);
  if (issues.length > REFUSAL_ISSUES_MAX) lines.push(`and ${issues.length - REFUSAL_ISSUES_MAX} more`);
  const text = lines.join("; ");
  const shown = text.length > REFUSAL_TEXT_MAX ? `${text.slice(0, REFUSAL_TEXT_MAX)}...` : text;
  return `the input of "${name}" is not valid: ${shown}`;
}
