/**
 * What a notification of `codex app-server` means to the session that reads it.
 *
 * Every notification the schemas know, and every item an `item/*` notification carries, is
 * mapped here on purpose: to the start or the end of a turn, to something the control side
 * remembers, or to a sign of life. What says nothing about the work of the session is ignored, and
 * the reason is written where it is ignored. The switches end in `assertNever`, so a variant that
 * the next generation of the schemas adds does not compile until it is given a meaning.
 */

import { z } from "zod";

import { assertNever } from "@niwa-labs/core";
import type { JsonValue } from "@niwa-labs/core";

import type { RequestId, ServerNotification, ThreadItem } from "./protocol/generated/app-server.ts";

/** A turn as it ended: Codex's id of it when it gave one, the status Codex gave it, and the reason when it gave one. */
export interface EndedTurn {
  readonly id: string | undefined;
  readonly status: string;
  readonly message: string | undefined;
}

/** What the control side does with a notification. */
export type Incoming =
  | { readonly kind: "turn-started"; readonly turnId: string }
  | { readonly kind: "turn-ended"; readonly turn: EndedTurn }
  /** An item that changes files was announced: an approval of it names no path, so the paths are kept. */
  | { readonly kind: "file-change"; readonly detail: string; readonly itemId: string; readonly paths: readonly string[] }
  /** The final answer of the turn, as it stands. */
  | { readonly kind: "answer"; readonly detail: string; readonly text: string }
  /** Codex answered a request of its own, or stopped waiting for it: nobody waits for an answer any more. */
  | { readonly kind: "request-resolved"; readonly detail: string; readonly requestId: RequestId }
  /** Codex moved the turn to another model: the model the session runs from now on. */
  | { readonly kind: "rerouted"; readonly detail: string; readonly toModel: string }
  /** The session is at work: nothing to keep, only a sign of life. */
  | { readonly kind: "sign"; readonly detail: string }
  /** Not about the work of this session. */
  | { readonly kind: "ignored" };

const IGNORED: Incoming = { kind: "ignored" };

function sign(detail: string): Incoming {
  return { kind: "sign", detail };
}

/** The meaning of an item that was announced (`started`) or is done (`completed`). */
function incomingOfItem(method: "item/started" | "item/completed", item: ThreadItem): Incoming {
  const detail = `${method} ${item.type}`;
  switch (item.type) {
    case "agentMessage":
      // Only the final answer of a turn is its answer: a commentary or a partial message is not.
      // An item that does not say which it is, is the answer.
      if (method === "item/completed" && (item.phase === null || item.phase === "final_answer") && item.text !== "") {
        return { kind: "answer", detail, text: item.text };
      }
      return sign(detail);
    case "fileChange":
      if (method === "item/started") {
        return { kind: "file-change", detail, itemId: item.id, paths: item.changes.map((change) => change.path) };
      }
      return sign(detail);
    // The rest of the items are the work of the turn. None is kept: the turn's answer is the
    // agent's final message, and what the other items did is in Codex's own rollout.
    case "userMessage":
    case "hookPrompt":
    case "functionCallOutput":
    case "plan":
    case "reasoning":
    case "commandExecution":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "webSearch":
    case "imageView":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return sign(detail);
    default:
      return assertNever(item, "codex thread item");
  }
}

/** The meaning of a notification the schemas read. */
export function incomingOf(notification: ServerNotification): Incoming {
  switch (notification.method) {
    case "turn/started":
      return { kind: "turn-started", turnId: notification.params.turn.id };
    case "turn/completed": {
      const { id, status, error } = notification.params.turn;
      return { kind: "turn-ended", turn: { id, status, message: error?.message } };
    }
    case "item/started":
    case "item/completed":
      return incomingOfItem(notification.method, notification.params.item);
    case "serverRequest/resolved":
      return { kind: "request-resolved", detail: notification.method, requestId: notification.params.requestId };
    case "model/rerouted":
      return { kind: "rerouted", detail: notification.method, toModel: notification.params.toModel };
    case "error":
      return sign(`error: ${notification.params.error.message}`);
    case "warning":
    case "guardianWarning":
      return sign(`${notification.method}: ${notification.params.message}`);

    // The thread is working, or what it did is told: each is a sign of life.
    case "thread/started":
    case "thread/status/changed":
    case "thread/tokenUsage/updated":
    case "thread/compacted":
    case "thread/closed":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "hook/started":
    case "hook/completed":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "autoApprovalReview/strictReviewRequired":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "process/exited":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "model/verification":
    case "modelProvider/authRecoveryStarted":
    case "modelProvider/authRecoveryCompleted":
    case "turn/moderationMetadata":
    case "model/safetyBuffering/updated":
    case "mcpServer/startupStatus/updated":
    case "mcpServer/event/stream/notification":
      return sign(notification.method);

    // The bookkeeping of a thread, for the screens that list threads: it says nothing about the work.
    case "thread/readState/changed":
    case "thread/archived":
    case "thread/deleted":
    case "thread/unarchived":
    case "thread/reverted":
    case "thread/name/updated":
    case "thread/section/changed":
    case "thread/attachment/updated":
    case "thread/prediction/updated":
    case "thread/queue/changed":
    case "thread/settings/updated":
    case "thread/environment/connected":
    case "thread/environment/disconnected":
    case "project/changed":
    case "thread/project/updated":
      return IGNORED;

    // The installation, the account and the machine, not the session: a sign of life of the
    // process at most, and an idle session gets them as well.
    case "skills/changed":
    case "mcpServer/oauthLogin/completed":
    case "account/updated":
    case "account/gatewayOAuth/changed":
    case "account/rateLimits/updated":
    case "account/login/completed":
    case "app/list/updated":
    case "remoteControl/status/changed":
    case "externalAgentConfig/import/progress":
    case "externalAgentConfig/import/completed":
    case "fs/changed":
    case "deprecationNotice":
    case "configWarning":
    case "fuzzyFileSearch/sessionUpdated":
    case "fuzzyFileSearch/sessionCompleted":
    case "windows/worldWritableWarning":
    case "windowsSandbox/setupCompleted":
      return IGNORED;

    // A realtime (voice) conversation is a thread of its own kind; niwa starts none, so none is a turn of this session.
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/item/started":
    case "thread/realtime/item/transcript/delta":
    case "thread/realtime/item/completed":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return IGNORED;
    default:
      return assertNever(notification, "codex notification");
  }
}

/** What the books of a turn need from a notification of it that the schemas no longer read. */
const DriftedTurnSchema = z.looseObject({
  turn: z.looseObject({
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.looseObject({ message: z.string().optional() }).nullish(),
  }),
});

const DriftedReroutedSchema = z.looseObject({ toModel: z.string() });

const DriftedResolvedSchema = z.looseObject({ requestId: z.union([z.string(), z.number()]) });

/** What the control side keeps of an item: the agent's words, and the paths of a change of files. */
const DriftedItemSchema = z.looseObject({
  item: z.looseObject({
    type: z.string(),
    id: z.string().optional(),
    text: z.string().optional(),
    phase: z.string().nullish(),
    changes: z.array(z.looseObject({ path: z.string() })).optional(),
  }),
});

/**
 * The meaning of a notification that is not in the snapshot, as far as a turn's books need it.
 *
 * A turn that began or ended must be known to have, whatever else about the message changed: a
 * turn whose end is lost waits for its timeout. An end that cannot be read is not a success. The
 * answer of the turn and the paths of a file change are kept the same way: a field a newer Codex
 * adds to an item must not leave a turn without its answer.
 */
export function incomingOfDrifted(method: string, params: JsonValue | undefined): Incoming | undefined {
  switch (method) {
    case "turn/started": {
      const turn = DriftedTurnSchema.safeParse(params);
      return turn.success && turn.data.turn.id !== undefined ? { kind: "turn-started", turnId: turn.data.turn.id } : undefined;
    }
    case "turn/completed": {
      const turn = DriftedTurnSchema.safeParse(params);
      const read = turn.success ? turn.data.turn : undefined;
      return { kind: "turn-ended", turn: { id: read?.id, status: read?.status ?? "was not readable", message: read?.error?.message } };
    }
    case "item/started":
    case "item/completed": {
      const read = DriftedItemSchema.safeParse(params);
      if (!read.success) return undefined;
      const { item } = read.data;
      const detail = `${method} ${item.type}`;
      if (method === "item/completed" && item.type === "agentMessage" && (item.phase == null || item.phase === "final_answer") && item.text !== undefined && item.text !== "") {
        return { kind: "answer", detail, text: item.text };
      }
      if (method === "item/started" && item.type === "fileChange" && item.id !== undefined && item.changes !== undefined) {
        return { kind: "file-change", detail, itemId: item.id, paths: item.changes.map((change) => change.path) };
      }
      return sign(detail);
    }
    case "model/rerouted": {
      const rerouted = DriftedReroutedSchema.safeParse(params);
      return rerouted.success ? { kind: "rerouted", detail: method, toModel: rerouted.data.toModel } : undefined;
    }
    case "serverRequest/resolved": {
      const resolved = DriftedResolvedSchema.safeParse(params);
      return resolved.success ? { kind: "request-resolved", detail: method, requestId: resolved.data.requestId } : undefined;
    }
    default:
      return undefined;
  }
}
