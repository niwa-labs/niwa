// What the server tells its client about changes of its tools, and what it follows to know.

import { afterEach, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../src/index.ts";
import type { McpServerOptions } from "../src/index.ts";
import { declared, FakeHost, until } from "./fake-host.ts";

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close().catch(() => {});
});

async function started(host: FakeHost, options: Partial<McpServerOptions> = {}) {
  const mcp = createMcpServer({ home: "home", connect: host.connect, refreshMs: 40, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed += 1;
  });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  open.push(async () => {
    await client.close();
    await mcp.close();
  });
  const names = async (): Promise<string[]> => (await client.listTools()).tools.map((tool) => tool.name).sort();
  return { mcp, client, names, changed: () => changed };
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a connection with no mark is told of a workflow registered after it connected", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  const { names, changed } = await started(host, { refreshMs: 600_000 });
  expect(await names()).toEqual(["a_one"]);
  await until(() => host.subscriptions.length === 1, "the watch to start");

  host.actions = [declared("a.one"), declared("flow.wf-abc123")];
  host.commit("workflow.registered");
  await until(() => changed() === 1, "the notification");
  expect(await names()).toEqual(["a_one", "flow_wf_abc123"]);
});

test("a promoted built-in workflow, a new task and a record of no interest are told apart", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  const { names, changed } = await started(host, { refreshMs: 600_000 });
  await names();
  await until(() => host.subscriptions.length === 1, "the watch to start");
  // The feed is asked for these records only; the rest never reaches the server.
  expect(host.subscriptions[0]?.types).toEqual(
    expect.arrayContaining(["workflow.registered", "workflow.rechecked", "workflow.builtin.promoted", "task.created", "task.done"]),
  );
  expect(host.subscriptions[0]?.types).not.toContain("request.created");

  host.actions = [{ ...declared("a.one"), description: "The promoted version." }];
  host.commit("workflow.builtin.promoted");
  await until(() => changed() === 1, "the notification for the promotion");
  await names();

  // Nothing about the tools moved: a record that is followed changes nothing for the client.
  host.commit("task.created");
  await settle();
  expect(changed()).toBe(1);
});

test("the questions of a session are followed only when the server serves a session", async () => {
  const marked = new FakeHost();
  marked.actions = [declared("a.one")];
  const first = await started(marked, { mark: "mark-1", refreshMs: 600_000 });
  await first.names();
  await until(() => marked.subscriptions.length === 1, "the watch to start");
  expect(marked.subscriptions[0]?.types).toEqual(expect.arrayContaining(["request.created", "session.marked", "workflow.registered"]));

  const plain = new FakeHost();
  plain.actions = [declared("a.one")];
  const second = await started(plain, { refreshMs: 600_000 });
  await second.names();
  await until(() => plain.subscriptions.length === 1, "the watch to start");
  expect(plain.subscriptions[0]?.types).not.toContain("request.created");
});

test("the watch starts from the end of the journal without reading its history", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  host.commit("workflow.registered");
  host.commit("task.created");
  host.commit("task.done");
  const { names } = await started(host, { refreshMs: 600_000 });
  await names();
  await until(() => host.subscriptions.length === 1, "the watch to start");
  expect(host.subscriptions[0]?.from).toBe(3);
  expect(host.calls.filter((call) => call.action === "niwa.records.read")).toEqual([
    { action: "niwa.records.read", input: expect.objectContaining({ tail: 1 }) },
  ]);
});

test("a change that lands after the first list and before the watch is not lost", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  let release: () => void = () => undefined;
  host.readGate = new Promise((resolve) => {
    release = resolve;
  });
  const { client, changed } = await started(host, { refreshMs: 600_000 });
  await client.listTools();
  // Registered, and recorded, before the watch reads where the journal ends: the feed starts after it.
  host.actions = [declared("a.one"), declared("flow.wf-late")];
  host.commit("workflow.registered");
  release();
  await until(() => changed() === 1, "the notification");
});

test("a session that may not read the journal is told of a change by looking again", async () => {
  const host = new FakeHost();
  host.readMode = "denied";
  host.actions = [declared("a.one")];
  const { names, changed } = await started(host, { mark: "mark-1" });
  expect(await names()).toEqual(["a_one"]);
  await settle();
  expect(host.subscriptions).toEqual([]);
  // Looking again alone tells nothing while nothing changed.
  expect(changed()).toBe(0);

  host.actions = [declared("a.one"), declared("flow.wf-abc123")];
  await until(() => changed() === 1, "the notification");
  expect(await names()).toEqual(["a_one", "flow_wf_abc123"]);
  await settle();
  expect(changed()).toBe(1);
});

test("a server that ended stops looking at its tools", async () => {
  const host = new FakeHost();
  host.readMode = "denied";
  host.actions = [declared("a.one")];
  const { mcp, names } = await started(host);
  await names();
  await until(() => host.described > 2, "a few looks");
  await mcp.close();
  const after = host.described;
  await settle(200);
  expect(host.described).toBe(after);
});
