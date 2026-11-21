/**
 * Plugin state: values by key, owned by a plugin, changed by named operations.
 *
 * The rules this file keeps:
 *
 * - A change is one named operation: `update` reads, applies and commits in one synchronous turn,
 *   so two handlers cannot lose each other's updates.
 * - Every change is a record, `niwa.state.changed` `{ plugin, name, op, value }`, where `value` is
 *   what the key holds after the change.
 * - Inside an invocation a read is a record, `niwa.state.read`, under `${invocation}/state/${n}`;
 *   a replay returns that record's value, never today's.
 * - Only the plugin that declared a key writes it: the handle is its only way in, and it refuses
 *   to run inside a handler of another plugin.
 * - The current value is a projection folded from the journal when the host serves.
 */

import { z } from "zod";

import { ValidationError, currentInvocation, CORE_TYPES, newRecordId, recordId, streamId } from "@niwa-labs/core";
import type { InvocationScope, Caller, Journal, NewRecord, PluginName, RecordId, StoredRecord } from "@niwa-labs/core";
import type { StateHandle } from "@niwa-labs/plugin";

/** How the store writes: the records are committed and published. */
type Append = (recs: NewRecord[]) => StoredRecord[];

/** The data of a state record: what the key holds, or held when it was read. */
const StateData = z.object({
  plugin: z.string(),
  name: z.string(),
  op: z.string(),
  value: z.unknown(),
});

/** What a plugin declared about one key of its state. */
interface Entry {
  readonly schema: z.ZodType<unknown>;
  /** The value before anything changed the key, and the value a take resets it to. */
  readonly initial: unknown;
}

/** The key of a value inside a plugin: `${plugin}/${name}`. */
function stateKey(plugin: string, name: string): string {
  return `${plugin}/${name}`;
}

/** A name is a key in the journal and the projection: not empty, no whitespace. */
function requireName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("the name of a state value must be a non-empty string");
  }
  if (/\s/.test(name)) {
    throw new TypeError(`the name of a state value must not contain whitespace: ${JSON.stringify(name)}`);
  }
  return name;
}

/** The plugin a handler id belongs to: handler ids are `${plugin}/${name}`. */
function pluginOfHandler(handler: string): string {
  return handler.slice(0, handler.lastIndexOf("/"));
}

/** Who changed a value: the handler that runs, or the host when nothing runs. */
function actorOf(scope: InvocationScope | undefined): Caller {
  if (scope === undefined) return { kind: "host" };
  return { kind: "handler", handler: scope.handler, invocation: scope.invocation };
}

/** The state of the plugins of one host. */
export class StateStore {
  private journal: Journal | undefined;
  private append: Append | undefined;
  private readonly entries = new Map<string, Entry>();
  /** The current value of every key: a projection of the journal, nothing more. */
  private readonly values = new Map<string, unknown>();

  /** Take the journal and the way to write, and fold the projection from the journal. */
  bind(deps: { journal: Journal; append: Append }): void {
    this.journal = deps.journal;
    this.append = deps.append;
    this.values.clear();
    for (const record of deps.journal.find({ type: CORE_TYPES.stateChanged })) this.fold(record);
  }

  private fold(record: StoredRecord): void {
    if (record.type !== CORE_TYPES.stateChanged) return;
    const data = StateData.safeParse(record.data);
    if (data.success) this.values.set(stateKey(data.data.plugin, data.data.name), data.data.value);
  }

  /** The keys declared now: what an install that fails puts back. */
  declared(): ReadonlyMap<string, Entry> {
    return new Map(this.entries);
  }

  /** Put the declared keys back as `declared` took them. */
  restore(declared: ReadonlyMap<string, Entry>): void {
    this.entries.clear();
    for (const [key, entry] of declared) this.entries.set(key, entry);
  }

  /** Declare a key of a plugin's state and hand out its handle. */
  define<T>(plugin: PluginName, name: string, schema: z.ZodType<T>, initial: T): StateHandle<T> {
    const key = stateKey(plugin, requireName(name));
    const parsed = schema.safeParse(initial);
    if (!parsed.success) {
      throw new ValidationError(`the initial value of the state "${key}" is not valid`, parsed.error.issues);
    }
    this.entries.set(key, { schema, initial: parsed.data });
    return {
      name,
      get: () => this.read<T>(plugin, name),
      set: (value) => this.change<T>(plugin, name, "set", () => value),
      update: (fn) => this.change<T>(plugin, name, "update", fn),
      take: () => this.take<T>(plugin, name),
    };
  }

  /** Inside an invocation the read is recorded, and a replay returns the first read. */
  private read<T>(plugin: PluginName, name: string): T {
    const key = stateKey(plugin, name);
    const entry = this.entryOf(key);
    const scope = this.scopeFor(plugin);
    if (scope === undefined) return this.current(key, entry) as T;

    scope.reads += 1;
    const id = recordId(`${scope.invocation}/state/${scope.reads}`);
    const recorded = this.recorded(id, plugin, name);
    if (recorded !== undefined) return recorded as T;

    const value = this.current(key, entry);
    this.commit([this.record(CORE_TYPES.stateRead, plugin, name, "get", value, scope, id)], scope);
    return value as T;
  }

  /**
   * One change: `next` runs on the current value and the result is committed in the same
   * synchronous turn. Inside an invocation the change has a deterministic id, so a replay finds
   * the change made the first time and does not make it again.
   */
  private change<T>(plugin: PluginName, name: string, op: "set" | "update", next: (current: T) => T): T {
    const key = stateKey(plugin, name);
    const entry = this.entryOf(key);
    const scope = this.scopeFor(plugin);
    const id = this.writeId(scope);
    const recorded = this.recorded(id, plugin, name);
    if (recorded !== undefined) return recorded as T;

    const parsed = entry.schema.safeParse(next(this.current(key, entry) as T));
    if (!parsed.success) {
      throw new ValidationError(`the value of the state "${key}" is not valid`, parsed.error.issues);
    }
    this.commit([this.record(CORE_TYPES.stateChanged, plugin, name, op, parsed.data, scope, id)], scope);
    return structuredClone(parsed.data) as T;
  }

  /**
   * Return the value and reset the key to its initial one. The read and the reset are one commit,
   * so a change that arrives meanwhile lands in the next batch, and a replay takes the same batch.
   */
  private take<T>(plugin: PluginName, name: string): T {
    const key = stateKey(plugin, name);
    const entry = this.entryOf(key);
    const scope = this.scopeFor(plugin);
    const current = this.current(key, entry);

    if (scope === undefined) {
      const id = newRecordId("st");
      this.commit([this.record(CORE_TYPES.stateChanged, plugin, name, "take", entry.initial, undefined, id)]);
      return current as T;
    }

    scope.reads += 1;
    const readId = recordId(`${scope.invocation}/state/${scope.reads}`);
    const recorded = this.recorded(readId, plugin, name);
    if (recorded !== undefined) {
      // The reset belongs to the same commit: its ordinal is consumed, as in the first run.
      scope.writes += 1;
      return recorded as T;
    }

    const changeId = this.writeId(scope);
    this.commit([
      this.record(CORE_TYPES.stateRead, plugin, name, "take", current, scope, readId),
      this.record(CORE_TYPES.stateChanged, plugin, name, "take", entry.initial, scope, changeId),
    ], scope);
    return current as T;
  }

  private entryOf(key: string): Entry {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`the state "${key}" was not declared`);
    return entry;
  }

  /**
   * The running invocation, if it may touch this plugin's state. A handler of another plugin
   * cannot, and nor can code that outlives its invocation.
   */
  private scopeFor(plugin: PluginName): InvocationScope | undefined {
    const scope = currentInvocation();
    if (scope === undefined) return undefined;
    if (scope.closed) {
      throw new Error(`the invocation ${scope.invocation} has ended: its state cannot be touched`);
    }
    if (pluginOfHandler(scope.handler) !== plugin) {
      throw new Error(`the state of "${plugin}" can only be touched by "${plugin}", not by ${scope.handler}`);
    }
    return scope;
  }

  /** A copy of the value: what a caller does to it must not reach the projection. */
  private current(key: string, entry: Entry): unknown {
    return structuredClone(this.values.has(key) ? this.values.get(key) : entry.initial);
  }

  /** The value of the record with this id, if the journal holds one for this key. */
  private recorded(id: RecordId, plugin: PluginName, name: string): unknown {
    const record = this.journal?.get(id);
    if (record === undefined) return undefined;
    const data = StateData.parse(record.data);
    if (data.plugin !== plugin || data.name !== name) {
      throw new Error(`replay diverged: ${id} holds "${data.plugin}/${data.name}", not "${plugin}/${name}"`);
    }
    return data.value;
  }

  /** The id of the next change of this invocation. */
  private writeId(scope: InvocationScope | undefined): RecordId {
    if (scope === undefined) return newRecordId("st");
    scope.writes += 1;
    return recordId(`${scope.invocation}/state/write/${scope.writes}`);
  }

  private record(
    type: typeof CORE_TYPES.stateChanged | typeof CORE_TYPES.stateRead,
    plugin: PluginName,
    name: string,
    op: string,
    value: unknown,
    scope: InvocationScope | undefined,
    id: RecordId,
  ): NewRecord {
    return {
      id,
      stream: streamId(`plugin:${plugin}`),
      type,
      schema: 1,
      data: { plugin, name, op, value },
      actor: actorOf(scope),
      cause: scope?.cause ?? null,
      root: scope?.root ?? id,
    };
  }

  /** Commit the records, then fold the committed changes into the projection. */
  private commit(recs: NewRecord[], scope?: InvocationScope): void {
    if (this.append === undefined) throw new Error("the state cannot be changed before the host is serving");
    scope?.writing();
    for (const record of this.append(recs)) this.fold(record);
  }
}
