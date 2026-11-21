/**
 * client.ts — the client side of the niwa wire (see wire.ts for the framing).
 *
 * The call connection carries `emit`, `call`, `trace` and `causes` as request/response pairs
 * keyed by a numeric id; it is reopened on the next call when the host went away. Every
 * subscription has its own socket, where the host streams `{ id, record }`. A subscription
 * keeps the seq of the last record it queued and resubscribes from exactly there after a
 * drop, so the consumer sees no gap and no duplicate.
 */

import type { z } from "zod";

import { expandHome } from "./home.ts";
import { channelName, frameFor } from "./live.ts";
import { resolveQuery, seq, targetName } from "@niwa-labs/core";
import type {
  ActionTarget,
  CallOptions,
  Action,
  ActionName,
  ClientId,
  Description,
  EmitOptions,
  LiveFrame,
  RecordReadQuery,
  RecordQuery,
  ResolvedQuery,
  RecordId,
  RecordType,
  RecordTypeName,
  Seq,
  StoredRecord,
  StreamId,
  TracedRecord,
  Token,
} from "@niwa-labs/core";
import type { NiwaApi } from "./client-types.ts";
import {
  clientMessageSchema,
  decodeHostMessage,
  descriptionSchema,
  encode,
  lineDecoder,
  socketPath,
  storedRecordSchema,
  tracedRecordSchema,
  type HostMessage,
} from "./wire.ts";

/** Delay between reconnect attempts of a subscription whose connection dropped. */
const RECONNECT_INTERVAL_MS = 100;

/**
 * Records a subscription holds for a consumer that reads slowly. Past this the socket is
 * dropped; the cursor stays at the last queued record, so nothing is lost, and the
 * subscription reconnects once the consumer has drained the queue to half of it.
 */
const MAX_QUEUED_RECORDS = 1024;

/** An error reported by the host: `code` is the host's error class name (`UnknownType`, …). */
export class HostError extends Error {
  readonly code: string | undefined;
  /** Set when a grant refused the call: whose grant, and the rule it lacks. */
  readonly denied: { readonly grant: string; readonly missing: string; readonly record?: string } | undefined;

  constructor(message: string, code?: string, denied?: HostError["denied"]) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.denied = denied;
  }
}

const CLOSED_MESSAGE = "the connection to the niwa host is closed";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new HostError(String(error));
}

type ClientMessageInput = z.input<typeof clientMessageSchema>;

/** Read what the host returned with a schema, or refuse it. */
function parseReturned<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HostError(`the host did not return ${what}`);
  return parsed.data;
}

function parseList<S extends z.ZodType>(schema: S, value: unknown, what: string): Array<z.output<S>> {
  if (!Array.isArray(value)) throw new HostError(`the host did not return ${what}`);
  return value.map((entry) => parseReturned(schema, entry, what));
}

/** A query as the wire carries it: plain lists. */
function onWire(query: ResolvedQuery): { types?: string[]; filter?: Record<string, never>; stream?: string; from?: number } {
  return {
    ...(query.types === undefined ? {} : { types: [...query.types] }),
    ...(query.filter === undefined ? {} : { filter: query.filter as Record<string, never> }),
    ...(query.stream === undefined ? {} : { stream: query.stream }),
    ...(query.from === undefined ? {} : { from: query.from }),
  };
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ConnectionOptions {
  readonly home: string;
  readonly client: ClientId;
  /** The token the connection shows in `hello`; without one it is a plain client. */
  readonly token: Token | undefined;
  /** Called for every record of a subscription opened on this connection. */
  readonly onRecord?: (record: StoredRecord) => void;
  /** Called for every live frame of a live subscription opened on this connection. */
  readonly onFrame?: (frame: LiveFrame) => void;
  /**
   * Called when the connection dies for good: the host refused it, or sent something this
   * client cannot read. A plain drop is not fatal — a subscription reconnects from it.
   */
  readonly onFatal?: (error: Error) => void;
}

/** One socket to the host: it owns the request ids, the pending replies and the decoder. */
class WireConnection {
  private readonly options: ConnectionOptions;
  private readonly decoder: (chunk: Uint8Array | string) => void;
  private readonly pending = new Map<number, PendingCall>();
  /** Ids of subscriptions: a refusal of one of these is fatal, not a failed call. */
  private readonly subscriptionIds = new Set<number>();
  private readonly encoder = new TextEncoder();
  private readonly helloId = 1;
  private readonly donePromise: Promise<void>;
  private resolveDone: () => void = () => undefined;
  private socket: Bun.Socket | null = null;
  /** Bytes the full socket did not take yet; counted in bytes, never cut inside a character. */
  private outgoing: Uint8Array = new Uint8Array(0);
  private nextId = this.helloId + 1;
  private isClosed = false;
  /** Why the connection is not usable, when the host named a reason. */
  private lastError: Error | null = null;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.decoder = lineDecoder((message) => this.handleMessage(message), {
      // A line this client cannot frame or parse is half-understood: end the connection.
      onError: (error) => this.die(error, true),
    });
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Resolves when the connection is gone (closed by us or by the host). */
  get done(): Promise<void> {
    return this.donePromise;
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  /** Open the socket and say hello. Rejects when the host is not reachable. */
  async open(): Promise<void> {
    const socket = await Bun.connect({
      unix: socketPath(expandHome(this.options.home)),
      socket: {
        data: (_socket, chunk) => {
          this.decoder(chunk);
        },
        close: () => {
          this.die();
        },
        error: (_socket, error) => {
          this.die(error);
        },
        end: () => {
          this.die();
        },
        drain: () => {
          if (!this.flush()) this.die();
        },
      },
    });
    if (this.isClosed) {
      socket.end();
      return;
    }
    this.socket = socket;
    try {
      this.send({
        id: this.helloId,
        op: "hello",
        client: this.options.client,
        ...(this.options.token === undefined ? {} : { token: this.options.token }),
      });
    } catch (error) {
      // A hello that cannot be built or written leaves a connection nobody holds: close it.
      this.die();
      throw error;
    }
  }

  /** One request/response exchange: `build` gets a fresh request id; the reply is matched by it. */
  request(build: (id: number) => ClientMessageInput): Promise<unknown> {
    if (this.isClosed) return Promise.reject(this.closedError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send(build(id));
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  /** Subscribe to the records that answer a query: the history after its position, then the live ones. */
  subscribe(query: ResolvedQuery): void {
    const id = this.nextId++;
    this.subscriptionIds.add(id);
    this.send({ id, op: "since", query: onWire(query) });
  }

  /** Subscribe to the live frames of a channel. */
  subscribeLive(channel: string): void {
    const id = this.nextId++;
    this.subscriptionIds.add(id);
    this.send({ id, op: "live.subscribe", channel });
  }

  /** Close the connection. Pending calls reject. */
  close(): void {
    this.die();
  }

  /** The wire's own client schema checks every message, so a message built wrong is caught here. */
  private send(input: ClientMessageInput): void {
    if (this.socket === null) throw this.closedError();
    let message: z.output<typeof clientMessageSchema>;
    try {
      message = clientMessageSchema.parse(input);
    } catch (error) {
      throw new HostError(`the client built a message the wire does not accept: ${asError(error).message}`);
    }
    const bytes = this.encoder.encode(encode(message));
    const joined = new Uint8Array(this.outgoing.length + bytes.length);
    joined.set(this.outgoing, 0);
    joined.set(bytes, this.outgoing.length);
    this.outgoing = joined;
    if (!this.flush()) {
      // A write that failed leaves bytes of a request nobody will answer: the connection ends with
      // them, and every request on it fails, so none starts after its caller was told it failed.
      this.die();
      throw this.closedError();
    }
  }

  /** Write as much of the waiting bytes as the socket takes; false when the socket is gone. */
  private flush(): boolean {
    const socket = this.socket;
    if (socket === null) return true;
    try {
      while (this.outgoing.length > 0) {
        const written = socket.write(this.outgoing);
        if (written < 0) return false;
        if (written === 0) return true; // full: the rest waits for the drain
        this.outgoing = this.outgoing.subarray(written);
      }
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(message: unknown): void {
    if (this.isClosed) return; // the rest of a chunk that was read after the connection ended
    let decoded: HostMessage;
    try {
      decoded = decodeHostMessage(message);
    } catch (error) {
      this.die(asError(error), true);
      return;
    }

    if ("record" in decoded) {
      this.options.onRecord?.(decoded.record);
      return;
    }

    if ("frame" in decoded) {
      this.options.onFrame?.({ channel: decoded.frame.channel, data: decoded.frame.data });
      return;
    }

    const pending = this.pending.get(decoded.id);
    this.pending.delete(decoded.id);
    if (decoded.ok) {
      pending?.resolve(decoded.value);
      return;
    }
    const error = new HostError(decoded.error, decoded.code, decoded.denied);
    if (pending !== undefined) {
      pending.reject(error);
    } else if (decoded.id === this.helloId || this.subscriptionIds.has(decoded.id)) {
      // The host will not talk to this client, or refused the subscription: retrying would spin.
      this.die(error, true);
    }
  }

  /** The connection ends: every pending call is rejected at once, so nobody waits on a corpse. */
  private die(error?: Error, fatal = false): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (error !== undefined) this.lastError = error;
    const reason = this.closedError();
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    this.outgoing = new Uint8Array(0);
    try {
      socket?.end();
    } catch {
      // The socket is already gone.
    }
    this.resolveDone();
    if (fatal && error !== undefined) this.options.onFatal?.(error);
  }

  private closedError(): Error {
    return this.lastError ?? new HostError(CLOSED_MESSAGE);
  }
}

interface SubscriptionOptions {
  readonly home: string;
  readonly client: ClientId;
  readonly token: Token | undefined;
  /** The records the consumer asked for; the cursor starts at the query's position. */
  readonly query: ResolvedQuery;
  /** Called once when the subscription is over (closed or failed). */
  readonly onDone: () => void;
}

/**
 * A live view of the journal. It owns the cursor — the last seq that was queued — and on a
 * drop reconnects and resubscribes from it, which makes the stream gapless and duplicate-free.
 */
class RecordSubscription {
  private readonly options: SubscriptionOptions;
  private readonly queue: StoredRecord[] = [];
  private readonly waiters: Array<() => void> = [];
  private cursor: Seq;
  private connection: WireConnection | null = null;
  private runner: Promise<void> | null = null;
  private failure: Error | null = null;
  private isClosed = false;
  private finished = false;
  /** Set while the connection is held off because the queue is full. */
  private resume: (() => void) | null = null;
  /** Resolved when the subscription is closed, so a pending wait ends at once. */
  private readonly stopPromise: Promise<void>;
  private resolveStop: () => void = () => undefined;

  constructor(options: SubscriptionOptions) {
    this.options = options;
    this.cursor = options.query.from ?? seq(0);
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
  }

  /** Return closes the socket even if a next call is waiting for a commit. */
  iterate(): AsyncIterableIterator<StoredRecord> {
    const records = this.readRecords();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => records.next(),
      return: () => {
        this.close();
        return records.return();
      },
    };
  }

  /** The records, in order, until the subscription closes. */
  private async *readRecords(): AsyncGenerator<StoredRecord, void, undefined> {
    if (this.isClosed) return;
    this.runner ??= this.run();
    try {
      for (;;) {
        const record = this.queue.shift();
        if (record !== undefined) {
          if (this.queue.length < MAX_QUEUED_RECORDS / 2) this.release();
          yield record;
          continue;
        }
        if (this.failure !== null) throw this.failure;
        if (this.isClosed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      this.close();
    }
  }

  /** Stop the subscription: the iterator ends and the socket is closed. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeConnection();
    this.resolveStop();
    this.release();
    this.wake();
    this.finish();
  }

  private async run(): Promise<void> {
    try {
      await this.loop();
    } catch (error) {
      this.fail(asError(error));
    }
  }

  /** Keep one connection alive: every drop leads to a fresh one, resubscribed from the cursor. */
  private async loop(): Promise<void> {
    while (!this.isClosed) {
      const connection = await this.open();
      if (this.isClosed) {
        connection?.close();
        return;
      }
      if (connection !== null) {
        this.connection = connection;
        try {
          // A reconnect asks for the same query from where the stream got to: no gap, no duplicate.
          connection.subscribe({ ...this.options.query, from: this.cursor });
          await connection.done;
        } catch {
          // The write failed: the socket is gone; the next round reconnects.
        }
        this.closeConnection();
        if (this.queue.length >= MAX_QUEUED_RECORDS && !(await this.waitForRoom())) return;
      }
      if (!(await this.waitBeforeRetry())) return;
    }
  }

  /** Open a subscription socket; null when the host is not reachable. */
  private async open(): Promise<WireConnection | null> {
    const connection = new WireConnection({
      home: this.options.home,
      client: this.options.client,
      token: this.options.token,
      onRecord: (record) => {
        this.onRecord(record);
      },
      onFatal: (error) => {
        this.fail(error);
      },
    });
    try {
      await connection.open();
      return connection;
    } catch {
      return null;
    }
  }

  /** Wait before the next attempt; false when the subscription was closed. */
  private async waitBeforeRetry(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RECONNECT_INTERVAL_MS);
    });
    await Promise.race([delay, this.stopPromise]);
    clearTimeout(timer);
    return !this.isClosed;
  }

  /** Wait until the consumer has drained the queue; false when the subscription was closed. */
  private async waitForRoom(): Promise<boolean> {
    await Promise.race([new Promise<void>((resolve) => (this.resume = resolve)), this.stopPromise]);
    return !this.isClosed;
  }

  private release(): void {
    const resume = this.resume;
    this.resume = null;
    resume?.();
  }

  private onRecord(record: StoredRecord): void {
    if (this.isClosed) return;
    // The cursor only moves forward: a record at or below it was delivered already — the
    // host resumes after the cursor, so a boundary record can arrive twice.
    if (record.seq <= this.cursor) return;
    if (this.queue.length >= MAX_QUEUED_RECORDS) {
      // The consumer is too slow. The record is not queued and the cursor does not move, so
      // the resubscribe after the drain starts exactly here.
      this.closeConnection();
      return;
    }
    this.cursor = record.seq;
    this.queue.push(record);
    this.wake();
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.close();
  }

  /** Tell the owner once that this subscription is over, so it is not kept in its set. */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.options.onDone();
  }

  private closeConnection(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

interface LiveSubscriptionOptions {
  readonly home: string;
  readonly client: ClientId;
  readonly token: Token | undefined;
  readonly channel: string;
  /** Called once when the subscription is over (closed or failed). */
  readonly onDone: () => void;
}

/**
 * A view of one channel over one socket. A live frame is not a record: there is no cursor and
 * no history, and the frames sent while the socket was down are missed. A drop is not fatal; the
 * subscription reconnects and listens again.
 */
class LiveSubscription {
  private readonly options: LiveSubscriptionOptions;
  private readonly queue: LiveFrame[] = [];
  private readonly waiters: Array<() => void> = [];
  private connection: WireConnection | null = null;
  private runner: Promise<void> | null = null;
  private failure: Error | null = null;
  private isClosed = false;
  private finished = false;
  private readonly stopPromise: Promise<void>;
  private resolveStop: () => void = () => undefined;

  constructor(options: LiveSubscriptionOptions) {
    this.options = options;
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
  }

  /** Return closes the socket even if a next call is waiting on a quiet channel. */
  iterate(): AsyncIterableIterator<LiveFrame> {
    const frames = this.readFrames();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => frames.next(),
      return: () => {
        this.close();
        return frames.return();
      },
    };
  }

  /** The frames, in order, until the subscription closes. */
  private async *readFrames(): AsyncGenerator<LiveFrame, void, undefined> {
    if (this.isClosed) return;
    this.runner ??= this.run();
    try {
      for (;;) {
        const frame = this.queue.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (this.failure !== null) throw this.failure;
        if (this.isClosed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      this.close();
    }
  }

  /** Stop the subscription: the iterator ends and the socket is closed. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeConnection();
    this.resolveStop();
    this.wake();
    this.finish();
  }

  private async run(): Promise<void> {
    try {
      await this.loop();
    } catch (error) {
      this.fail(asError(error));
    }
  }

  /** Keep one connection alive: every drop leads to a fresh one. */
  private async loop(): Promise<void> {
    while (!this.isClosed) {
      const connection = await this.open();
      if (this.isClosed) {
        connection?.close();
        return;
      }
      if (connection !== null) {
        this.connection = connection;
        try {
          connection.subscribeLive(this.options.channel);
          await connection.done;
        } catch {
          // The write failed: the socket is gone; the next round reconnects.
        }
        this.closeConnection();
      }
      if (!(await this.waitBeforeRetry())) return;
    }
  }

  /** Open a socket; null when the host is not reachable. */
  private async open(): Promise<WireConnection | null> {
    const connection = new WireConnection({
      home: this.options.home,
      client: this.options.client,
      token: this.options.token,
      onFrame: (frame) => {
        this.onFrame(frame);
      },
      onFatal: (error) => {
        this.fail(error);
      },
    });
    try {
      await connection.open();
      return connection;
    } catch {
      return null;
    }
  }

  /** Wait before the next attempt; false when the subscription was closed. */
  private async waitBeforeRetry(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RECONNECT_INTERVAL_MS);
    });
    await Promise.race([delay, this.stopPromise]);
    clearTimeout(timer);
    return !this.isClosed;
  }

  private onFrame(frame: LiveFrame): void {
    if (this.isClosed) return;
    if (this.queue.length >= MAX_QUEUED_RECORDS) this.queue.shift(); // a slow reader loses the oldest frames
    this.queue.push(frame);
    this.wake();
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.close();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.options.onDone();
  }

  private closeConnection(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

class Client implements NiwaApi {
  readonly records: NiwaApi["records"];

  readonly live: {
    send(channel: string, frame: LiveFrame): Promise<void>;
    subscribe(channel: string): AsyncIterable<LiveFrame>;
  };

  private readonly home: string;
  private readonly client: ClientId;
  private readonly token: Token | undefined;
  private link: Promise<WireConnection>;
  private readonly subscriptions = new Set<RecordSubscription>();
  private readonly liveSubscriptions = new Set<LiveSubscription>();
  private isClosed = false;

  constructor(home: string, client: ClientId, token: Token | undefined, connection: WireConnection) {
    this.home = home;
    this.client = client;
    this.token = token;
    this.link = Promise.resolve(connection);
    this.records = {
      since: (query?: RecordQuery<any>): AsyncIterable<StoredRecord> => {
        if (this.isClosed) throw new HostError(CLOSED_MESSAGE);
        const subscription = new RecordSubscription({
          home: this.home,
          client: this.client,
          token: this.token,
          query: resolveQuery(query),
          onDone: () => {
            this.subscriptions.delete(subscription);
          },
        });
        this.subscriptions.add(subscription);
        return subscription.iterate();
      },
      read: async (query?: RecordReadQuery<any>): Promise<StoredRecord[]> => {
        const resolved = resolveQuery(query);
        const value = await this.request((id) => ({
          id,
          op: "read",
          query: onWire(resolved),
          ...(query?.limit === undefined ? {} : { limit: query.limit }),
        }));
        return parseList(storedRecordSchema, value, "the records it was asked for");
      },
    };
    this.live = {
      send: async (channel: string, frame: LiveFrame): Promise<void> => {
        const name = channelName(channel);
        const data = frameFor(name, frame).data;
        await this.request((id) => ({ id, op: "live.send", channel: name, data }));
      },
      subscribe: (channel: string): AsyncIterable<LiveFrame> => {
        if (this.isClosed) throw new HostError(CLOSED_MESSAGE);
        const name = channelName(channel);
        const subscription = new LiveSubscription({
          home: this.home,
          client: this.client,
          token: this.token,
          channel: name,
          onDone: () => {
            this.liveSubscriptions.delete(subscription);
          },
        });
        this.liveSubscriptions.add(subscription);
        return subscription.iterate();
      },
    };
  }

  /**
   * Write an external input: it starts its own chain in the host's journal. With an explicit
   * id the write is idempotent: the same content returns the committed record, different
   * content is an integrity error.
   */
  async emit<T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord> {
    const value = await this.request((id) => ({
      id,
      op: "emit",
      type: type.name,
      data,
      ...(opts?.id === undefined ? {} : { record: opts.id }),
      ...(opts?.links === undefined ? {} : { links: opts.links }),
    }));
    return parseReturned(storedRecordSchema, value, "the record it wrote");
  }

  /**
   * Call an action by typed reference, by value or by name, outside any invocation: only its name is sent.
   *
   * The input is what the action's schema accepts, not what it produces: a branded or transformed
   * field is sent as it is written down, and the host's schema does the rest.
   *
   * An `operation` id names the call for a retry after a lost connection. The host knows the caller
   * again only by its token, so a client without one is refused an operation id before the action runs.
   */
  async call<I, O, In = I>(action: ActionTarget<I, O, In>, input: NoInfer<In>, opts?: CallOptions): Promise<O> {
    const name = targetName(action);
    const reason = opts?.reason;
    const operation = opts?.operation;
    return (await this.request((id) => ({
      id,
      op: "call",
      action: name,
      input,
      ...(reason === undefined ? {} : { reason }),
      ...(operation === undefined ? {} : { operation }),
    }))) as O;
  }

  /** What niwa is: its actions and its record types, with their schemas. */
  async describe(): Promise<Description> {
    const value = await this.request((id) => ({ id, op: "describe" }));
    return parseReturned(descriptionSchema, value, "the description");
  }

  /** Everything that grew from a record: down through causes and links. */
  async trace(record: RecordId): Promise<TracedRecord[]> {
    const value = await this.request((id) => ({ id, op: "trace", record }));
    return parseList(tracedRecordSchema, value, "the trace it was asked for");
  }

  /** What a record depends on: up through its cause and its links. */
  async causes(record: RecordId): Promise<StoredRecord[]> {
    const value = await this.request((id) => ({ id, op: "causes", record }));
    return parseList(storedRecordSchema, value, "the records it was asked for");
  }

  /** Close every connection. Pending calls reject; subscriptions end. */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const subscription of [...this.subscriptions]) subscription.close();
    for (const subscription of [...this.liveSubscriptions]) subscription.close();
    (await this.link.catch(() => undefined))?.close();
  }

  private async request(build: (id: number) => ClientMessageInput): Promise<unknown> {
    return (await this.connection()).request(build);
  }

  /** The call connection; a host that went away and came back gets a fresh one on the next call. */
  private async connection(): Promise<WireConnection> {
    if (this.isClosed) throw new HostError(CLOSED_MESSAGE);
    const known = this.link;
    const current = await known.catch(() => undefined);
    if (current?.isOpen) return current;
    if (this.link === known) this.link = openConnection(this.home, this.client, this.token);
    const fresh = await this.link;
    if (this.isClosed) {
      fresh.close();
      throw new HostError(CLOSED_MESSAGE);
    }
    return fresh;
  }
}

async function openConnection(home: string, client: ClientId, token: Token | undefined): Promise<WireConnection> {
  const connection = new WireConnection({ home, client, token });
  await connection.open();
  return connection;
}

/**
 * Connect to a niwa host. The host must be running and listening on the socket of that
 * home; the returned promise rejects when it is not reachable.
 *
 * Who the connection is comes from `token` alone: `id` is only
 * a name for people. Without a token, or with one the host does not know, it is a plain client.
 */
export async function connect(opts: { home: string; id?: string; token?: Token }): Promise<NiwaApi> {
  const client = (opts.id ?? `client-${crypto.randomUUID()}`) as ClientId;
  return new Client(opts.home, client, opts.token, await openConnection(opts.home, client, opts.token));
}
