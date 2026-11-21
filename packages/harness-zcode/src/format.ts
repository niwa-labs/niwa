/**
 * The native format of a ZCode session: what its rows say.
 *
 * A session is three tables. `session` is the session itself; `message` holds its messages in
 * `sequence` order, the JSON in `data` saying who spoke and when; `part` holds what a message is
 * made of, again in `sequence` order, one JSON per part. A part is text, a thought, a call of a
 * tool together with its result, a compaction mark, a file, or a marker of the harness's own
 * (`step-start`, `step-finish`, `timeline`) that is not conversation. Nothing here touches the disk.
 *
 * The part types are all thirteen of ZCode's `MessagePart`. ZCode has no schema for them: it keeps
 * them as TypeScript interfaces (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`,
 * ZCode 3.18.2, commit fec975905a2abd4c07e35c40d51fa097a2258ec9), and what it writes to a row is not
 * checked, so the union below is written by hand from them, with objects that are loose and require
 * only what the reader uses. (The part of the wire protocol, `zcodeMessagePartSchema`, is another shape of
 * them: `callId` and `startedAt` where a row has `callID` and `time.start`.)
 */

import { z } from "zod";

/** The message JSON: what the reading side needs of it, the rest is kept as it was. */
export const MessageDataSchema = z.looseObject({
  role: z.string(),
  time: z.looseObject({ created: z.number().optional(), completed: z.number().optional() }).optional(),
  modelId: z.string().optional(),
  modelID: z.string().optional(),
  providerId: z.string().optional(),
  providerID: z.string().optional(),
  /** Set on the message that carries the summary a compaction left. */
  summary: z.looseObject({ body: z.string().optional() }).optional(),
  metadata: z.looseObject({ visibility: z.string().optional() }).optional(),
  semantics: z.looseObject({ uiVisibility: z.string().optional() }).optional(),
});
export type MessageData = z.output<typeof MessageDataSchema>;

const TimeSchema = z.looseObject({ start: z.number().optional(), end: z.number().optional() });

const TextPartSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  time: TimeSchema.optional(),
});

const ReasoningPartSchema = z.looseObject({
  type: z.literal("reasoning"),
  text: z.string().optional(),
  time: TimeSchema.optional(),
});

const ToolPartSchema = z.looseObject({
  type: z.literal("tool"),
  callID: z.string().min(1),
  tool: z.string().min(1),
  state: z.looseObject({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    time: TimeSchema.optional(),
  }),
});

const CompactionPartSchema = z.looseObject({
  type: z.literal("compaction"),
  summaryMessageId: z.string().optional(),
});

/** A part of which the reader needs only the type: it is not conversation, or it is kept whole. */
const bare = <T extends string>(type: T) => z.looseObject({ type: z.literal(type) });

/** Every part type ZCode writes; the reading side says what each comes to. */
export const PartDataSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  bare("file"),
  bare("agent"),
  CompactionPartSchema,
  bare("timeline"),
  bare("subtask"),
  bare("retry"),
  bare("step-start"),
  bare("step-finish"),
  bare("snapshot"),
  bare("patch"),
  ToolPartSchema,
]);
export type PartData = z.output<typeof PartDataSchema>;

/** The part types of the union: the reading side's mapping has a case for each. */
export const PART_TYPES = PartDataSchema.options.map((option) => option.shape.type.value);

/** What a part's JSON is, as the reading side takes it. */
export type ReadPart = { readonly kind: "part"; readonly part: PartData } | { readonly kind: "unknown"; readonly raw: unknown };

/**
 * Reads the JSON of a part; a part that is not JSON, whose type ZCode has since added, or whose shape is
 * not one the reader can use, is `unknown` with what it was.
 */
export function readPart(text: string): ReadPart {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unknown", raw: text };
  }
  const parsed = PartDataSchema.safeParse(value);
  return parsed.success ? { kind: "part", part: parsed.data } : { kind: "unknown", raw: value };
}

/** Reads the JSON of a message; `undefined` when it is not one a reader can use. */
export function readMessage(text: string): MessageData | undefined {
  try {
    const parsed = MessageDataSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a message is what a person said: not the harness's own injection or a summary. */
export function isHumanMessage(message: MessageData): boolean {
  return (
    message.role === "user" &&
    message.summary === undefined &&
    message.metadata?.visibility !== "model-only" &&
    message.semantics?.uiVisibility !== "hidden"
  );
}

/** The model an assistant message names: `providerId/modelId`, or the model alone. */
export function modelOf(message: MessageData): string | undefined {
  const model = message.modelId ?? message.modelID;
  if (model === undefined) return undefined;
  const provider = message.providerId ?? message.providerID;
  return provider === undefined ? model : `${provider}/${model}`;
}

/** The result of a tool part: its error when it failed, else its output. */
export function resultOf(part: z.output<typeof ToolPartSchema>): unknown {
  return part.state.status === "error" ? (part.state.error ?? part.state.output) : part.state.output;
}

/** Whether a tool part is still being worked on. */
export function isRunning(part: z.output<typeof ToolPartSchema>): boolean {
  return part.state.status === "running" || part.state.status === "pending";
}

/** Whole milliseconds, or `undefined` when the value is not a usable time. */
export function millisOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const whole = Math.max(0, Math.floor(value));
  return Number.isSafeInteger(whole) ? whole : undefined;
}
