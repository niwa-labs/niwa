/**
 * What the control side does with each message ZCode sends: a pure map from a message of the
 * snapshot (`protocol/`) to an action, with no process in it. Every notification, every session
 * event and every request of the snapshot is a case of an exhaustive `switch`: one the snapshot
 * gains does not compile until someone decides what niwa does with it.
 */

import { assertNever } from "@niwa-labs/core";

import type { Notification, RequestAnswer, RequestMethod, ServerRequest, SessionEvent } from "./protocol/index.ts";
import type { NotificationSessionEventTurnCompleted, RequestPermissionParams, RequestUserInputParams } from "./protocol/generated/zcode-protocol.ts";

/** How a turn ended, with the answer the server gave. */
export interface TurnEnd {
  readonly outcome: "completed" | "cancelled" | "failed";
  readonly response: string;
  readonly error?: string;
}

/** What the control side does with a notification. */
export type EventAction =
  /** The turn is over. */
  | { readonly do: "end-turn"; readonly end: TurnEnd }
  /** The server stopped waiting for a request: what it asked is no longer wanted. */
  | { readonly do: "stop-asking"; readonly requestId: string | undefined; readonly toolCallId: string | undefined; readonly detail: string }
  /** A sign of life, told in the session's log by `detail`. */
  | { readonly do: "activity"; readonly detail: string }
  /** Nothing: it means nothing to a session's driver. */
  | { readonly do: "ignore" };

/** The words a turn that ended in error says: what the server gave as the kind of result. */
function turnEndOf(resultType: NonNullable<NotificationSessionEventTurnCompleted["payload"]>["resultType"] | undefined, response: string): TurnEnd {
  switch (resultType) {
    // A turn that says nothing of its result ended as turns do.
    case undefined:
    case "success":
      return { outcome: "completed", response };
    // A stopped turn is a normal end of ZCode's, reported as a completion.
    case "cancelled":
      return { outcome: "cancelled", response };
    // The turn ran out of turns, budget or tool calls, or broke while it ran: its words are not an answer.
    case "error_max_turns":
    case "error_max_budget":
    case "error_during_execution":
    case "error_max_tool_calls":
      return { outcome: "failed", response: "", error: `the turn ended with ${resultType}` };
    default:
      return assertNever(resultType, "turn result type");
  }
}

/** What a session event comes to. The event of a subagent is told apart by the caller, which knows the session. */
export function sessionEventAction(event: SessionEvent): EventAction {
  const sign: EventAction = { do: "activity", detail: event.type };
  switch (event.type) {
    case "turn.completed":
      return { do: "end-turn", end: turnEndOf(event.payload?.resultType, event.payload?.response ?? "") };
    case "turn.failed":
      return { do: "end-turn", end: { outcome: "failed", response: "", error: event.payload?.error.message ?? "the turn failed" } };
    // The server says it no longer waits for a request when it resolves it, by whom or why: that is all niwa sees of a cancel.
    case "permission.resolved":
      return { do: "stop-asking", requestId: event.payload?.requestId, toolCallId: event.payload?.toolCallId, detail: event.type };
    case "userInput.resolved":
      return { do: "stop-asking", requestId: event.payload?.requestId, toolCallId: undefined, detail: event.type };
    // The rest are signs of life. The request a `*.requested` event announces comes as a request of its own, which is answered there.
    case "session.created":
    case "session.resumed":
    case "session.updated":
    case "session.titleUpdated":
    case "session.closed":
    case "turn.started":
    case "turn.steerQueued":
    case "turn.steerDrained":
    case "message.upserted":
    case "message.removed":
    case "part.started":
    case "part.delta":
    case "part.upserted":
    case "part.removed":
    case "model.streaming":
    case "tool.updated":
    case "permission.requested":
    case "userInput.requested":
    case "checkpoint.created":
    case "rewind.triggered":
    case "streamRecovery.updated":
      return sign;
    default:
      return assertNever(event, "session event");
  }
}

/** What a notification comes to. */
export function notificationAction(notification: Notification): EventAction {
  switch (notification.method) {
    case "session/event":
      return sessionEventAction(notification.params);
    // The rest are not about a turn: the state of the process and the host's own views of it. A turn is seen by its events.
    case "state.updated": // a patch of the state the host mirrors
    case "session/lifecycle/changed": // the runtime of the session starting, stopping: the calls that wait for it say it
    case "startup/pluginsDegraded": // plugins that did not start in time: the session does not need them
    case "startup/storageState": // progress of the database migration before the session exists
    case "interaction/providerRuntimeHeadersCancelled": // the end of a refresh of provider headers niwa never took up
    case "process/mcpTelemetry": // the host's telemetry
    case "process/mcpResourceSamples": // the host's resource view
    case "process/toolExecResource": // the host's resource view
    case "plugins/operationProgress": // the plugin manager's progress, of an operation niwa did not start
    case "process/resourceSample": // the host's resource view
    case "process/networkRequests": // the host's network capture
    case "computer-use/operation-event": // the host's computer-use hints
      return { do: "ignore" };
    default:
      return assertNever(notification, "notification");
  }
}

/** What the control side needs to know of its session to answer a request. */
export interface RequestContext {
  /** Whether a question goes to someone. A session with none has the server answer its questions itself, after a countdown. */
  readonly asksQuestions: boolean;
}

/** What goes back to a request: the answer ZCode takes for its method, or the empty one for a method it does not know. */
export type Answered = RequestAnswer<RequestMethod> | Readonly<Record<string, never>>;

/** What the control side does with a request: ZCode waits for every one of them, or its turn waits forever. */
export type RequestAction =
  | { readonly do: "answer"; readonly result: Answered }
  /** A JSON-RPC error: niwa does not serve this. */
  | { readonly do: "error"; readonly code: number; readonly message: string }
  /** A question for whoever answers for the session. */
  | { readonly do: "permission"; readonly params: RequestPermissionParams }
  | { readonly do: "user-input"; readonly params: RequestUserInputParams };

/** JSON-RPC's "method not found": what a request niwa does not serve is answered with. */
const NOT_SERVED = -32601;
const refuse = (method: string): RequestAction => ({ do: "error", code: NOT_SERVED, message: `niwa does not serve ${method}` });

/** What a permission request the client could not read is answered with: no leave. */
const PERMISSION_UNREADABLE = { decision: "deny", reason: "niwa could not read this permission request" } satisfies RequestAnswer<"interaction/requestPermission">;

/** What a user input request the client could not read is answered with: declined. */
const INPUT_UNREADABLE = { action: "decline", reason: "niwa could not read this question" } satisfies RequestAnswer<"interaction/requestUserInput">;

/** What a request the snapshot does not know is answered with: an empty answer, which ZCode takes (the language of the reply, say). */
const EMPTY: Answered = {};

/** What a request of ZCode comes to; `undefined` stands for a method the snapshot does not know. */
export function requestAction(request: ServerRequest | undefined, context: RequestContext): RequestAction {
  if (request === undefined) return { do: "answer", result: EMPTY };
  switch (request.method) {
    case "session/requestRuntimePreferences":
      return {
        do: "answer",
        result: {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          // The server answers a question on its own after a countdown: a session whose questions are asked of someone gets no such answer.
          askUserQuestionAutoResolutionEnabled: !context.asksQuestions,
          modelContextBudgetStrategy: "preflight-v1",
        } satisfies RequestAnswer<"session/requestRuntimePreferences">,
      };
    case "interaction/requestPermission":
      return request.params === undefined ? { do: "answer", result: PERMISSION_UNREADABLE } : { do: "permission", params: request.params };
    case "interaction/requestUserInput":
      return request.params === undefined ? { do: "answer", result: INPUT_UNREADABLE } : { do: "user-input", params: request.params };
    // niwa holds no credentials of ZCode's account: each of these is told so in the words its own answer has.
    case "interaction/requestProviderRuntimeHeaders":
      return { do: "answer", result: { headersApplied: false } satisfies RequestAnswer<"interaction/requestProviderRuntimeHeaders"> };
    case "interaction/requestOfficialMcpAuthHeaders":
      return { do: "answer", result: { ok: false, reason: "official_auth_unavailable" } satisfies RequestAnswer<"interaction/requestOfficialMcpAuthHeaders"> };
    case "interaction/requestCredentialCipher":
      return request.params === undefined
        ? refuse(request.method)
        : {
            do: "answer",
            result: {
              requestId: request.params.requestId,
              result: { ok: false, error: { code: "unavailable", message: "niwa holds no credential cipher" } },
            } satisfies RequestAnswer<"interaction/requestCredentialCipher">,
          };
    // No browser is attached to a session niwa drives: an empty list says so, and a command has nowhere to go.
    case "interaction/browserList":
      return { do: "answer", result: { browsers: [] } satisfies RequestAnswer<"interaction/browserList"> };
    case "interaction/browserExecute":
      return refuse(request.method);
    // The host's own services: niwa is not a host. The app-control intents are only offered to a session whose
    // runtime preferences ask for them (`appControlEnabled`), and a bot's channel and topic resources are the host's.
    case "subagents/readRuntimeConfig":
    case "bot/channel/reply":
    case "topic/resource/read":
    case "appControl/listProjects":
    case "appControl/listSessions":
    case "appControl/readSession":
    case "appControl/createSession":
    case "appControl/forkSession":
    case "appControl/sendToSession":
    case "appControl/waitSessions":
    case "appControl/interruptSession":
    case "appControl/renameSession":
    case "appControl/openSession":
    case "appControl/setSessionArchived":
    case "appControl/setSessionPinned":
    case "appControl/cancel":
      return refuse(request.method);
    case "topic/resource/cancel":
      return { do: "answer", result: { cancelled: false } satisfies RequestAnswer<"topic/resource/cancel"> };
    default:
      return assertNever(request, "request");
  }
}
