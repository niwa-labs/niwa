/**
 * Records: the declared value of a record type, and the identifiers the journal is made of.
 *
 * A record type is a value, not a string. `record("ci.build-failed", schema)` returns a declared
 * type; its name is the only string inside it, and that name is how the record is stored and how
 * it is seen from outside (MCP, CLI, another machine). The schema is the single source of the
 * type: it gives the TypeScript type, the validation at the boundary and the JSON Schema for
 * tools.
 *
 * The domain identifiers are branded in types.ts. They are built only here, through the
 * constructors below, so that a bare string cannot pass for a record id: the cast lives in one
 * place instead of being scattered over the core.
 */

import type { z } from "zod";
import { CORE } from "./types.ts";
import type {
  RecordId,
  RecordType,
  RecordTypeName,
  Seq,
  StreamId,
  Timestamp,
} from "./types.ts";

/**
 * A name must be a non-empty string without whitespace: it is a key in the journal, in the
 * registries of the host and on the wire.
 */
function requireName(value: string, what: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${what} must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) {
    throw new TypeError(`${what} must not be empty`);
  }
  if (/\s/.test(value)) {
    throw new TypeError(`${what} must not contain whitespace: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A record id. Unique; deterministic wherever the write can be repeated.
 */
export function recordId(value: string): RecordId {
  return requireName(value, "record id") as RecordId;
}

/**
 * The name of a declared record type: how the record is stored and how it is seen from outside.
 */
export function recordTypeName(value: string): RecordTypeName {
  return requireName(value, "record type name") as RecordTypeName;
}

/**
 * The stream a record belongs to: whose journal this record is in.
 */
export function streamId(value: string): StreamId {
  return requireName(value, "stream id") as StreamId;
}

/**
 * The position of a record in the journal. Assigned at commit; 0 means "before the first".
 */
export function seq(value: number): Seq {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`seq must be a non-negative integer, got ${String(value)}`);
  }
  return value as Seq;
}

/**
 * The moment of a commit, in milliseconds since the epoch.
 */
export function timestamp(value: number): Timestamp {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `timestamp must be a non-negative integer of milliseconds, got ${String(value)}`,
    );
  }
  return value as Timestamp;
}

/**
 * The record types the core writes itself, as branded names. The names live in types.ts next to
 * the shapes they carry. Their data is not validated: the core knows what it writes.
 */
export const CORE_TYPES = {
  invocationAdmitted: recordTypeName(CORE.invocationAdmitted),
  invocationState: recordTypeName(CORE.invocationState),
  invocationResolved: recordTypeName(CORE.invocationResolved),
  invocationMoved: recordTypeName(CORE.invocationMoved),
  stepDecision: recordTypeName(CORE.stepDecision),
  stepIntent: recordTypeName(CORE.stepIntent),
  stepOutcome: recordTypeName(CORE.stepOutcome),
  stepCancelled: recordTypeName(CORE.stepCancelled),
  stateChanged: recordTypeName(CORE.stateChanged),
  stateRead: recordTypeName(CORE.stateRead),
  accessIssued: recordTypeName(CORE.accessIssued),
  accessGranted: recordTypeName(CORE.accessGranted),
  accessClosed: recordTypeName(CORE.accessClosed),
  accessDecided: recordTypeName(CORE.accessDecided),
  accessProfile: recordTypeName(CORE.accessProfile),
  accessSwitched: recordTypeName(CORE.accessSwitched),
  accessAnswered: recordTypeName(CORE.accessAnswered),
  pluginInstalled: recordTypeName(CORE.pluginInstalled),
  subscriptionPosition: recordTypeName(CORE.subscriptionPosition),
} as const;

/**
 * A fresh random id with a prefix: `newId("rec")` → `rec_<uuid>`.
 *
 * Random, so it is never a good id for a write that can be repeated: a repeated write must carry
 * the same id, or it is a second fact. Use `newRecordId` when the id is a record id.
 */
export function newId(prefix: string): string {
  const clean = requireName(prefix, "id prefix");
  return `${clean}_${crypto.randomUUID()}`;
}

/**
 * A fresh random record id: `newRecordId("rec")` → a `RecordId` with the shape of one.
 */
export function newRecordId(prefix: string): RecordId {
  return recordId(newId(prefix));
}

/**
 * A declared record type: `record("ci.build-failed", schema)`.
 *
 * The version is the version of the schema of that type; it is written into every record of the
 * type, so a reader can tell an old shape from a new one. Default 1.
 *
 * A type is closed unless `open` is set: over the wire only the plugin that declares it writes
 * it.
 */
export function record<T>(
  name: string,
  schema: z.ZodType<T>,
  opts?: { version?: number; open?: boolean },
): RecordType<T> {
  const version = opts?.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(
      `record type ${JSON.stringify(name)}: version must be a positive integer, got ${String(version)}`,
    );
  }
  if (schema === null || typeof schema !== "object" || typeof schema.parse !== "function") {
    throw new TypeError(
      `record type ${JSON.stringify(name)}: schema must be a zod schema`,
    );
  }
  return {
    kind: "record",
    name: recordTypeName(name),
    version,
    schema,
    ...(opts?.open === true ? { open: true } : {}),
  };
}

/**
 * JSON with the keys of every object sorted, recursively. The order of arrays is kept: it is
 * meaningful.
 *
 * The result is the JSON `JSON.stringify` would produce, with the keys of every object in a fixed
 * order. Two values that mean the same thing therefore produce the same string whatever order
 * their keys were written in. This is what the journal compares (the same id with the same
 * content is the same record) and what a replayed step compares (the same action with the same
 * input is the same call).
 *
 * The journal stores `data` as JSON text, so this is exactly the shape of what is on disk: a
 * value that JSON cannot represent is written the way JSON writes it (a date becomes its ISO
 * string, `NaN` becomes `null`, a property whose value is `undefined` is dropped, `undefined`
 * inside an array becomes `null`). Two values are the same content when they are the same
 * document on disk — no more, no less.
 */
export function stableJson(value: unknown): string {
  const text = JSON.stringify(sortValue(value, new Set<object>(), ""));
  // JSON.stringify(undefined) is undefined; a comparison needs a string.
  return text === undefined ? "null" : text;
}

/**
 * A copy of `value` with the keys of every object sorted.
 *
 * `path` holds the objects on the way down, so a value that contains itself is refused instead
 * of overflowing the stack. The same object twice in a row is not a cycle and is allowed.
 *
 * `key` is the property name the value was found under; JSON asks a value for its JSON form
 * with that name, and a date is the usual one that cares.
 */
function sortValue(value: unknown, path: Set<object>, key: string): unknown {
  if (value === null || typeof value !== "object") return value;

  if (path.has(value)) {
    throw new TypeError("stableJson: the value contains itself");
  }
  path.add(value);
  try {
    // JSON.stringify asks a value for its JSON form first (a date becomes a string).
    const withToJson = value as { toJSON?: (key: string) => unknown };
    if (typeof withToJson.toJSON === "function") {
      const form = withToJson.toJSON(key);
      // A toJSON that returns the object itself gives no JSON form: keep the object.
      if (form !== value) return sortValue(form, path, key);
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => sortValue(item, path, String(index)));
    }
    // A null prototype: a key named `__proto__` stays an ordinary own property.
    const out = Object.create(null) as Record<string, unknown>;
    for (const name of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[name];
      if (child === undefined) continue; // JSON drops it
      out[name] = sortValue(child, path, name);
    }
    return out;
  } finally {
    path.delete(value);
  }
}
