/**
 * What an extension asks of the person at the other end, and the failures of extensions, in pi's RPC mode.
 *
 * HAND-WRITTEN, from `RpcExtensionUIRequest` in `packages/coding-agent/src/modes/rpc/rpc-types.ts`
 * and the `extension_error` line of `rpc-mode.ts`, pi 1.5.2 (commit 22fc026b8). pi emits exactly the
 * nine methods below: four are dialogs that wait for an answer, five are notices that do not.
 */

import { z } from "zod";

import { DialogIdSchema } from "./messages.ts";

const id = DialogIdSchema;
const timeout = z.number().optional();

/** The dialogs: pi waits for an `extension_ui_response` (or for its own `timeout`) on each. */
export const DialogRequestSchema = z.discriminatedUnion("method", [
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("select"),
    title: z.string(),
    options: z.array(z.string()),
    timeout,
  }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("confirm"),
    title: z.string(),
    /** pi's type requires it; a confirmation with only a title is still a question, so it is not refused for lacking one. */
    message: z.string().optional(),
    timeout,
  }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("input"),
    title: z.string(),
    placeholder: z.string().optional(),
    timeout,
  }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("editor"),
    title: z.string(),
    prefill: z.string().optional(),
  }),
]);
export type DialogRequest = z.output<typeof DialogRequestSchema>;

/** The notices: they say something to the interface, and nothing waits for an answer. */
export const NoticeRequestSchema = z.discriminatedUnion("method", [
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("notify"),
    message: z.string(),
    notifyType: z.enum(["info", "warning", "error"]).optional(),
  }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("setStatus"),
    statusKey: z.string(),
    statusText: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("setWidget"),
    widgetKey: z.string(),
    widgetLines: z.array(z.string()).optional(),
    widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
  }),
  z.looseObject({ type: z.literal("extension_ui_request"), id, method: z.literal("setTitle"), title: z.string() }),
  z.looseObject({
    type: z.literal("extension_ui_request"),
    id,
    method: z.literal("set_editor_text"),
    text: z.string(),
  }),
]);
export type NoticeRequest = z.output<typeof NoticeRequestSchema>;

/** Every `extension_ui_request`, by `method`. */
export const UiRequestSchema = z.discriminatedUnion("method", [...DialogRequestSchema.options, ...NoticeRequestSchema.options]);

/** An extension of pi that failed. */
export const ExtensionErrorSchema = z.looseObject({
  type: z.literal("extension_error"),
  extensionPath: z.string(),
  event: z.string(),
  error: z.string(),
});
export type ExtensionError = z.output<typeof ExtensionErrorSchema>;
