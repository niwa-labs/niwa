import { expect, test } from "bun:test";

import { AcpClient } from "../src/index.ts";
import type { AcpClientOptions, AgentNotification, AgentRequest, RpcOutcome } from "../src/index.ts";

function client(overrides: Partial<AcpClientOptions> = {}) {
  const written: Array<Record<string, unknown>> = [];
  const requests: AgentRequest[] = [];
  const notifications: AgentNotification[] = [];
  const unreadable: string[] = [];
  let overflowed = 0;
  const acp = new AcpClient({
    write: (line) => {
      written.push(JSON.parse(line) as Record<string, unknown>);
      return "accepted";
    },
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
  acp.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"busy"}}');
  expect(await refused).toEqual({ ok: false, error: "busy", code: -32602, dispatch: "refused" });

  const unwritable = client({ write: () => "unsent" }).acp;
  expect(await unwritable.request("a", {})).toEqual({ ok: false, error: "the request was not written", dispatch: "unsent" });

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
  const { acp, requests, notifications, unreadable, overflowed } = client({ maxLineBytes: 128 });
  acp.feed('{"jsonrpc":"2.0","id":"r1","method":"session/request_permission","params":{}}\n');
  acp.feed('{"jsonrpc":"2.0","method":"session/update","params":{}}\nnot json\n');
  acp.feed('{"jsonrpc":"1.0","method":"other"}\n');
  expect(requests.map((request) => request.id)).toEqual(["r1"]);
  expect(notifications.map((notification) => notification.method)).toEqual(["session/update"]);
  expect(unreadable).toEqual(["not json"]);
  acp.feed("x".repeat(200));
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

test("a malformed answer is unreadable and leaves its call waiting for a valid one", async () => {
  const { acp, unreadable } = client();
  const call = acp.request("a", {});
  for (const frame of [
    '{"jsonrpc":"2.0","id":1,"error":null}',
    '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"both"}}',
    '{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":"-1","message":"string code"}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":-1}}',
    '{"jsonrpc":"2.0","id":1,"error":"busy"}',
  ]) {
    acp.receive(frame);
  }
  expect(unreadable).toHaveLength(7);
  expect(acp.waiting).toBe(1);
  acp.receive('{"jsonrpc":"2.0","id":1,"result":null}');
  expect(await call).toEqual({ ok: true, result: null });
  expect(acp.waiting).toBe(0);
});

test("a malformed answer does not stop the close from settling the call", async () => {
  const { acp } = client();
  const call = acp.request("a", {});
  acp.receive('{"jsonrpc":"2.0","id":1,"error":null}');
  acp.close("the agent exited");
  expect(await call).toEqual({ ok: false, error: "the agent exited", dispatch: "uncertain" });
});

/** A notification frame padded to exactly `bytes` bytes (without its newline). */
function frameOf(bytes: number): string {
  const bare = JSON.stringify({ jsonrpc: "2.0", method: "m", params: { pad: "" } });
  return JSON.stringify({ jsonrpc: "2.0", method: "m", params: { pad: "x".repeat(bytes - Buffer.byteLength(bare)) } });
}

/** Every way to cut `text` into two chunks, and the whole of it as one. */
function splits(text: string): string[][] {
  return [[text], ...Array.from({ length: text.length - 1 }, (_, at) => [text.slice(0, at + 1), text.slice(at + 1)])];
}

test("a line over the limit overflows however its chunks are cut, and never reaches the handler", () => {
  const line = frameOf(100);
  expect(Buffer.byteLength(line)).toBe(100);
  for (const chunks of splits(`${line}\n`)) {
    const { acp, notifications, overflowed } = client({ maxLineBytes: 64 });
    for (const chunk of chunks) acp.feed(chunk);
    expect(notifications).toEqual([]);
    expect(overflowed()).toBe(1);
  }
});

test("a line of exactly the limit is read however its chunks are cut", () => {
  const line = frameOf(64);
  for (const chunks of splits(`${line}\n`)) {
    const { acp, notifications, overflowed } = client({ maxLineBytes: 64 });
    for (const chunk of chunks) acp.feed(chunk);
    expect(notifications).toHaveLength(1);
    expect(overflowed()).toBe(0);
  }
});

test("the limit counts bytes, and the lines of a chunk after an overflowing one are not read", () => {
  const { acp, notifications, overflowed } = client({ maxLineBytes: 100 });
  const wide = JSON.stringify({ jsonrpc: "2.0", method: "m", params: { pad: "é".repeat(30) } });
  expect(wide.length).toBeLessThan(100);
  expect(Buffer.byteLength(wide)).toBeGreaterThan(100);
  acp.feed(`${frameOf(100)}\n${wide}\n${frameOf(100)}\n`);
  expect(notifications).toHaveLength(1);
  expect(overflowed()).toBe(1);
  acp.feed(`${frameOf(100)}\n`);
  expect(notifications).toHaveLength(1);
  expect(overflowed()).toBe(1);
});

test("a request the transport did not take fails as unsent at once, and leaves nothing waiting", async () => {
  const { acp } = client({ write: () => "unsent" });
  const calls: unknown[] = [];
  acp.send("session/prompt", {}, (outcome) => calls.push(outcome), { timeoutMs: null });
  expect(calls).toEqual([{ ok: false, error: "the request was not written", dispatch: "unsent" }]);
  expect(acp.waiting).toBe(0);
});

test("a request the transport took, or may have taken, waits for its answer; the close fails it as uncertain", async () => {
  for (const outcome of ["accepted", "unknown"] as const) {
    const { acp } = client({ write: () => outcome });
    const call = acp.request("a", {}, { timeoutMs: null });
    expect(acp.waiting).toBe(1);
    acp.close("the agent exited");
    expect(await call).toEqual({ ok: false, error: "the agent exited", dispatch: "uncertain" });
  }
});

test("a write that throws leaves it unknown whether the request left: the call fails as uncertain", async () => {
  const { acp } = client({
    write: () => {
      throw new Error("closed pipe");
    },
  });
  expect(await acp.request("a", {}, { timeoutMs: null })).toEqual({ ok: false, error: "closed pipe", dispatch: "uncertain" });
  expect(acp.waiting).toBe(0);
});

test("a request that cannot be serialized never reaches the transport and fails as unsent", async () => {
  const { acp, written } = client();
  expect(await acp.request("a", { big: 1n }, { timeoutMs: null })).toMatchObject({ ok: false, dispatch: "unsent" });
  expect(written).toEqual([]);
  expect(acp.waiting).toBe(0);
});

test("a notification, a reply and a refusal say what became of the line", () => {
  for (const outcome of ["accepted", "unsent", "unknown"] as const) {
    const { acp } = client({ write: () => outcome });
    expect(acp.notify("session/cancel", {})).toBe(outcome);
    expect(acp.reply(1, {})).toBe(outcome);
    expect(acp.refuse(1, -32601, "no")).toBe(outcome);
  }
  const throwing = client({
    write: () => {
      throw new Error("closed pipe");
    },
  }).acp;
  expect(throwing.notify("session/cancel", {})).toBe("unknown");
});

test("a closed client reads nothing more: not a late line, not the rest of the chunk that closed it, not a half line", () => {
  const closing: { acp?: AcpClient } = {};
  const seen: string[] = [];
  const first = client({
    onNotification: (notification) => {
      seen.push(notification.method);
      closing.acp?.close("the agent exited");
    },
    onRequest: (request) => seen.push(`request ${String(request.id)}`),
  });
  closing.acp = first.acp;
  first.acp.feed(`${frameOf(60)}\n{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}\n`);
  expect(seen).toEqual(["m"]);
  first.acp.feed('{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}\n');
  first.acp.receive('{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}');
  expect(seen).toEqual(["m"]);

  const half = client();
  half.acp.feed('{"jsonrpc":"2.0","method":"m",');
  half.acp.close("the agent exited");
  half.acp.feed('"params":{}}\n');
  expect(half.notifications).toEqual([]);
});

test("a closed client writes nothing more: not a notification, not a reply, not a refusal", () => {
  const { acp, written } = client();
  acp.close("the agent exited");
  expect(acp.notify("session/cancel", {})).toBe("unsent");
  expect(acp.reply(1, {})).toBe("unsent");
  expect(acp.refuse(1, -32601, "no")).toBe("unsent");
  expect(written).toEqual([]);
});

test("an error answer keeps its code, message and data, and is a refusal only where the code says nothing ran", async () => {
  const { acp } = client();
  const answered = async (code: number, data?: unknown) => {
    const outcomes: RpcOutcome[] = [];
    const id = acp.send("a", {}, (outcome) => outcomes.push(outcome));
    const error = { code, message: "no", ...(data === undefined ? {} : { data }) };
    acp.receive(JSON.stringify({ jsonrpc: "2.0", id, error }));
    return outcomes[0];
  };
  // The codes JSON-RPC reserves for a request that was not understood: nothing was run.
  for (const code of [-32700, -32600, -32601, -32602]) {
    expect(await answered(code)).toEqual({ ok: false, error: "no", code, dispatch: "refused" });
  }
  // Any other error may come from work that was begun: internal, cancelled, authentication, the agent's own.
  for (const code of [-32603, -32800, -32000, -32002, 1]) {
    expect(await answered(code, { why: "late" })).toEqual({ ok: false, error: "no", code, data: { why: "late" }, dispatch: "uncertain" });
  }
});

test("a call whose settle throws does not keep the others from being settled by the close", () => {
  const { acp } = client();
  const seen: RpcOutcome[] = [];
  acp.send("a", {}, () => {
    throw new Error("boom");
  });
  acp.send("b", {}, (outcome) => seen.push(outcome));
  acp.send("c", {}, () => {
    throw new Error("bang");
  });
  acp.send("d", {}, (outcome) => seen.push(outcome));
  // The handlers' errors are reported once every call has its outcome.
  expect(() => acp.close("the agent exited")).toThrow(AggregateError);
  expect(seen).toEqual([
    { ok: false, error: "the agent exited", dispatch: "uncertain" },
    { ok: false, error: "the agent exited", dispatch: "uncertain" },
  ]);
  expect(acp.waiting).toBe(0);

  const single = client().acp;
  single.send("a", {}, () => {
    throw new Error("boom");
  });
  expect(() => single.close("the agent exited")).toThrow("boom");
});
