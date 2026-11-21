/**
 * What niwa writes on pi's stdin in its RPC mode: a command, or the answer to a dialog.
 *
 * HAND-WRITTEN, from `RpcCommand` and `RpcExtensionUIResponse` in
 * `packages/coding-agent/src/modes/rpc/rpc-types.ts` of pi 1.5.2 (commit 22fc026b8).
 */

import { z } from "zod";

import { DialogIdSchema, ImageContentSchema, RequestIdSchema, ThinkingLevelSchema } from "./messages.ts";

const id = RequestIdSchema.optional();
const QueueModeSchema = z.enum(["all", "one-at-a-time"]);
const images = z.array(ImageContentSchema).optional();

/** A command, by `type`. Every command may carry an `id`, which its response echoes. */
export const PiCommandSchema = z.discriminatedUnion("type", [
  // Prompting
  z.object({
    id,
    type: z.literal("prompt"),
    message: z.string(),
    images,
    streamingBehavior: z.enum(["steer", "followUp"]).optional(),
  }),
  z.object({ id, type: z.literal("steer"), message: z.string(), images }),
  z.object({ id, type: z.literal("follow_up"), message: z.string(), images }),
  z.object({ id, type: z.literal("abort") }),
  z.object({ id, type: z.literal("clear_queue") }),
  z.object({ id, type: z.literal("new_session"), parentSession: z.string().optional() }),
  // State
  z.object({ id, type: z.literal("get_state") }),
  // Model
  z.object({ id, type: z.literal("set_model"), provider: z.string(), modelId: z.string() }),
  z.object({ id, type: z.literal("cycle_model") }),
  z.object({ id, type: z.literal("get_available_models") }),
  // Thinking
  z.object({ id, type: z.literal("set_thinking_level"), level: ThinkingLevelSchema }),
  z.object({ id, type: z.literal("cycle_thinking_level") }),
  z.object({ id, type: z.literal("get_available_thinking_levels") }),
  // Queue modes
  z.object({ id, type: z.literal("set_steering_mode"), mode: QueueModeSchema }),
  z.object({ id, type: z.literal("set_follow_up_mode"), mode: QueueModeSchema }),
  // Compaction
  z.object({ id, type: z.literal("compact"), customInstructions: z.string().optional() }),
  z.object({ id, type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
  // Retry
  z.object({ id, type: z.literal("set_auto_retry"), enabled: z.boolean() }),
  z.object({ id, type: z.literal("abort_retry") }),
  // Bash
  z.object({ id, type: z.literal("bash"), command: z.string(), excludeFromContext: z.boolean().optional() }),
  z.object({ id, type: z.literal("abort_bash") }),
  // Session
  z.object({ id, type: z.literal("get_session_stats") }),
  z.object({ id, type: z.literal("export_html"), outputPath: z.string().optional() }),
  z.object({ id, type: z.literal("switch_session"), sessionPath: z.string() }),
  z.object({ id, type: z.literal("fork"), entryId: z.string() }),
  z.object({ id, type: z.literal("clone") }),
  z.object({ id, type: z.literal("get_fork_messages") }),
  z.object({ id, type: z.literal("get_entries"), since: z.string().optional() }),
  z.object({ id, type: z.literal("get_tree") }),
  z.object({ id, type: z.literal("get_last_assistant_text") }),
  z.object({ id, type: z.literal("set_session_name"), name: z.string() }),
  // Messages
  z.object({ id, type: z.literal("get_messages") }),
  // Commands available for invocation through a prompt
  z.object({ id, type: z.literal("get_commands") }),
]);
export type PiCommand = z.output<typeof PiCommandSchema>;
export type PiCommandName = PiCommand["type"];

/** The fields of a command besides its `type` and `id`: what a caller of `#call` supplies. */
export type PiCommandFields<C extends PiCommandName> = Omit<Extract<PiCommand, { type: C }>, "type" | "id">;

/** The `extension_ui_response` as pi reads it from stdin: one of three shapes, told apart by their fields. */
export const PiUiResponseSchema = z.union([
  z.object({ type: z.literal("extension_ui_response"), id: DialogIdSchema, value: z.string() }),
  z.object({ type: z.literal("extension_ui_response"), id: DialogIdSchema, confirmed: z.boolean() }),
  z.object({ type: z.literal("extension_ui_response"), id: DialogIdSchema, cancelled: z.literal(true) }),
]);
export type PiUiResponse = z.output<typeof PiUiResponseSchema>;

/** What an answer to a dialog says, without the `type` and the `id` that address it. */
export type PiUiReply = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

/** Everything niwa writes to pi. */
export type PiOutgoing = PiCommand | PiUiResponse;
