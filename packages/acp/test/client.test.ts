import { expect, test } from "bun:test";

import { AcpClient } from "../src/index.ts";
import type { AcpClientOptions, AgentNotification, AgentRequest } from "../src/index.ts";

function client(overrides: Partial<AcpClientOptions> = {}) {
  const written: Array<Record<string, unknown>> = [];
  const requests: AgentRequest[] = [];
  const notifications: AgentNotification[] = [];
  const unreadable: string[] = [];
  let overflowed = 0;
  const acp = new AcpClient({
    write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
    onRequest: (request) => requests.push(request),
    onNotification: (notification) => notifications.push(notification),
    onUnreadable: (line) => unreadable.push(line),
    onOverflow: () => {
      overflowed += 1;
    },
    callTimeoutMs: 1_000,
    ...overrides,
  });
  return { acp, written, requests, notifications, unreadable, overflowed: () => overflowed };
}

test("an answer settles the call of its id, even when it comes in pieces and out of order", async () => {
  const { acp, written } = client();
  const first = acp.request("a", {});
  const second = acp.request("b", {});
  expect(written.map((frame) => [frame["id"], frame["method"]])).toEqual([
    [1, "a"],
    [2, "b"],
  ]);
  acp.feed('{"jsonrpc":"2.0","id":2,"res');
  acp.feed('ult":{"x":2}}\n{"jsonrpc":"2.0","id":1,"result":{"x":1}}\n');
  expect(await first).toEqual({ ok: true, result: { x: 1 } });
  expect(await second).toEqual({ ok: true, result: { x: 2 } });
  expect(acp.waiting).toBe(0);
});

test("a call fails by how far it got: refused, never written, unanswered in time, or cut off by the close", async () => {
  const { acp } = client();
  const refused = acp.request("a", {});
  acp.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"busy"}}');
  expect(await refused).toEqual({ ok: false, error: "busy", code: -32000, dispatch: "refused" });

  const unwritable = client({
    write: () => {
      throw new Error("closed pipe");
    },
  }).acp;
  expect(await unwritable.request("a", {})).toEqual({ ok: false, error: "closed pipe", dispatch: "unsent" });

  const slow = client({ callTimeoutMs: 10 });
  expect(await slow.acp.request("a", {})).toEqual({ ok: false, error: "the call a timed out", dispatch: "uncertain", timedOut: true });

  const cut = acp.request("b", {});
  acp.close("the agent exited");
  expect(await cut).toEqual({ ok: false, error: "the agent exited", dispatch: "uncertain" });
  // After the close nothing more is written.
  expect(await acp.request("c", {})).toEqual({ ok: false, error: "the agent exited", dispatch: "unsent" });
});

test("an overdue call is cancelled, given one more timeout, and fails with the timeout even when it is answered", async () => {
  const { acp } = client({ callTimeoutMs: 10 });
  let cancelled = 0;
  const call = acp.request("prompt", {}, { overdue: () => (cancelled += 1) });
  await Bun.sleep(15);
  expect(cancelled).toBe(1);
  acp.receive('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"cancelled"}}');
  expect(await call).toMatchObject({ ok: false, timedOut: true });
});

test("a request of the agent, a notification, a line that is not JSON and one too long each go to their handler", () => {
  const { acp, requests, notifications, unreadable, overflowed } = client({ maxLineBytes: 64 });
  acp.feed('{"jsonrpc":"2.0","id":"r1","method":"session/request_permission","params":{}}\n');
  acp.feed('{"jsonrpc":"2.0","method":"session/update","params":{}}\nnot json\n');
  acp.feed('{"jsonrpc":"1.0","method":"other"}\n');
  expect(requests.map((request) => request.id)).toEqual(["r1"]);
  expect(notifications.map((notification) => notification.method)).toEqual(["session/update"]);
  expect(unreadable).toEqual(["not json"]);
  acp.feed("x".repeat(100));
  expect(overflowed()).toBe(1);
});

test("a reply and a refusal answer the agent's request by its id", () => {
  const { acp, written } = client();
  acp.reply("r1", { outcome: "allowed" });
  acp.refuse(7, -32601, "not served");
  acp.notify("session/cancel", { sessionId: "s" });
  expect(written).toEqual([
    { jsonrpc: "2.0", id: "r1", result: { outcome: "allowed" } },
    { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "not served" } },
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
  ]);
});

test("an answer settles the call of its own id only: a string that reads as the number is another id", async () => {
  const { acp, unreadable } = client({ callTimeoutMs: 50 });
  const call = acp.request("a", {});
  acp.receive('{"jsonrpc":"2.0","id":"1","result":{"x":1}}');
  expect(acp.waiting).toBe(1);
  expect(unreadable).toEqual([]);
  expect(await call).toMatchObject({ ok: false, timedOut: true });
});

test("a frame with a method and an id is a request even when the id is null, and without an id it is a notification", () => {
  const { acp, requests, notifications, written } = client();
  acp.receive('{"jsonrpc":"2.0","id":null,"method":"session/request_permission","params":{}}');
  acp.receive('{"jsonrpc":"2.0","method":"session/update","params":{}}');
  expect(requests.map((request) => request.id)).toEqual([null]);
  expect(notifications.map((notification) => notification.method)).toEqual(["session/update"]);
  acp.refuse(null, -32601, "not served");
  acp.reply(null, {});
  expect(written).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "not served" } },
    { jsonrpc: "2.0", id: null, result: {} },
  ]);
});

test("a request whose id is neither a string, a number nor null is unreadable", () => {
  const { acp, requests, unreadable } = client();
  acp.receive('{"jsonrpc":"2.0","id":{"a":1},"method":"m","params":{}}');
  acp.receive('{"jsonrpc":"2.0","id":true,"method":"m","params":{}}');
  expect(requests).toEqual([]);
  expect(unreadable).toHaveLength(2);
});
