// The session of an MCP server ends once, whoever ends it, and its core client is closed by then.

import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, serveMcp } from "../src/index.ts";
import { declared, FakeHost, until } from "./fake-host.ts";

async function started(host: FakeHost) {
  const mcp = createMcpServer({ home: "home", connect: host.connect });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  await client.listTools();
  return { mcp, client };
}

test("closing the server returns after the core client is closed", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  host.closeMs = 80;
  const { mcp } = await started(host);
  expect(host.open).toBe(1);
  await mcp.close();
  expect(host.open).toBe(0);
});

test("closing the server after its client went away waits for the same cleanup", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  host.closeMs = 80;
  const { mcp, client } = await started(host);
  await client.close();
  await mcp.close();
  expect(host.open).toBe(0);
  expect(host.opened).toBe(1);
});

test("a call that comes after the session ended opens no client", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  const { mcp, client } = await started(host);
  await mcp.close();
  await expect(client.listTools()).rejects.toThrow();
  expect(host.opened).toBe(1);
  expect(host.open).toBe(0);
});

test("the end of the input of a stdio server releases the connection to the host", async () => {
  const host = new FakeHost();
  host.actions = [declared("a.one")];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const answers: string[] = [];
  stdout.on("data", (chunk: Buffer) => answers.push(...chunk.toString().split("\n").filter((line) => line !== "")));
  const mcp = await serveMcp({ home: "home", connect: host.connect }, { stdin, stdout });
  let ended = false;
  const previous = mcp.server.onclose;
  mcp.server.onclose = () => {
    ended = true;
    previous?.();
  };

  const send = (message: object): void => void stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await until(() => answers.some((line) => line.includes('"id":2')), "the list of tools");
  expect(host.open).toBe(1);

  stdin.end();
  await until(() => host.open === 0, "the connection to the host to close");
  expect(ended).toBe(true);
});
