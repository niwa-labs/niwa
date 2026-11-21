/**
 * What `codex app-server` says to its client, read as typed messages.
 *
 * The schemas are generated from the installed codex (`./generated/app-server.ts`, by
 * `scripts/gen-codex.ts`). This module reads one line of the output stream into one `Frame`:
 * a notification or a request that the schemas know, the answer to a call of ours, or a message
 * that is not in the snapshot. A message that is not in the snapshot never fails a session: it
 * comes back as an `unknown` frame that carries the message as it arrived.
 */

import { z } from "zod";

import { JsonValueSchema } from "@niwa-labs/core";
import type { JsonValue } from "@niwa-labs/core";

import { ProtocolNameSchema, VariantNameSchema } from "@niwa-labs/harness";
import type { ProtocolName, VariantName } from "@niwa-labs/harness";

import {
  JSONRPCErrorSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
  ServerNotificationSchema,
  ServerRequestSchema,
  ThreadItemSchema,
} from "./generated/app-server.ts";
import type {
  JSONRPCErrorError,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "./generated/app-server.ts";

/** The name of this wire protocol in a record of an unknown variant. */
export const CODEX_PROTOCOL: ProtocolName = ProtocolNameSchema.parse("codex app-server");

/** One line of the output stream, read. */
export type Frame =
  | { readonly kind: "response"; readonly id: RequestId; readonly result: JsonValue }
  | { readonly kind: "failure"; readonly id: RequestId; readonly error: JSONRPCErrorError }
  | { readonly kind: "notification"; readonly notification: ServerNotification }
  | { readonly kind: "request"; readonly id: RequestId; readonly request: ServerRequest }
  | UnknownFrame
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * A notification or a request that the schemas do not read: its method is not known, or its
 * parameters are not what they were when the snapshot was taken. `id` is there for a request,
 * which must be answered all the same.
 */
export interface UnknownFrame {
  readonly kind: "unknown";
  readonly method: string;
  readonly id: RequestId | undefined;
  /** What is not known: the method, or the type of the item inside an `item/*` notification. */
  readonly variant: VariantName;
  readonly params: JsonValue | undefined;
  readonly raw: JsonValue;
}

/** The values of the `type` of an item that this snapshot knows. */
const ITEM_TYPES: ReadonlySet<string> = new Set(ThreadItemSchema.options.map((option) => option.shape.type.value));

const ItemTypeSchema = z.looseObject({ item: z.looseObject({ type: z.string() }) });

/**
 * What a message that is not read is called: its method, or, when the method is one the schemas
 * know and what they do not know is the type of the item it carries, the method and that type.
 */
function variantOf(method: string, params: JsonValue | undefined): VariantName {
  if (method !== "item/started" && method !== "item/completed") return VariantNameSchema.parse(method);
  const item = ItemTypeSchema.safeParse(params);
  return VariantNameSchema.parse(item.success && !ITEM_TYPES.has(item.data.item.type) ? `${method}:${item.data.item.type}` : method);
}

/** Reads one line of the output stream. It never throws. */
export function readFrame(line: string): Frame {
  let raw: JsonValue;
  try {
    raw = JsonValueSchema.parse(JSON.parse(line));
  } catch (error) {
    return { kind: "unreadable", reason: `a line of the output stream could not be read: ${String(error)}` };
  }

  const request = JSONRPCRequestSchema.safeParse(raw);
  if (request.success) {
    const { id, method, params } = request.data;
    const typed = ServerRequestSchema.safeParse(raw);
    if (typed.success) return { kind: "request", id, request: typed.data };
    return { kind: "unknown", method, id, variant: variantOf(method, params), params, raw };
  }
  const notification = JSONRPCNotificationSchema.safeParse(raw);
  if (notification.success) {
    const { method, params } = notification.data;
    const typed = ServerNotificationSchema.safeParse(raw);
    if (typed.success) return { kind: "notification", notification: typed.data };
    return { kind: "unknown", method, id: undefined, variant: variantOf(method, params), params, raw };
  }

  const failure = JSONRPCErrorSchema.safeParse(raw);
  if (failure.success) return { kind: "failure", id: failure.data.id, error: failure.data.error };
  const response = JSONRPCResponseSchema.safeParse(raw);
  if (response.success) return { kind: "response", id: response.data.id, result: response.data.result };
  return { kind: "unreadable", reason: "a line of the output stream is not a JSON-RPC message" };
}
