/**
 * Reading a message of an ACP dialect against niwa's snapshot of it.
 *
 * A message whose variant the snapshot does not know means the harness got newer than niwa: it
 * must never crash a session, so it reads as a typed unknown carrying the protocol, the value of
 * its discriminator and the message as it came. A message of a variant the snapshot does know,
 * whose fields do not fit it, is not the same: it is a malformed message, and the fields it is
 * wrong in are kept to be told to the agent.
 */

import type { z } from "zod";

import type { JsonValue } from "@niwa-labs/core";
import { VariantNameSchema, rawJson } from "@niwa-labs/harness";
import type { ProtocolName, VariantName } from "@niwa-labs/harness";

/** A message the snapshot of a protocol does not know. */
export interface UnknownVariant {
  /** The protocol, as niwa names its snapshot (`acp-0.14/claude-code`, ...). */
  readonly protocol: ProtocolName;
  /** The value of the discriminator, as far as it could be read. */
  readonly variant: VariantName;
  readonly raw: JsonValue;
}

/**
 * What reading a message gave: the typed message, or the unknown it is. `invalid` is set when the
 * variant is known and the message does not fit it, and says where, as `path: reason` for each field.
 */
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unknown: UnknownVariant; readonly invalid?: string };

/**
 * Where a message holds its discriminator: the `method`, and for a `session/update` the
 * `sessionUpdate` of the update (as `acpVariant` reads them).
 */
const DISCRIMINATOR_PATHS: readonly (readonly string[])[] = [["method"], ["params", "update", "sessionUpdate"]];

/** Whether an issue says that no variant of the snapshot has the value the message's discriminator holds. */
function missesDiscriminator(issue: z.core.$ZodIssue): boolean {
  if (issue.code !== "invalid_union" || !("discriminator" in issue)) return false;
  return DISCRIMINATOR_PATHS.some((path) => path.length === issue.path.length && path.every((key, at) => key === issue.path[at]));
}

/**
 * Read `value` with `schema`; on failure, the unknown it is, with where the message is wrong when its
 * variant is known. `variant` names the discriminator of the message (`method`, or `method` and
 * `sessionUpdate` for a session update).
 */
export function readVariant<S extends z.ZodType>(
  schema: S,
  value: unknown,
  protocol: ProtocolName,
  variant: (value: unknown) => string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const unknown: UnknownVariant = { protocol, variant: VariantNameSchema.parse(variant(value)), raw: rawJson(value) };
  if (parsed.error.issues.some(missesDiscriminator)) return { ok: false, unknown };
  const invalid = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(message)"}: ${issue.message}`).join("; ");
  return { ok: false, unknown, invalid };
}

/** The string at `key` of an object, or `""`. */
function field(value: unknown, key: string): string {
  const found = member(value, key);
  return typeof found === "string" ? found : "";
}

/** The member `key` of an object, when it is one. */
function member(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return key in value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/**
 * The discriminator of a JSON-RPC message: its `method`, and for a `session/update` the
 * `sessionUpdate` of the update too (`session/update tool_call`).
 */
export function acpVariant(message: unknown): string {
  const method = field(message, "method");
  if (method !== "session/update") return method;
  return `${method} ${field(member(member(message, "params"), "update"), "sessionUpdate")}`;
}
