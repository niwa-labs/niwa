/**
 * The ACP dialect of the published MiniMax Code (`@minimax-ai/code` 0.7.1, `mcode acp`), over the
 * official ACP snapshot it serves (`@agentclientprotocol/sdk` 1.3.0, generated).
 *
 * Hand-written, since MiniMax Code publishes no schema for its extensions, from its bundle
 * (`chunks/run-acp-command-*.js`): the extension advertisement in the `initialize` reply, the
 * extension methods and notifications, the `set_mode` transition. Only what upstream sends is
 * here; what the owner's fork adds is `../ncode/protocol.ts`, which this file never reads.
 */

import { z } from "zod";

import { Acp13 as Acp } from "@niwa-labs/acp";
import { ProtocolNameSchema } from "@niwa-labs/harness";

export { Acp };

/** The name niwa gives this protocol in the unknowns it records. */
export const MCODE_ACP_PROTOCOL = ProtocolNameSchema.parse(`acp-${Acp.ACP_SDK_VERSION}/mcode`);

/** The `_meta` key of the extensions, in the client's capabilities and in the `initialize` reply. */
export const EXTENSIONS_META = "minimax-code/extensions";

/** What the `initialize` reply says of the extensions it serves. */
export const McodeExtensions = z.object({
  version: z.number().int(),
  methods: z.array(z.string()),
  notifications: z.array(z.string()),
});

/** The `_meta` of the `initialize` reply. */
export const McodeInitializeMeta = z.object({ [EXTENSIONS_META]: McodeExtensions });

/** The extension methods upstream serves (the goal methods only while goals are on). */
export const MCODE_METHODS = [
  "session/activate",
  "mcode/session/activate",
  "mcode/session/steer",
  "mcode/session/queue/list",
  "mcode/session/queue/enqueue",
  "mcode/session/queue/update",
  "mcode/session/queue/delete",
  "mcode/session/queue/steer",
  "mcode/session/goal/get",
  "mcode/session/goal/create",
  "mcode/session/goal/patch",
  "mcode/session/goal/clear",
  "mcode/session/delegation/get",
  "mcode/session/delegation/stop",
] as const;
export type McodeMethod = (typeof MCODE_METHODS)[number];

/** The values of the `permissionMode` config option. */
export const McodePermissionMode = z.enum(["default", "auto", "bypassPermissions"]);
export type McodePermissionMode = z.output<typeof McodePermissionMode>;

/** The extension notifications, sent to a client that opted in to them. */
const McodeExtNotification = [
  z.object({
    jsonrpc: z.literal("2.0").optional(),
    method: z.literal("mcode/session/current_session_update"),
    params: z.object({ sessionId: Acp.SessionId.nullable() }),
  }),
  z.object({
    jsonrpc: z.literal("2.0").optional(),
    method: z.literal("mcode/session/queue_update"),
    params: z.object({ sessionId: Acp.SessionId, items: z.array(z.unknown()) }),
  }),
  z.object({
    jsonrpc: z.literal("2.0").optional(),
    method: z.literal("mcode/session/goal_update"),
    params: z.object({ sessionId: Acp.SessionId, goal: z.unknown(), goalId: z.string().optional() }),
  }),
  z.object({
    jsonrpc: z.literal("2.0").optional(),
    method: z.literal("mcode/session/delegation_update"),
    params: z.object({ sessionId: Acp.SessionId, snapshot: z.unknown() }),
  }),
] as const;

/** A notification upstream sends the client: the snapshot's own and its extensions. */
export const McodeAgentNotification = z.discriminatedUnion("method", [
  ...Acp.AgentToClientNotification.options,
  ...McodeExtNotification,
]);
export type McodeAgentNotification = z.output<typeof McodeAgentNotification>;

/** A request upstream sends the client: the snapshot's own; it has none of its own. */
export const McodeAgentRequest = Acp.AgentToClientRequest;
export type McodeAgentRequest = z.output<typeof McodeAgentRequest>;

