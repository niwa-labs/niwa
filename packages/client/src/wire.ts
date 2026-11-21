/**
 * The wire between a client and a host: newline-delimited JSON over a unix socket.
 *
 * A client asks the host to do something; the host answers, and it streams records to the
 * subscriptions it opened. Every message carries the id of the request it belongs to, so an
 * answer is always matched to its question.
 *
 * A boundary: nothing is believed before a schema has said so. The identifiers in types.ts
 * are branded, so this file is also where a plain string becomes a domain value.
 */

import { z } from "zod";

import {
  principalSchema,
  actionName,
  grantId,
  ValidationError,
  JsonSchemaValue,
  RecordQuerySchema,
  recordId,
  recordTypeName,
  seq,
  streamId,
  timestamp,
} from "@niwa-labs/core";
import { token } from "./token.ts";
import { channelName } from "./live.ts";
import type { ClientId, HandlerId, InvocationId } from "@niwa-labs/core";

/** The largest pending line the decoder accepts, in characters: a UTF-8 char takes up to 4 bytes. */
const DEFAULT_MAX_LINE_LENGTH = 8 * 1024 * 1024;

/** The path of the socket a host listens on: `${home}/niwa.sock`. One home, one host, one socket. */
export function socketPath(home: string): string {
  if (typeof home !== "string" || home.length === 0) {
    throw new TypeError("a home must be a non-empty path");
  }
  return `${home}/niwa.sock`;
}

/** A schema that builds a domain identifier; a refusal becomes a schema issue, not a crash. */
function identifier<S extends string | number, T extends string | number>(
  schema: z.ZodType<S, S>,
  build: (value: S) => T,
) {
  return schema.transform((value, ctx) => {
    try {
      return build(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "not a valid identifier" });
      return z.NEVER;
    }
  });
}

/** A branded name: a non-empty string without whitespace — the wire's own client, handler and invocation names. */
function nameSchema<T extends string>(what: string) {
  return identifier(z.string(), (value) => {
    if (value.trim().length === 0) throw new TypeError(`${what} must not be empty`);
    if (/\s/.test(value)) throw new TypeError(`${what} must not contain whitespace: ${JSON.stringify(value)}`);
    return value as T;
  });
}

const requestIdSchema = z.number().int().nonnegative(); // the counter of the client that sent it
const clientIdSchema = nameSchema<ClientId>("client id"); // the name a client gives itself
const actionNameSchema = identifier(z.string(), actionName); // the registry owns the rules
const recordTypeNameSchema = identifier(z.string(), recordTypeName);
const recordIdSchema = identifier(z.string(), recordId);
const streamIdSchema = identifier(z.string(), streamId);
const seqSchema = identifier(z.number(), seq);
const timestampSchema = identifier(z.number(), timestamp);
const handlerIdSchema = nameSchema<HandlerId>("handler id");
const invocationIdSchema = nameSchema<InvocationId>("invocation id");
const channelSchema = identifier(z.string(), channelName);
const tokenSchema = identifier(z.string(), token);

/** Who did something: the actor is bound by the runtime or the transport, never by a payload. */
export const callerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host") }),
  z.strictObject({
    kind: z.literal("client"),
    id: clientIdSchema,
    principal: principalSchema.optional(),
    grant: z.string().min(1).transform((id) => grantId(id)).optional(),
  }),
  z.strictObject({ kind: z.literal("handler"), handler: handlerIdSchema, invocation: invocationIdSchema }),
]);

/** A committed record as it travels over the wire: every field of the stored record. */
export const storedRecordSchema = z.strictObject({
  id: recordIdSchema,
  seq: seqSchema,
  stream: streamIdSchema,
  type: recordTypeNameSchema,
  schema: z.number().int().positive(), // the version of the schema of this record's type
  data: z.unknown().default(undefined), // JSON has no `undefined`: a missing key means "no data"
  actor: callerSchema,
  cause: recordIdSchema.nullable(),
  root: recordIdSchema,
  at: timestampSchema,
});

/**
 * A live frame as it travels: the channel it was sent on and its payload.
 *
 * The payload is not read here: the shape of a frame belongs to whoever uses the channel, and
 * the wire only carries it. What the wire does check is the channel, because it is a key on
 * both sides.
 */
export const liveFrameSchema = z.strictObject({
  channel: channelSchema,
  data: z.unknown().default(undefined),
});

/** A record in a trace as it travels over the wire: the record, and the depth it was found at. */
export const tracedRecordSchema = storedRecordSchema.extend({ depth: z.number().int().nonnegative() });

/** The self-description as it travels: the actions and the record types with their JSON Schemas. */
export const descriptionSchema = z.strictObject({
  actions: z.array(
    z.strictObject({
      name: actionNameSchema,
      description: z.string(),
      recovery: z.enum(["repeat", "repeat-with-key", "do-not-repeat"]),
      effect: z.enum(["read", "record", "write", "irreversible"]),
      world: z.enum(["niwa", "local", "external"]).optional(),
      idempotent: z.boolean().optional(),
      destructive: z.boolean().optional(),
      input: JsonSchemaValue,
      output: JsonSchemaValue,
    }),
  ),
  types: z.array(
    z.strictObject({
      name: recordTypeNameSchema,
      version: z.number().int().positive(),
      schema: JsonSchemaValue,
    }),
  ),
});

const emitFields = {
  type: recordTypeNameSchema,
  data: z.unknown().optional(),
  record: recordIdSchema.optional(),
  links: z.array(recordIdSchema).optional(),
};

/** What a client may send to the host: `op` tells the operations apart. */
export const clientMessageSchema = z.discriminatedUnion("op", [
  // The token is what says who the connection is; the client label only names it for people.
  z.strictObject({ id: requestIdSchema, op: z.literal("hello"), client: clientIdSchema, token: tokenSchema.optional() }),
  z.strictObject({
    id: requestIdSchema,
    op: z.literal("call"),
    action: actionNameSchema,
    input: z.unknown().optional(),
    reason: z.string().min(1).optional(),
    /** The caller's id for the call: a retry under it answers what the first call answered. */
    operation: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({
    id: requestIdSchema,
    op: z.literal("emit"),
    ...emitFields,
  }),
  z.strictObject({id: requestIdSchema, op: z.literal("emitAll"), entries: z.array(z.strictObject(emitFields))}),
  z.strictObject({
    id: requestIdSchema,
    op: z.literal("since"),
    /** The records wanted, history then live: the same query a read takes. */
    query: RecordQuerySchema,
  }),
  z.strictObject({
    id: requestIdSchema,
    op: z.literal("read"),
    query: RecordQuerySchema,
    limit: z.number().int().positive().optional(),
  }),
  z.strictObject({ id: requestIdSchema, op: z.literal("describe") }),
  z.strictObject({ id: requestIdSchema, op: z.literal("live.send"), channel: channelSchema, data: z.unknown().optional() }),
  z.strictObject({ id: requestIdSchema, op: z.literal("live.subscribe"), channel: channelSchema }),
  z.strictObject({ id: requestIdSchema, op: z.literal("trace"), record: recordIdSchema }),
  z.strictObject({ id: requestIdSchema, op: z.literal("causes"), record: recordIdSchema }),
]);

/** What a refusal by a grant carries to the caller. */
export const deniedSchema = z.strictObject({
  grant: z.string().min(1),
  missing: z.string().min(1),
  record: z.string().min(1).optional(),
});

/** What the host may send: an answer, a record of a subscription, or a live frame. */
export const hostMessageSchema = z.union([
  z.discriminatedUnion("ok", [
    z.strictObject({ id: requestIdSchema, ok: z.literal(true), value: z.unknown().optional() }),
    z.strictObject({
      id: requestIdSchema,
      ok: z.literal(false),
      error: z.string(),
      code: z.string().optional(),
      /** Set when a grant refused the call: whose grant, and the rule it lacks. */
      denied: deniedSchema.optional(),
      refusal: z.strictObject({
        code: z.string(), reason: z.string(), entity: z.string(), recordType: recordTypeNameSchema, audit: storedRecordSchema,
      }).optional(),
    }),
  ]),
  z.strictObject({ id: requestIdSchema, record: storedRecordSchema }),
  z.strictObject({ id: requestIdSchema, frame: liveFrameSchema }),
]);

export type ClientMessage = z.output<typeof clientMessageSchema>; // a message a client sent
export type HostMessage = z.output<typeof hostMessageSchema>; // a message the host sent
export type WireMessage = ClientMessage | HostMessage; // a message of either direction

/** One message, ready for the socket: JSON and a newline. The newline is the frame. */
export function encode(msg: WireMessage): string {
  const text = JSON.stringify(msg);
  if (text === undefined) throw new TypeError("a wire message must be a JSON value");
  return `${text}\n`;
}

/** What the decoder does with a line it could not use. */
export interface LineDecoderOptions {
  /** Called for a line that is not valid JSON. The line is dropped: the framing is intact. */
  onError?: (error: Error, line: string) => void;
  /** The largest pending line accepted, in characters. Default 8 MiB; past that the decoder gives up. */
  maxLineLength?: number;
}

/**
 * A decoder: bytes in, messages out. Chunks arrive in whatever sizes the socket chose, so a
 * message can be split across several of them and several messages can arrive in one; the
 * decoder buffers what is left of a line and hands over one message per complete line.
 */
export function lineDecoder(
  onMessage: (m: unknown) => void,
  opts?: LineDecoderOptions,
): (chunk: Uint8Array | string) => void {
  const maxLineLength = opts?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const onError = opts?.onError;
  const decoder = new TextDecoder();
  let pending = "";
  let scanned = 0; // the part of `pending` that is known to hold no newline
  let stopped = false;

  return (chunk: Uint8Array | string): void => {
    if (stopped) return;
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const end = pending.indexOf("\n", Math.max(start, scanned));
      if (end === -1) break;
      const line = pending.slice(start, end);
      start = end + 1;
      if (line.length > maxLineLength) {
        // The limit holds for a line however the socket cut it: a complete line is judged like its remainder.
        stopped = true;
        pending = "";
        onError?.(new Error(`a wire line longer than ${maxLineLength} characters was refused`), line.slice(0, 200));
        return;
      }
      const text = line.trim();
      if (text.length === 0) continue; // a blank line is a keep-alive, not a message
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error("not valid JSON"), line);
        continue;
      }
      onMessage(value);
    }
    pending = pending.slice(start);
    scanned = pending.length;
    if (pending.length > maxLineLength) {
      stopped = true;
      const head = pending.slice(0, 200);
      pending = "";
      onError?.(new Error(`a wire line longer than ${maxLineLength} characters was refused`), head);
    }
  };
}

/** Parse with a schema, refusing with a `ValidationError` that carries the schema's issues. */
function decode<S extends z.ZodType>(schema: S, message: string, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(message, parsed.error.issues);
  return parsed.data;
}

/** Parse what a client sent. */
export function decodeClientMessage(value: unknown): ClientMessage {
  return decode(clientMessageSchema, "not a valid client message", value);
}

/** Parse what the host sent. */
export function decodeHostMessage(value: unknown): HostMessage {
  return decode(hostMessageSchema, "not a valid host message", value);
}

/**
 * The id of the request a message belongs to, if it has one: a message that does not fit the
 * schema may still carry an id, and the host needs it to answer a broken `call`.
 */
export function requestIdOf(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) && id >= 0 ? id : undefined;
}
