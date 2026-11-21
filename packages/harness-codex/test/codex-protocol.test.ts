/**
 * The typed protocol of `codex app-server` (src/protocol, incoming.ts, refusals.ts).
 *
 * The schemas are generated from the installed codex, so what they prove against the real thing is
 * the frames captured from it (`fixtures/codex-app-server/captured.jsonl`): each must read as the
 * message it is. A variant none was captured for is made by `minimalInstance` from its schema; it
 * proves that the variant is read, given a meaning, and answered, not that the schema is right.
 * What is not in the snapshot at all must become a typed unknown variant that carries the message.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { z } from "zod";

import type { JsonValue } from "@niwa-labs/core";
import { ProtocolNameSchema, VariantNameSchema } from "@niwa-labs/harness";
import { incomingOf, incomingOfDrifted } from "../src/incoming.ts";
import type { Incoming } from "../src/incoming.ts";
import { CODEX_PROTOCOL, readFrame } from "../src/protocol/index.ts";
import type { Frame } from "../src/protocol/index.ts";
import {
  ApplyPatchApprovalResponseSchema,
  CommandExecutionRequestApprovalResponseSchema,
  DynamicToolCallResponseSchema,
  ExecCommandApprovalResponseSchema,
  FileChangeRequestApprovalResponseSchema,
  McpServerElicitationRequestResponseSchema,
  PermissionsRequestApprovalResponseSchema,
  ServerNotificationSchema,
  ServerRequestSchema,
  ThreadItemSchema,
  ToolRequestUserInputResponseSchema,
} from "../src/protocol/generated/app-server.ts";
import type { ServerRequest } from "../src/protocol/generated/app-server.ts";
import { refusalOf } from "../src/refusals.ts";

import { minimalInstance } from "./fixtures/zod-instance.ts";

/** The frames captured from codex-cli 0.169, server to client. */
const CAPTURED = readFileSync(new URL("./fixtures/codex-app-server/captured.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as { method: string; id?: number; params: { item?: { type: string } } });

const line = (frame: unknown): string => JSON.stringify(frame);

function notificationOf(frame: Frame) {
  if (frame.kind !== "notification") throw new Error(`not a notification: ${JSON.stringify(frame)}`);
  return frame.notification;
}

test("every frame captured from codex reads as the message it is, never as an unknown variant", () => {
  expect(CAPTURED.length).toBeGreaterThan(15);
  for (const captured of CAPTURED) {
    const frame = readFrame(line(captured));
    expect(frame.kind).toBe(captured.id === undefined ? "notification" : "request");
  }
});

const NOTIFICATIONS = ServerNotificationSchema.options.map((option) => option.shape.method.value);

test("every notification the schemas know is read, and given a meaning", () => {
  expect(NOTIFICATIONS.length).toBe(86);
  for (const option of ServerNotificationSchema.options) {
    const method = option.shape.method.value;
    const real = CAPTURED.find((captured) => captured.id === undefined && captured.method === method && captured.params.item === undefined);
    const frame = readFrame(line(real ?? minimalInstance(option)));
    expect(frame.kind).toBe("notification");
    expect(notificationOf(frame).method).toBe(method);
    expect(() => incomingOf(notificationOf(frame))).not.toThrow();
  }
});

const ITEM_TYPES = ThreadItemSchema.options.map((option) => option.shape.type.value);

test("every item an item notification carries is read, and given a meaning, started and completed", () => {
  expect(ITEM_TYPES.length).toBe(19);
  for (const method of ["item/started", "item/completed"] as const) {
    const wrapper = ServerNotificationSchema.options.find((option) => option.shape.method.value === method);
    if (wrapper === undefined) throw new Error(`no ${method}`);
    for (const option of ThreadItemSchema.options) {
      const type = option.shape.type.value;
      const real = CAPTURED.find((captured) => captured.method === method && captured.params.item?.type === type);
      const made = z.object({ method: z.string(), params: z.object({ item: z.unknown() }).loose() }).loose().parse(minimalInstance(wrapper));
      const sent = real ?? { ...made, params: { ...made.params, item: minimalInstance(option) } };
      const frame = readFrame(line(sent));
      expect(frame.kind).toBe("notification");
      const incoming = incomingOf(notificationOf(frame));
      expect(incoming.kind === "ignored").toBe(false);
      if (incoming.kind !== "ignored" && incoming.kind !== "turn-started" && incoming.kind !== "turn-ended") {
        expect(incoming.detail).toContain(type);
      }
    }
  }
});

/** What the answer to each request must be: the schema of the result Codex takes, or an error. */
const REPLY_SCHEMAS: { readonly [Method in ServerRequest["method"]]: z.ZodType | "error" } = {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponseSchema,
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponseSchema,
  "item/permissions/requestApproval": PermissionsRequestApprovalResponseSchema,
  "item/tool/requestUserInput": ToolRequestUserInputResponseSchema,
  "item/tool/call": DynamicToolCallResponseSchema,
  "mcpServer/elicitation/request": McpServerElicitationRequestResponseSchema,
  applyPatchApproval: ApplyPatchApprovalResponseSchema,
  execCommandApproval: ExecCommandApprovalResponseSchema,
  "account/chatgptAuthTokens/refresh": "error",
  "attestation/generate": "error",
};

test("every request the schemas know is read, and refused in the words Codex takes for a refusal", () => {
  expect(ServerRequestSchema.options.length).toBe(10);
  for (const option of ServerRequestSchema.options) {
    const method = option.shape.method.value;
    const real = CAPTURED.find((captured) => captured.id !== undefined && captured.method === method);
    const frame = readFrame(line(real ?? minimalInstance(option)));
    expect(frame.kind).toBe("request");
    const refusal = refusalOf(method);
    const expected = REPLY_SCHEMAS[method];
    if (expected === "error") {
      expect(refusal).toMatchObject({ error: { code: -32601 } });
    } else {
      expect("result" in refusal && z.safeParse(expected, refusal.result).success).toBe(true);
    }
  }
});

test("a method the schemas do not know is a typed unknown variant that keeps the message as it arrived", () => {
  const sent = { jsonrpc: "2.0", method: "novel/thing", params: { n: 1, nested: { a: [1, 2] } } };
  expect(readFrame(line(sent))).toEqual({
    kind: "unknown",
    method: "novel/thing",
    id: undefined,
    variant: VariantNameSchema.parse("novel/thing"),
    params: sent.params,
    raw: sent,
  });
  expect(CODEX_PROTOCOL).toBe(ProtocolNameSchema.parse("codex app-server"));
});

test("a request the schemas do not know keeps its id, so it can be answered", () => {
  const sent = { id: "q-1", method: "novel/ask", params: {} };
  expect(readFrame(line(sent))).toMatchObject({ kind: "unknown", id: "q-1", variant: "novel/ask", method: "novel/ask" });
});

test("a known method whose parameters are not what the snapshot says is an unknown variant too", () => {
  const sent = { method: "thread/status/changed", params: { threadId: "t", status: { type: "from-the-future" } } };
  expect(readFrame(line(sent))).toMatchObject({ kind: "unknown", variant: "thread/status/changed", raw: sent });
  const request = { id: 7, method: "item/commandExecution/requestApproval", params: {} };
  expect(readFrame(line(request))).toMatchObject({ kind: "unknown", id: 7, variant: "item/commandExecution/requestApproval" });
});

test("an item of a type the snapshot does not know is named by that type", () => {
  const started = ServerNotificationSchema.options.find((option) => option.shape.method.value === "item/started");
  if (started === undefined) throw new Error("no item/started");
  const made = z.object({ params: z.object({}).loose() }).loose().parse(minimalInstance(started));
  const sent = { ...made, params: { ...made.params, item: { type: "hologram", id: "i-1" } } };
  expect(readFrame(line(sent))).toMatchObject({ kind: "unknown", method: "item/started", variant: "item/started:hologram" });
});

test("a line that is not JSON, or not JSON-RPC, is unreadable, and says so", () => {
  expect(readFrame("not json")).toMatchObject({ kind: "unreadable" });
  expect(readFrame("[1, 2]")).toMatchObject({ kind: "unreadable" });
  expect(readFrame('{"jsonrpc":"2.0"}')).toMatchObject({ kind: "unreadable" });
});

test("the answer to a call, and the failure of one, are read with the id of the call", () => {
  expect(readFrame(line({ id: 3, result: { thread: { id: "t" } } }))).toMatchObject({ kind: "response", id: 3 });
  expect(readFrame(line({ id: 3, error: { code: -32600, message: "bad" } }))).toMatchObject({ kind: "failure", id: 3, error: { message: "bad" } });
});

function incomingOfCaptured(method: string, type?: string): Incoming {
  const captured = CAPTURED.find((frame) => frame.method === method && frame.params.item?.type === type);
  if (captured === undefined) throw new Error(`nothing captured for ${method} ${String(type)}`);
  return incomingOf(notificationOf(readFrame(line(captured))));
}

test("a turn begins and ends with the notifications of its turn", () => {
  expect(incomingOfCaptured("turn/started")).toEqual({ kind: "turn-started", turnId: "00000000-0000-4000-8000-000000000002" });
  expect(incomingOfCaptured("turn/completed")).toEqual({ kind: "turn-ended", turn: { status: "completed", message: undefined } });
});

test("the final answer of the turn is the agent's message that is done, and nothing else is", () => {
  expect(incomingOfCaptured("item/completed", "agentMessage")).toMatchObject({ kind: "answer", text: "ok" });
  // Started, it has no text yet; a commentary is not the answer.
  expect(incomingOfCaptured("item/started", "agentMessage")).toMatchObject({ kind: "sign" });
  const commentary = JSON.parse(line(CAPTURED.find((frame) => frame.method === "item/completed" && frame.params.item?.type === "agentMessage"))) as {
    params: { item: { phase: string } };
  };
  commentary.params.item.phase = "commentary";
  expect(incomingOf(notificationOf(readFrame(line(commentary))))).toMatchObject({ kind: "sign" });
});

test("what Codex answers itself is a request nobody waits for any more", () => {
  expect(incomingOfCaptured("serverRequest/resolved")).toEqual({ kind: "request-resolved", detail: "serverRequest/resolved", requestId: 0 });
});

test("the work of the turn is a sign of life; the account and the installation are not", () => {
  expect(incomingOfCaptured("item/agentMessage/delta")).toEqual({ kind: "sign", detail: "item/agentMessage/delta" });
  expect(incomingOfCaptured("thread/tokenUsage/updated")).toMatchObject({ kind: "sign" });
  expect(incomingOfCaptured("account/rateLimits/updated")).toEqual({ kind: "ignored" });
  expect(incomingOfCaptured("remoteControl/status/changed")).toEqual({ kind: "ignored" });
});

test("a turn that began or ended is still known to have, when the rest of its notification is not what it was", () => {
  expect(incomingOfDrifted("turn/started", { turn: { id: "t9", more: true } })).toEqual({ kind: "turn-started", turnId: "t9" });
  expect(incomingOfDrifted("turn/completed", { turn: { id: "t9", status: "paused", error: { message: "why" } } })).toEqual({
    kind: "turn-ended",
    turn: { status: "paused", message: "why" },
  });
  // An end that cannot be read is an end that is not a success.
  expect(incomingOfDrifted("turn/completed", { nothing: true })).toEqual({ kind: "turn-ended", turn: { status: "was not readable", message: undefined } });
  expect(incomingOfDrifted("serverRequest/resolved", { requestId: "r" })).toMatchObject({ kind: "request-resolved", requestId: "r" });
  expect(incomingOfDrifted("novel/thing", { n: 1 })).toBeUndefined();
});

test("the answer of a turn is kept when its message carries a field the snapshot does not know, and a commentary is still not the answer", () => {
  const message = (phase: string | null | "absent", extra: Record<string, JsonValue>) => ({
    item: { type: "agentMessage", id: "m-1", text: "the answer", ...(phase === "absent" ? {} : { phase }), ...extra },
  });
  const drifted = { moderation: { from: "the future" } };
  expect(incomingOfDrifted("item/completed", message("final_answer", drifted))).toEqual({
    kind: "answer",
    detail: "item/completed agentMessage",
    text: "the answer",
  });
  expect(incomingOfDrifted("item/completed", message(null, drifted))).toMatchObject({ kind: "answer", text: "the answer" });
  expect(incomingOfDrifted("item/completed", message("absent", drifted))).toMatchObject({ kind: "answer" });
  expect(incomingOfDrifted("item/completed", message("commentary", drifted))).toEqual({ kind: "sign", detail: "item/completed agentMessage" });
  expect(incomingOfDrifted("item/started", message("final_answer", drifted))).toEqual({ kind: "sign", detail: "item/started agentMessage" });
});

test("the paths of a file change are kept when the change carries a kind the snapshot does not know", () => {
  const started = { item: { type: "fileChange", id: "patch-9", changes: [{ path: "/work/a.txt", kind: { type: "teleport" } }] } };
  expect(incomingOfDrifted("item/started", started)).toEqual({
    kind: "file-change",
    detail: "item/started fileChange",
    itemId: "patch-9",
    paths: ["/work/a.txt"],
  });
  // An item of a type that is not known at all is still the agent at work.
  expect(incomingOfDrifted("item/completed", { item: { type: "hologram" } })).toEqual({ kind: "sign", detail: "item/completed hologram" });
  expect(incomingOfDrifted("item/completed", { item: "not an item" })).toBeUndefined();
});
