// The API a client holds: the shape the host and a connected client share.
import type { ActionTarget, CallOptions, Description, EmitOptions, LiveFrame, RecordReadQuery, RecordId, RecordQuery, RecordType, StoredRecord, TracedRecord } from "@niwa-labs/core";

/** The frames of one channel, from the moment the host registered the listener. */
export interface LiveSubscription extends AsyncIterableIterator<LiveFrame> {
  /**
   * Resolves once the host has registered the listener: a frame sent after this is received. It
   * rejects when the subscription ended before the host answered. Returning from the iterator
   * ends the subscription, even while a read waits on a quiet channel.
   */
  readonly ready: Promise<void>;
}

/** The records that answer a query, history then live. */
export interface RecordFeed extends AsyncIterable<StoredRecord> {
  /**
   * Resolves once the host has accepted the subscription: it holds the query's reader and its position, and it was not
   * refused. A grant that does not let the connection read the journal rejects it with the host's refusal, before any
   * record. The answer does not wait for a first record, so it comes on an empty journal as well. Asking for it opens the
   * subscription when no record was read yet. Absent in an implementation that has no step between the call and the
   * subscription to wait for.
   */
  readonly ready?: Promise<void>;
}

/** The API shared by the host and a client. */
export interface NiwaApi {
  /**
   * Write an external input. It starts its own chain: root = its own id, cause = null.
   *
   * With an explicit id the write is idempotent: the same id with the same content returns the
   * existing record, the same id with different content is an integrity error.
   */
  emit<T>(type: RecordType<T>, data: T, opts?: EmitOptions): Promise<StoredRecord>;
  /**
   * Call an action by typed reference, by value or by name, outside any invocation.
   *
   * With a reference or an action the input is checked against the action's own input type, and the
   * result has its output type: `I` is taken from the reference alone (`NoInfer`), so a wrong field
   * in the input is an error and not a new type. With a bare name nothing is known and both are
   * unknown.
   *
   * The input is what the schema accepts, not what it produces: a branded or transformed field is
   * given as it is written down, and the schema does the rest.
   */
  call<I, O, In = I>(action: ActionTarget<I, O, In>, input: NoInfer<In>, opts?: CallOptions): Promise<O>;
  /** What niwa is: its actions and its record types, with their schemas. */
  describe(): Promise<Description>;
  /** The live stream: frames that are not recorded. */
  live: {
    /** Send a frame on a channel. A frame that nobody receives is simply lost. */
    send(channel: string, frame: LiveFrame): Promise<void>;
    /** The frames of a channel, from now on. Never ends by itself; `ready` says when it is listening. */
    subscribe(channel: string): LiveSubscription;
  };
  /**
   * Everything that grew from a record: down through causes and links, depth-first, each record
   * once, with the depth it was found at.
   */
  trace(id: RecordId): Promise<TracedRecord[]>;
  /** What a record depends on: up through its cause and its links. */
  causes(id: RecordId): Promise<StoredRecord[]>;
  records: {
    /**
     * The records that answer a query, history then live, no gap, no duplicate: the same records a
     * read of the query gives, and then the ones committed later. Never ends by itself.
     */
    since(query?: RecordQuery<any>): RecordFeed;
    /**
     * The history after a position, read once: the records that are committed now, and nothing
     * that comes later.
     *
     * Unlike `since`, this read ends: it answers with the records that exist at the moment it is
     * made, so a reader never waits for a stream that has no end.
     */
    read(query?: RecordReadQuery<any>): Promise<StoredRecord[]>;
  };
  close(): Promise<void>;
}
