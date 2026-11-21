/**
 * One line of pi's stdout, understood.
 *
 * A line is a response to a command, an event of the session, a request of an extension, or the
 * failure of one. This is the only place that decides which, and what it hands back is closed: a
 * line this snapshot cannot place is a typed `unknown`, carrying the protocol, the value of the
 * discriminator and the raw line, so that a pi that grew past the snapshot shows in the log and
 * never stops a session.
 */

import { z } from "zod";

import { assertNever } from "@niwa-labs/core";
import { ProtocolNameSchema, VariantNameSchema } from "@niwa-labs/harness";
import type { ProtocolName, VariantName } from "@niwa-labs/harness";

import { AssistantMessageEventSchema, PiEventSchema } from "./events.ts";
import type { PiEvent } from "./events.ts";
import { DialogIdSchema, PiJsonSchema } from "./messages.ts";
import type { DialogId } from "./messages.ts";
import { PiResponseSchema, ResponseEnvelopeSchema, SuccessResponseSchema } from "./responses.ts";
import type { PiResponse, ResponseEnvelope } from "./responses.ts";
import { DialogRequestSchema, ExtensionErrorSchema, NoticeRequestSchema, UiRequestSchema } from "./ui.ts";
import type { DialogRequest, ExtensionError, NoticeRequest } from "./ui.ts";

export type PiJson = z.output<typeof PiJsonSchema>;

/** Where in a line the discriminator that was not recognised sits. */
export type UnknownLevel = "frame" | "response" | "ui-request" | "assistant-message-event";

/** Something pi sent that this snapshot of its protocol has no variant for. */
export interface PiUnknownVariant {
  readonly protocol: "pi";
  readonly level: UnknownLevel;
  /** The value of the discriminator: the frame `type`, the response `command`, the UI `method`, the `assistantMessageEvent.type`. */
  readonly discriminator: string;
  /** `unrecognized`: the value is not in the snapshot. `malformed`: it is, and its body is not what the snapshot says. */
  readonly reason: "unrecognized" | "malformed";
  readonly raw: PiJson;
}

/** What one line of stdout is. */
export type PiIncoming =
  | {
      readonly kind: "response";
      readonly envelope: ResponseEnvelope;
      /** The whole answer, or `undefined` when its body is not what the snapshot says it is. */
      readonly response: PiResponse | undefined;
      /** Set with an `undefined` response: what about the answer is not in the snapshot. */
      readonly variant?: PiUnknownVariant;
    }
  | { readonly kind: "event"; readonly event: PiEvent }
  | { readonly kind: "dialog"; readonly request: DialogRequest; readonly raw: PiJson }
  | { readonly kind: "notice"; readonly request: NoticeRequest }
  | { readonly kind: "extension-error"; readonly error: ExtensionError }
  /** `requestId` is set for an unknown request of an extension: pi waits for an answer to it. */
  | { readonly kind: "unknown"; readonly variant: PiUnknownVariant; readonly requestId?: DialogId }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The literal values a discriminated union has for its key, nested unions included. */
export function discriminators(schema: z.core.$ZodType, key: string): readonly string[] {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options.flatMap((option) => discriminators(option, key));
  }
  if (schema instanceof z.ZodObject) {
    const field: unknown = schema.shape[key];
    return field instanceof z.ZodLiteral ? [String(field.value)] : [];
  }
  return [];
}

const EVENT_TYPES: ReadonlySet<string> = new Set(discriminators(PiEventSchema, "type"));
const UI_METHODS: ReadonlySet<string> = new Set(discriminators(UiRequestSchema, "method"));
const ASSISTANT_EVENT_TYPES: ReadonlySet<string> = new Set(discriminators(AssistantMessageEventSchema, "type"));
const RESPONSE_COMMANDS: ReadonlySet<string> = new Set(discriminators(SuccessResponseSchema, "command"));

/** Every value of every discriminator of the wire, for the tests that want a fixture for each. */
export const WIRE_DISCRIMINATORS = {
  event: [...EVENT_TYPES],
  uiMethod: [...UI_METHODS],
  assistantEvent: [...ASSISTANT_EVENT_TYPES],
  responseCommand: [...RESPONSE_COMMANDS],
} as const;

const RecordSchema = z.record(z.string(), PiJsonSchema);

function variantOf(
  level: UnknownLevel,
  discriminator: string,
  known: ReadonlySet<string>,
  raw: PiJson,
): PiUnknownVariant {
  return { protocol: "pi", level, discriminator, reason: known.has(discriminator) ? "malformed" : "unrecognized", raw };
}

function unknown(
  level: UnknownLevel,
  discriminator: string,
  known: ReadonlySet<string>,
  raw: PiJson,
  requestId?: DialogId,
): PiIncoming {
  const variant = variantOf(level, discriminator, known, raw);
  return requestId === undefined ? { kind: "unknown", variant } : { kind: "unknown", variant, requestId };
}

/** The name of this wire protocol in a record of an unknown variant. */
export const PI_PROTOCOL: ProtocolName = ProtocolNameSchema.parse("pi rpc");

/** The variant as a record names it: the discriminator, and the place in the line it was read at. */
export function unknownVariantName(variant: PiUnknownVariant): VariantName {
  switch (variant.level) {
    case "frame":
      return VariantNameSchema.parse(variant.discriminator);
    case "response":
      return VariantNameSchema.parse(`response ${variant.discriminator}`);
    case "ui-request":
      return VariantNameSchema.parse(`extension_ui_request ${variant.discriminator}`);
    case "assistant-message-event":
      return VariantNameSchema.parse(`message_update ${variant.discriminator}`);
    default:
      return assertNever(variant.level, "pi unknown level");
  }
}

/** The text of an unknown variant, for the activity that tells of it. */
export function describeUnknown(variant: PiUnknownVariant): string {
  const raw = JSON.stringify(variant.raw);
  const shown = raw.length > 4000 ? `${raw.slice(0, 4000)}...` : raw;
  return `pi sent a ${variant.reason} ${variant.level} "${variant.discriminator}" this side has no variant for: ${shown}`;
}

/** Reads one line of pi's stdout. */
export function parseLine(line: string): PiIncoming {
  let value: PiJson;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "unreadable", reason: "a line of the wire could not be read" };
  }
  const object = RecordSchema.safeParse(value);
  if (!object.success) return { kind: "unreadable", reason: "a line of the wire is not an object" };
  const type = object.data.type;
  if (typeof type !== "string") return { kind: "unreadable", reason: "a line of the wire has no type" };

  switch (type) {
    case "response": {
      const envelope = ResponseEnvelopeSchema.safeParse(value);
      if (!envelope.success) return unknown("response", String(object.data.command ?? ""), RESPONSE_COMMANDS, value);
      const response = PiResponseSchema.safeParse(value);
      if (response.success) return { kind: "response", envelope: envelope.data, response: response.data };
      return {
        kind: "response",
        envelope: envelope.data,
        response: undefined,
        variant: variantOf("response", envelope.data.command ?? "", RESPONSE_COMMANDS, value),
      };
    }
    case "extension_ui_request": {
      const method = String(object.data.method ?? "");
      const id = typeof object.data.id === "string" ? DialogIdSchema.parse(object.data.id) : undefined;
      const dialog = DialogRequestSchema.safeParse(value);
      if (dialog.success) return { kind: "dialog", request: dialog.data, raw: value };
      const notice = NoticeRequestSchema.safeParse(value);
      if (notice.success) return { kind: "notice", request: notice.data };
      return unknown("ui-request", method, UI_METHODS, value, id);
    }
    case "extension_error": {
      const error = ExtensionErrorSchema.safeParse(value);
      return error.success ? { kind: "extension-error", error: error.data } : unknown("frame", type, new Set([type]), value);
    }
    default: {
      const event = PiEventSchema.safeParse(value);
      if (event.success) return { kind: "event", event: event.data };
      const inner = type === "message_update" ? RecordSchema.safeParse(object.data.assistantMessageEvent) : undefined;
      const inside = inner?.success === true ? inner.data.type : undefined;
      if (typeof inside === "string" && !ASSISTANT_EVENT_TYPES.has(inside)) {
        return unknown("assistant-message-event", inside, ASSISTANT_EVENT_TYPES, value);
      }
      return unknown("frame", type, EVENT_TYPES, value);
    }
  }
}
