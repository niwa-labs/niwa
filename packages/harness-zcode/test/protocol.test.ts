/**
 * The ZCode wire, typed: every notification, session event and
 * request of the generated snapshot has a fixture here, read by the parser and mapped by the dispatch,
 * and a snapshot that grows a variant fails the guards below until the variant has both. The real
 * frames of a ZCode 0.17.3 (`test/fixtures/zcode`) go through the same parser, so the snapshot (3.18.2's
 * protocol) is checked against what a newer server really sends. No process runs.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { notificationAction, requestAction, sessionEventAction } from "../src/dispatch.ts";
import type { EventAction, RequestAction } from "../src/dispatch.ts";
import {
  ANSWER_SCHEMAS,
  NOTIFICATION_SCHEMAS,
  REQUEST_SCHEMAS,
  SESSION_EVENT_TYPES,
  SessionMessageSchema,
  V4_NOTIFICATION_METHODS,
} from "../src/protocol/generated/zcode-protocol.ts";
import { readNotification, readRequest, unknownDetail } from "../src/protocol/index.ts";
import type { NotificationMethod, RequestMethod } from "../src/protocol/index.ts";
import { readPermission, readUserInput } from "../src/reverse.ts";

const FIXTURES = join(import.meta.dir, "fixtures/zcode");

const workspace = { workspacePath: "/w", workspaceKey: "/w" };
const part = { partId: "p1", sessionId: "sess_a", messageId: "m1", type: "text", text: "t" };
const options = [{ optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { decision: "allow", reason: "Approved once" } }];
const bound = (input: unknown) => ({ callerSessionId: "sess_a", callId: "call-1", input });
const ref = { kind: "app", workspacePath: "/w", sessionId: "sess_a" };

/** The payload of each session event the snapshot has, as small as it can be. */
const EVENT_PAYLOADS: Record<(typeof SESSION_EVENT_TYPES)[number], unknown> = {
  "session.created": { mode: "build", contextWindow: 1000 },
  "session.resumed": { directory: "/w", interruptedToolCount: 0, messageCount: 1, partCount: 1 },
  "session.updated": { providerId: "p", modelId: "m" },
  "session.titleUpdated": { previousTitle: "", source: "generated", title: "T" },
  "session.closed": { reason: "done" },
  "turn.started": { turnNumber: 0, input: "hi" },
  "turn.steerQueued": { pendingInputId: "p1", input: "x", inputPreview: "x", inputSize: 1, targetTurnId: "t1", queueLength: 1 },
  "turn.steerDrained": { pendingInputIds: ["p1"], targetTurnId: "t1", injectedMessageIds: ["m1"] },
  "turn.completed": { response: "ok", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
  "turn.failed": { error: { type: "execution", message: "boom" }, turnPhase: "execution" },
  "message.upserted": { content: "c" },
  "message.removed": { messageId: "m1" },
  "part.started": { part },
  "part.delta": { messageId: "m1", partId: "p1", delta: "d" },
  "part.upserted": { part },
  "part.removed": { messageId: "m1", partId: "p1" },
  "model.streaming": { kind: "text_delta", delta: "x" },
  "tool.updated": { kind: "started", toolCallId: "c1", startedAt: 1 },
  "permission.requested": { toolCallId: "c1", toolName: "Bash", riskLevel: "low", reason: "r", input: { command: "ls" }, options },
  "permission.resolved": { requestId: "r1", toolCallId: "c1", decision: "deny" },
  "userInput.requested": { requestId: "r1", prompt: "p" },
  "userInput.resolved": { requestId: "r1" },
  "checkpoint.created": {},
  "rewind.triggered": {},
  "streamRecovery.updated": {},
};

/** What each session event comes to. */
const EVENT_ACTIONS: Record<(typeof SESSION_EVENT_TYPES)[number], string> = {
  "session.created": "activity",
  "session.resumed": "activity",
  "session.updated": "activity",
  "session.titleUpdated": "activity",
  "session.closed": "activity",
  "turn.started": "activity",
  "turn.steerQueued": "activity",
  "turn.steerDrained": "activity",
  "turn.completed": "end-turn completed",
  "turn.failed": "end-turn failed",
  "message.upserted": "activity",
  "message.removed": "activity",
  "part.started": "activity",
  "part.delta": "activity",
  "part.upserted": "activity",
  "part.removed": "activity",
  "model.streaming": "activity",
  "tool.updated": "activity",
  "permission.requested": "activity",
  "permission.resolved": "stop-asking",
  "userInput.requested": "activity",
  "userInput.resolved": "stop-asking",
  "checkpoint.created": "activity",
  "rewind.triggered": "activity",
  "streamRecovery.updated": "activity",
};

const envelope = (type: string, payload: unknown) => ({ eventId: "e1", sessionId: "sess_a", seq: 1, timestamp: 1, type, payload });

/** The params of each notification the snapshot has (a session event is in `EVENT_PAYLOADS`). */
const NOTIFICATION_PARAMS: Record<NotificationMethod, unknown> = {
  "session/event": envelope("turn.started", EVENT_PAYLOADS["turn.started"]),
  "state.updated": { type: "state.updated", scope: "session", revision: 1, patch: {} },
  "session/lifecycle/changed": { sessionId: "sess_a", state: "ready", lastError: null },
  "startup/pluginsDegraded": { reason: "timeout" },
  "startup/storageState": { schemaVersion: 1, attemptId: "a", sequence: 1, databaseId: "d", databaseKind: "session", phase: "ready", elapsedMs: 1 },
  "interaction/providerRuntimeHeadersCancelled": { requestId: "r", sessionId: "sess_a", workspace },
  "process/mcpTelemetry": {
    arch: "arm64",
    kind: "process_start",
    mcpId: "builtin:spreadsheets:spreadsheets",
    mcpInstanceId: "i",
    mcpIsolation: "workspace",
    mcpSource: "builtin",
    occurredAt: 1,
    platform: "darwin",
  },
  "process/mcpResourceSamples": [],
  "process/toolExecResource": { platform: "darwin", toolName: "bash", durationMs: 20000, exitKind: "completed", sampleCount: 1, cliRssKb: 1, systemFreeMemoryKb: 1 },
  "plugins/operationProgress": { operationId: "op", state: "refreshing" },
  "process/resourceSample": { platform: "darwin", arch: "arm64", logicalCpuCount: 8, intervalMs: 1000, cpuCores: 1, cpuPercent: 10, rssKb: 1 },
  "process/networkRequests": { captureId: "c", records: [], dropped: 0 },
  "computer-use/operation-event": { eventId: "e", sequenceNumber: 1, sessionId: "sess_a", timestamp: 1, kind: "session-closed" },
};

/** The params of each request the snapshot has. */
const REQUEST_PARAMS: Record<RequestMethod, unknown> = {
  "session/requestRuntimePreferences": { sessionId: "sess_a", scope: "user-execution" },
  "interaction/requestPermission": {
    requestId: "r1",
    sessionId: "sess_a",
    toolCallId: "c1",
    toolName: "Bash",
    reason: "the tool wants to run",
    riskLevel: "low",
    input: { command: "ls" },
    options,
  },
  "interaction/requestUserInput": { requestId: "r1", sessionId: "sess_a", prompt: "your name?" },
  "interaction/requestProviderRuntimeHeaders": {
    requestId: "r1",
    sessionId: "sess_a",
    workspace,
    modelSelection: { providerId: "p", modelId: "m" },
    providerId: "p",
    reason: "model-request",
  },
  "interaction/requestOfficialMcpAuthHeaders": { requestId: "r1", workspace, pluginId: "plugin", mcpKey: "sites", targetOrigin: "https://zcode.z.ai" },
  "interaction/requestCredentialCipher": { requestId: "6f1b1f3e-2f43-4b0e-8c1f-0d3e8a1f9a11", operation: "decrypt", value: "x" },
  "interaction/browserList": { requestId: "r1", sessionId: "sess_a", workspaceKey: "/w", workspacePath: "/w", clientMode: "desktop-continuous", sessionContext: "live" },
  "interaction/browserExecute": { requestId: "r1", sessionId: "sess_a", command: { method: "back" } },
  "subagents/readRuntimeConfig": { sessionId: "sess_a" },
  "bot/channel/reply": { taskId: "t", inputId: "i", toolCallId: "c", parts: [{ type: "text", text: "hi" }] },
  "topic/resource/read": { requestId: "r1", taskId: "t", inputId: "i", authorizationId: "a", messageId: "m", resourceIndex: 0 },
  "topic/resource/cancel": { requestId: "r1", taskId: "t" },
  "appControl/listProjects": bound({}),
  "appControl/listSessions": bound({}),
  "appControl/readSession": bound({ session: ref, view: "summary" }),
  "appControl/createSession": bound({ project: { kind: "app", projectId: "pr" }, prompt: "go", requestId: "r1" }),
  "appControl/forkSession": bound({ session: ref, atMessage: "m1", requestId: "r1" }),
  "appControl/sendToSession": bound({ session: ref, prompt: "go", requestId: "r1" }),
  "appControl/waitSessions": bound({ operations: [{ session: ref, commandId: "c1" }], mode: "any" }),
  "appControl/interruptSession": bound({ session: ref, expectedExecutionId: "x1", requestId: "r1" }),
  "appControl/renameSession": bound({ session: ref, title: "T", requestId: "r1" }),
  "appControl/openSession": bound({ session: ref }),
  "appControl/setSessionArchived": bound({ session: ref, archived: true, requestId: "r1" }),
  "appControl/setSessionPinned": bound({ session: ref, pinned: true, requestId: "r1" }),
  "appControl/cancel": { callerSessionId: "sess_a", callId: "call-1" },
};

/** What each request comes to: `answer` and `error` are what goes back, the others are for whoever answers for the session. */
const REQUEST_ACTIONS: Record<RequestMethod, RequestAction["do"]> = {
  "session/requestRuntimePreferences": "answer",
  "interaction/requestPermission": "permission",
  "interaction/requestUserInput": "user-input",
  "interaction/requestProviderRuntimeHeaders": "answer",
  "interaction/requestOfficialMcpAuthHeaders": "answer",
  "interaction/requestCredentialCipher": "answer",
  "interaction/browserList": "answer",
  "interaction/browserExecute": "error",
  "subagents/readRuntimeConfig": "error",
  "bot/channel/reply": "error",
  "topic/resource/read": "error",
  "topic/resource/cancel": "answer",
  "appControl/listProjects": "error",
  "appControl/listSessions": "error",
  "appControl/readSession": "error",
  "appControl/createSession": "error",
  "appControl/forkSession": "error",
  "appControl/sendToSession": "error",
  "appControl/waitSessions": "error",
  "appControl/interruptSession": "error",
  "appControl/renameSession": "error",
  "appControl/openSession": "error",
  "appControl/setSessionArchived": "error",
  "appControl/setSessionPinned": "error",
  "appControl/cancel": "error",
};

const describe = (action: EventAction): string => (action.do === "end-turn" ? `end-turn ${action.end.outcome}` : action.do);

const sorted = (values: Iterable<string>): string[] => [...values].sort();

const NOTIFICATION_METHODS = Object.keys(NOTIFICATION_SCHEMAS) as NotificationMethod[];
const REQUEST_METHODS = Object.keys(REQUEST_SCHEMAS) as RequestMethod[];

// -- the guards: the fixtures are the snapshot's variants, no more and no fewer ----------------------

test("every session event, notification and request of the snapshot has a fixture and a mapping, and only those", () => {
  expect(sorted(Object.keys(EVENT_PAYLOADS))).toEqual(sorted(SESSION_EVENT_TYPES));
  expect(sorted(Object.keys(EVENT_ACTIONS))).toEqual(sorted(SESSION_EVENT_TYPES));
  expect(sorted(Object.keys(NOTIFICATION_PARAMS))).toEqual(sorted(Object.keys(NOTIFICATION_SCHEMAS)));
  expect(sorted(Object.keys(REQUEST_PARAMS))).toEqual(sorted(Object.keys(REQUEST_SCHEMAS)));
  expect(sorted(Object.keys(REQUEST_ACTIONS))).toEqual(sorted(Object.keys(REQUEST_SCHEMAS)));
  expect(sorted(Object.keys(ANSWER_SCHEMAS))).toEqual(sorted(Object.keys(REQUEST_SCHEMAS)));
});

// -- session events -----------------------------------------------------------------------------------

for (const type of SESSION_EVENT_TYPES) {
  test(`the session event ${type} is read and mapped: ${EVENT_ACTIONS[type]}`, () => {
    const read = readNotification("session/event", envelope(type, EVENT_PAYLOADS[type]));
    expect(read.kind).toBe("known");
    if (read.kind !== "known" || read.notification.method !== "session/event") throw new Error("not a session event");
    expect(read.notification.params.type).toBe(type);
    expect(describe(sessionEventAction(read.notification.params))).toBe(EVENT_ACTIONS[type]);
    expect(describe(notificationAction(read.notification))).toBe(EVENT_ACTIONS[type]);
  });
}

test("a session event may come with no payload at all, and a turn that ends so still ends", () => {
  const read = readNotification("session/event", { eventId: "e1", sessionId: "sess_a", seq: 1, timestamp: 1, type: "turn.completed" });
  expect(read.kind).toBe("known");
  if (read.kind !== "known" || read.notification.method !== "session/event") throw new Error("not a session event");
  expect(sessionEventAction(read.notification.params)).toEqual({ do: "end-turn", end: { outcome: "completed", response: "" } });
});

test("the result of a turn decides how it ended: only success completes, a stop is cancelled, every error result fails it", () => {
  const ended = (resultType: string) => {
    const payload = { ...(EVENT_PAYLOADS["turn.completed"] as Record<string, unknown>), resultType };
    const read = readNotification("session/event", envelope("turn.completed", payload));
    if (read.kind !== "known" || read.notification.method !== "session/event") throw new Error(`${resultType} is not read`);
    return sessionEventAction(read.notification.params);
  };
  expect(ended("success")).toEqual({ do: "end-turn", end: { outcome: "completed", response: "ok" } });
  expect(ended("cancelled")).toEqual({ do: "end-turn", end: { outcome: "cancelled", response: "ok" } });
  for (const failure of ["error_max_turns", "error_max_budget", "error_during_execution", "error_max_tool_calls"]) {
    expect(ended(failure)).toEqual({ do: "end-turn", end: { outcome: "failed", response: "", error: `the turn ended with ${failure}` } });
  }
});

test("a failed turn says what the server said; a request that was resolved is named by the ids the server gave", () => {
  const failed = readNotification("session/event", envelope("turn.failed", EVENT_PAYLOADS["turn.failed"]));
  if (failed.kind !== "known" || failed.notification.method !== "session/event") throw new Error("not read");
  expect(sessionEventAction(failed.notification.params)).toEqual({ do: "end-turn", end: { outcome: "failed", response: "", error: "boom" } });
  const resolved = readNotification("session/event", envelope("permission.resolved", { requestId: "r1", toolCallId: "c1" }));
  if (resolved.kind !== "known" || resolved.notification.method !== "session/event") throw new Error("not read");
  expect(sessionEventAction(resolved.notification.params)).toEqual({ do: "stop-asking", requestId: "r1", toolCallId: "c1", detail: "permission.resolved" });
  const input = readNotification("session/event", envelope("userInput.resolved", { requestId: "r2" }));
  if (input.kind !== "known" || input.notification.method !== "session/event") throw new Error("not read");
  expect(sessionEventAction(input.notification.params)).toEqual({ do: "stop-asking", requestId: "r2", toolCallId: undefined, detail: "userInput.resolved" });
});

test("a session event framed as { event } by some bundles is read as the event it holds", () => {
  const read = readNotification("session/event", { event: envelope("turn.completed", EVENT_PAYLOADS["turn.completed"]) });
  expect(read.kind).toBe("known");
});

// -- notifications ------------------------------------------------------------------------------------

for (const method of NOTIFICATION_METHODS) {
  test(`the notification ${method} is read and, but for a session event, nothing for a driver`, () => {
    const read = readNotification(method, NOTIFICATION_PARAMS[method]);
    expect(read.kind).toBe("known");
    if (read.kind !== "known") return;
    expect(read.notification.method).toBe(method);
    expect(describe(notificationAction(read.notification))).toBe(method === "session/event" ? "activity" : "ignore");
  });
}

test("the messages of ZCode's v4 side channel are known by name and mean nothing to a driver", () => {
  expect(V4_NOTIFICATION_METHODS.length).toBeGreaterThan(0);
  for (const method of V4_NOTIFICATION_METHODS) expect(readNotification(method, { anything: 1 })).toEqual({ kind: "side-channel", method });
});

// -- requests -----------------------------------------------------------------------------------------

for (const method of REQUEST_METHODS) {
  test(`the request ${method} is read and comes to ${REQUEST_ACTIONS[method]}`, () => {
    const read = readRequest(7, method, REQUEST_PARAMS[method]);
    expect(read.unknown).toBeUndefined();
    expect(read.request?.method).toBe(method);
    const action = requestAction(read.request, { asksQuestions: false });
    expect(action.do).toBe(REQUEST_ACTIONS[method]);
    // An answer goes back in the words of its method: the server refuses one that does not fit.
    if (action.do === "answer") expect(ANSWER_SCHEMAS[method].safeParse(action.result).success).toBe(true);
    if (action.do === "error") expect(action).toEqual({ do: "error", code: -32601, message: `niwa does not serve ${method}` });
  });
}

test("a session whose questions go to nobody has the server answer them itself; one that asks keeps them", () => {
  const read = readRequest(1, "session/requestRuntimePreferences", REQUEST_PARAMS["session/requestRuntimePreferences"]);
  expect(requestAction(read.request, { asksQuestions: false })).toMatchObject({ result: { askUserQuestionAutoResolutionEnabled: true } });
  expect(requestAction(read.request, { asksQuestions: true })).toMatchObject({ result: { askUserQuestionAutoResolutionEnabled: false } });
});

test("a permission or a question that does not fit the snapshot is answered at once: no leave, declined", () => {
  const permission = readRequest(1, "interaction/requestPermission", { requestId: "r1" });
  expect(permission.unknown?.why).toBe("does not fit the snapshot");
  expect(requestAction(permission.request, { asksQuestions: true })).toEqual({
    do: "answer",
    result: { decision: "deny", reason: "niwa could not read this permission request" },
  });
  const question = readRequest(1, "interaction/requestUserInput", { requestId: "r1" });
  expect(requestAction(question.request, { asksQuestions: true })).toEqual({
    do: "answer",
    result: { action: "decline", reason: "niwa could not read this question" },
  });
});

test("the credential cipher is refused in the words of its own answer, with the id of the request in it", () => {
  const read = readRequest(1, "interaction/requestCredentialCipher", REQUEST_PARAMS["interaction/requestCredentialCipher"]);
  expect(requestAction(read.request, { asksQuestions: true })).toMatchObject({
    do: "answer",
    result: { requestId: "6f1b1f3e-2f43-4b0e-8c1f-0d3e8a1f9a11", result: { ok: false } },
  });
});

// -- what the snapshot does not know ------------------------------------------------------------------

test("a method the snapshot does not know is an unknown variant that keeps the protocol, the method and the raw message", () => {
  const raw = { method: "session/newThing", params: { a: 1 } };
  const read = readNotification(raw.method, raw.params);
  expect(read).toEqual({ kind: "unknown", unknown: { protocol: "zcode", discriminator: "method", value: "session/newThing", why: "not in the snapshot", raw } });
  if (read.kind !== "unknown") return;
  expect(unknownDetail(read.unknown)).toBe(`unknown zcode method "session/newThing" (not in the snapshot): {"method":"session/newThing","params":{"a":1}}`);
});

test("a session event type the snapshot does not know is an unknown variant by its type", () => {
  const params = envelope("turn.hypothetical", { x: 1 });
  expect(readNotification("session/event", params)).toEqual({
    kind: "unknown",
    unknown: { protocol: "zcode", discriminator: "event type", value: "turn.hypothetical", why: "not in the snapshot", raw: { method: "session/event", params } },
  });
});

test("a type the snapshot knows whose payload does not fit it is an unknown variant too, and does not end a turn", () => {
  const params = envelope("turn.completed", { response: 5 });
  const read = readNotification("session/event", params);
  expect(read).toMatchObject({ kind: "unknown", unknown: { discriminator: "event type", value: "turn.completed", why: "does not fit the snapshot" } });
});

test("a notification of a known method with params that do not fit is an unknown variant by its method", () => {
  expect(readNotification("startup/pluginsDegraded", { reason: "never" })).toMatchObject({
    kind: "unknown",
    unknown: { discriminator: "method", value: "startup/pluginsDegraded", why: "does not fit the snapshot" },
  });
});

test("a request the snapshot does not know is read with no request, so that the control side answers it empty", () => {
  const read = readRequest("server-9", "session/readReplyLanguage", { sessionId: "sess_a" });
  expect(read.request).toBeUndefined();
  expect(read.unknown).toEqual({
    protocol: "zcode",
    discriminator: "method",
    value: "session/readReplyLanguage",
    why: "not in the snapshot",
    raw: { id: "server-9", method: "session/readReplyLanguage", params: { sessionId: "sess_a" } },
  });
  expect(requestAction(read.request, { asksQuestions: true })).toEqual({ do: "answer", result: {} });
});

test("an unknown variant's raw message is cut in the log, and the cut says how much was left out", () => {
  const detail = unknownDetail({ protocol: "zcode", discriminator: "method", value: "x", why: "not in the snapshot", raw: { text: "a".repeat(5000) } });
  expect(detail.length).toBeLessThan(4200);
  expect(detail).toMatch(/\.\.\. \(\d+ more characters\)$/);
});

// -- what a real ZCode sends --------------------------------------------------------------------------

/** The frames a ZCode 0.17.3 sent (`zcode app-server --stdio`), one of each method and event type. */
const captured = readFileSync(join(FIXTURES, "captured-0.17.3.ndjson"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { id?: string; method: string; params: unknown });

test("the real frames of a ZCode newer than the snapshot are all read, but for the one request the snapshot predates", () => {
  const unknown: string[] = [];
  for (const frame of captured) {
    const read = frame.id === undefined ? readNotification(frame.method, frame.params) : undefined;
    if (read !== undefined) {
      if (read.kind === "unknown") unknown.push(frame.method);
      continue;
    }
    const request = readRequest(frame.id ?? "", frame.method, frame.params);
    if (request.unknown !== undefined) unknown.push(frame.method);
  }
  expect(unknown).toEqual(["session/readReplyLanguage"]);
  // The fixtures hold at least a request, an event of each family the driver acts on and a v4 message.
  const methods = new Set(captured.map((frame) => frame.method));
  for (const method of ["session/requestRuntimePreferences", "interaction/requestUserInput", "session/event", "v4/telemetry/event"]) {
    expect(methods.has(method)).toBe(true);
  }
});

test("the real question of an AskUserQuestion is asked as a choice, and a real permission event is read whole", () => {
  const frame = captured.find((candidate) => candidate.method === "interaction/requestUserInput");
  if (frame === undefined) throw new Error("no captured user input request");
  const read = readRequest("server-5", frame.method, frame.params);
  const action = requestAction(read.request, { asksQuestions: true });
  if (action.do !== "user-input") throw new Error(`a question came to ${action.do}`);
  const asked = readUserInput(action.params);
  expect(asked.ask.questions).toHaveLength(1);
  expect(asked.ask.questions[0]?.question).toMatchObject({ kind: "choice", title: "Which color do you prefer?" });
  const event = captured.find((candidate) => candidate.method === "session/event" && (candidate.params as { type?: string }).type === "permission.requested");
  expect(readNotification("session/event", event?.params).kind).toBe("known");
});

test("a permission request is a question with the once-only options, and its answer carries only the decision and its reason", () => {
  const read = readRequest("server-2", "interaction/requestPermission", {
    ...(REQUEST_PARAMS["interaction/requestPermission"] as Record<string, unknown>),
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { decision: "allow", reason: "Approved once", modifiedInput: { x: 1 } } },
      { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny", reason: "no" } },
    ],
  });
  const action = requestAction(read.request, { asksQuestions: true });
  if (action.do !== "permission") throw new Error(`a permission came to ${action.do}`);
  const asked = readPermission(action.params);
  const allow = asked.ask.question.kind === "permission" ? asked.ask.question.options[0] : undefined;
  expect(allow?.id).toBeDefined();
  expect(asked.ask.answer({ ids: allow === undefined ? [] : [allow.id] })).toEqual({ decision: "allow", reason: "Approved once" });
});

test("the messages of a real session/messages result fit the snapshot, and the assistant's text is in the parts of its message", () => {
  const result = JSON.parse(readFileSync(join(FIXTURES, "session-messages-0.17.3.json"), "utf8")) as { messages: unknown[] };
  const messages = result.messages.map((item) => SessionMessageSchema.parse(item));
  expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant"]);
  const texts = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
  expect(texts).toContain("Done — the command printed `capture-ok`.");
  expect(messages[1]?.parts.map((part) => part.type)).toEqual(["step-start", "text", "tool", "step-finish"]);
});
