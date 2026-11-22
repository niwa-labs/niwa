// A tools/call the client cancelled carries its cancellation into the call of the host: the
// request's signal reaches the core client's call, so the work that can stop stops instead of
// being waited for by nobody, and the session stays usable for the calls that follow.

import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/index.ts";
import { declared, FakeHost, until } from "./fake-host.ts";

test("a cancelled tools/call passes its signal into the host call, and the session stays usable", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one"), declared("a.slow")];
  // An answer that never comes on its own: only the cancellation of the call ends it.
  host.answers.set("a.slow", (_input: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("the call was cancelled")), { once: true });
  }));
  host.answers.set("a.one", () => ({ fine: true }));
  const mcp = createMcpServer({ home: "home", connect: host.connect });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    const controller = new AbortController();
    const slow = client.callTool({ name: "a_slow", arguments: {} }, undefined, { signal: controller.signal });
    await until(() => host.calls.some((call) => call.action === "a.slow"), "the slow call to reach the host");
    controller.abort();
    await expect(slow).rejects.toThrow();
    // The signal the host call was given is the request's, aborted with it.
    expect(host.calls.find((call) => call.action === "a.slow")?.signal?.aborted).toBe(true);
    // The session is not wedged by the cancelled call: the next tool answers.
    const next = await client.callTool({ name: "a_one", arguments: {} });
    expect(next.isError).toBeFalsy();
  } finally {
    await client.close();
    await mcp.close();
  }
});
