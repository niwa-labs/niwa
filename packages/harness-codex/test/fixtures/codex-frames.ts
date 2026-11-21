/**
 * The frames of a fake `codex app-server`, written as the real one writes them: the field
 * names and the shape of each are those of the frames captured from codex-cli 0.169
 * (`codex-app-server/captured.jsonl`). A fake that sends a frame the real server never would
 * proves nothing about how a frame is read, so a test of the control side builds its frames here.
 *
 * This module imports nothing: the fakes run as scripts of their own and import it by path.
 */

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

/** A turn as `turn/started` and `turn/completed` carry it. */
export function turnOf(id: string, status: TurnStatus, error?: string) {
  return {
    id,
    rootTurnId: id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: error === undefined ? null : { message: error },
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

export function turnStarted(threadId: string, turnId: string) {
  return { method: "turn/started", params: { threadId, turn: turnOf(turnId, "inProgress") } };
}

export function turnCompleted(threadId: string, turnId: string, status: TurnStatus, error?: string) {
  return { method: "turn/completed", params: { threadId, turn: turnOf(turnId, status, error) } };
}

/** The agent's message, finished: `phase` is what says whether it is the answer of the turn. */
export function agentMessageCompleted(threadId: string, turnId: string, text: string, phase: string | null = "final_answer") {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      contentTokenCount: null,
      completedAtMs: 2,
      item: {
        type: "agentMessage",
        id: `message-${turnId}`,
        text,
        phase,
        moderation: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
        startedAtMs: 1,
        completedAtMs: 2,
      },
    },
  };
}

/** A file change Codex announces: the approval of it names no path, so the paths are told here. */
export function fileChangeStarted(threadId: string, turnId: string, itemId: string, paths: readonly string[]) {
  return {
    method: "item/started",
    params: {
      threadId,
      turnId,
      startedAtMs: 1,
      item: {
        type: "fileChange",
        id: itemId,
        status: "inProgress",
        changes: paths.map((path) => ({ path, kind: { type: "add" }, diff: "x" })),
        startedAtMs: 1,
        completedAtMs: null,
      },
    },
  };
}

/** A request of Codex that waits for the client; `params` are the fields the request adds to its thread and turn. */
export function serverRequest(id: string | number, method: string, threadId: string, turnId: string, params: Record<string, unknown>) {
  return { id, method, params: { threadId, turnId, ...params } };
}

/** What a command approval carries, as the captured request does. */
export function commandApprovalParams(params: Record<string, unknown>) {
  return { kind: "command", itemId: "call-1", startedAtMs: 1, environmentId: null, ...params };
}
