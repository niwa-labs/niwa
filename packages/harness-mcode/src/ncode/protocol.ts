/**
 * What the owner's fork of MiniMax Code (0.7.2) adds to the ACP
 * dialect of upstream (`../mcode/protocol.ts`): read only for an `ncode` session, never for an
 * upstream one.
 *
 * Hand-written, since the fork publishes no schema, from its sources (the ACP layer:
 * agent, updates, extensions and interactions; the runtime port):
 *
 * - the working mode of a session, `_meta["minimax-code/permissionMode"]` on `session/new`,
 *   `session/load` and `session/resume`, and the -32603 refusal of a daemon that cannot take it;
 * - the decision on a tool call, `_meta["minimax-code/permission"]`, and the parent tool call of a
 *   delegated one, `_meta["minimax-code/parentToolCallId"]`, on `tool_call` and `tool_call_update`;
 * - service speech, `_meta.informational`, on `agent_message_chunk`;
 * - the `deny-always` option (`reject_always`) of a permission request, an ACP kind niwa never picks;
 * - the methods `mcode/session/turn_status` and `session/history`.
 */

import { z } from "zod";

import { assertNever } from "@niwa-labs/core";
import { ProtocolNameSchema } from "@niwa-labs/harness";
import { Acp, McodePermissionMode } from "../mcode/protocol.ts";

/** The name niwa gives the fork's protocol in the unknowns it records. */
export const NCODE_ACP_PROTOCOL = ProtocolNameSchema.parse(`acp-${Acp.ACP_SDK_VERSION}/ncode`);

/** The `_meta` key of the working mode of a session. */
export const PERMISSION_MODE_META = "minimax-code/permissionMode";

/** The `_meta` of `session/new`, `session/load` and `session/resume`: upstream's `permissionMode` values, per session. */
export const NcodeSessionMeta = z.object({ [PERMISSION_MODE_META]: McodePermissionMode });
export type NcodeSessionMeta = z.output<typeof NcodeSessionMeta>;

/**
 * The refusal of a daemon too old to take the mode of a session: -32603 with this message (the
 * SDK puts "Internal error: " before it), and no data.
 */
export const MODE_UNSUPPORTED = { code: -32603, message: "runtime does not support per-session permissionMode; restart mcoded" } as const;

/** Whether a refusal of `session/new`, `session/load` or `session/resume` is that of a daemon too old for the mode. */
export function refusesSessionMode(code: number | undefined, message: string): boolean {
  return code === MODE_UNSUPPORTED.code && message.includes(MODE_UNSUPPORTED.message);
}

/** The decision the fork marks a tool call with. */
export const NcodePermissionMark = z.object({
  decision: z.enum(["allow", "deny"]),
  decidedBy: z.enum(["classifier", "rule", "mode", "hook", "user"]),
  /** `null` when no rule decided; a build before the key existed sends none. */
  ruleKind: z.enum(["builtin", "session", "agent", "global"]).nullable().default(null),
  mode: z.enum(["default", "auto", "bypassPermissions", "acceptEdits", "dontAsk", "off"]),
  reason: z.string().min(1),
});
export type NcodePermissionMark = z.output<typeof NcodePermissionMark>;

/** The `_meta` of a tool call; a mark not of the shape reads as none, never as a lost update. */
export const NcodeToolMeta = z.object({
  "minimax-code/permission": NcodePermissionMark.optional().catch(undefined),
  "minimax-code/parentToolCallId": Acp.ToolCallId.optional().catch(undefined),
});

/** The `_meta` of service speech: a subscription wait, or a compaction. */
export const NcodeInformationalMeta = z.object({
  informational: z.literal(true),
  severity: z.enum(["warning", "info"]).optional(),
  subscriptionStatus: z.enum(["waiting", "recovered", "exhausted", "cancelled"]).optional(),
  nextRetryAtMs: z.number().optional(),
  compactionStage: z.enum(["preparing", "installed", "failed"]).optional(),
});

type UpdateOption = (typeof Acp.SessionUpdate.options)[number];
type UpdateVariant<K extends Acp.SessionUpdate["sessionUpdate"]> = Extract<UpdateOption, z.ZodObject<{ sessionUpdate: z.ZodLiteral<K> }>>;

/** The snapshot's own schema of one kind of update. */
function variantOf<K extends Acp.SessionUpdate["sessionUpdate"]>(kind: K): UpdateVariant<K> {
  const found = Acp.SessionUpdate.options.find((option): option is UpdateVariant<K> => option.shape.sessionUpdate.value === kind);
  if (found === undefined) throw new Error(`the ACP snapshot has no session update ${kind}`);
  return found;
}

const toolMeta = { _meta: NcodeToolMeta.nullable().optional().catch(undefined) };

/** A session update of the fork: upstream's, with the fork's `_meta` where the fork puts it. */
export const NcodeSessionUpdate = z
  .discriminatedUnion("sessionUpdate", [
    variantOf("user_message_chunk"),
    variantOf("agent_message_chunk").extend({ _meta: NcodeInformationalMeta.nullable().optional().catch(undefined) }),
    variantOf("agent_thought_chunk"),
    variantOf("tool_call").extend(toolMeta),
    variantOf("tool_call_update").extend(toolMeta),
    variantOf("plan"),
    variantOf("plan_update"),
    variantOf("plan_removed"),
    variantOf("available_commands_update"),
    variantOf("current_mode_update"),
    variantOf("config_option_update"),
    variantOf("session_info_update"),
    variantOf("usage_update"),
  ])
  .brand<"NcodeSessionUpdate">();
export type NcodeSessionUpdate = z.output<typeof NcodeSessionUpdate>;

/** What the fork adds to an update: whether it is service speech, and the decision on a tool call. */
export interface NcodeUpdateMarks {
  readonly informational: boolean;
  readonly permission: NcodePermissionMark | undefined;
}

/** The fork's marks on an update upstream's reading already accepted. */
export function ncodeMarks(update: Acp.SessionUpdate): NcodeUpdateMarks {
  const fork = NcodeSessionUpdate.parse(update);
  switch (fork.sessionUpdate) {
    case "agent_message_chunk":
      return { informational: fork._meta?.informational === true, permission: undefined };
    case "tool_call":
    case "tool_call_update":
      return { informational: false, permission: fork._meta?.["minimax-code/permission"] };
    // The fork adds nothing to the other updates.
    case "user_message_chunk":
    case "agent_thought_chunk":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      return { informational: false, permission: undefined };
    default:
      return assertNever(fork, "ncode session update");
  }
}

/** `mcode/session/turn_status`: whether a session has an active turn, whoever started it. */
export const TURN_STATUS = "mcode/session/turn_status";
export const TurnStatusResult = z.object({
  activeTurn: z
    .object({ turnId: z.string(), busyReason: z.enum(["turn", "compaction"]), locallyOwned: z.boolean() })
    .nullable(),
  latestActivity: z
    .object({ turnId: z.string(), acceptedAtMs: z.number(), completedAtMs: z.number().optional(), activityAtMs: z.number() })
    .nullable(),
  queue: z.object({ pendingCount: z.number().int().nonnegative(), paused: z.boolean() }),
});
export type TurnStatusResult = z.output<typeof TurnStatusResult>;
