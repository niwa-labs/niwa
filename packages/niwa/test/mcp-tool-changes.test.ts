// A client of the MCP surface is told when its tools change, whoever it is: the owner on an ordinary
// connection, and a session that holds a narrow grant and may not read the journal.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { action, grant, principalOf, record } from "@niwa-labs/core";
import type { Token } from "@niwa-labs/core";
import { connect, readOwnerToken } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { eventually, tempHome } from "@niwa-labs/testing";
import { timers } from "@niwa-labs/timer";
import { workflow, workflowRegister } from "@niwa-labs/workflow";
import { createMcpServer } from "@niwa-labs/mcp";
import { z } from "zod";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
}, 60_000);

const Ping = record("ping.sent", z.object({ id: z.string() }));

const greet = action("changes.greet", {
  description: "Greets.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  recovery: "repeat",
  effect: "read",
  run: async () => ({ ok: true }),
});

/** A plugin installed while the host runs: its action is a tool nobody listed yet. */
const later = plugin("changes-later", (api) => {
  api.action(
    action("changes.later", {
      description: "Declared after the clients connected.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      recovery: "repeat",
      effect: "read",
      run: async () => ({ ok: true }),
    }),
  );
});

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("changes", (api) => {
    api.declare(Ping);
    api.action(greet);
  }), workflow({ triggers: [Ping] }));
  await host.serve();
  cleanups.unshift(() => host.close());
  return { host, home: home.path };
}

async function listening(home: string, token: Token | undefined, refreshMs: number) {
  const mcp = createMcpServer({ home, refreshMs, ...(token === undefined ? {} : { token }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed += 1;
  });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  cleanups.unshift(async () => {
    await client.close();
    await mcp.close();
  });
  const names = async (): Promise<string[]> => (await client.listTools()).tools.map((tool) => tool.name).sort();
  return { names, changed: () => changed };
}

test("the owner on an ordinary connection is told of a workflow registered after it connected", async () => {
  const { host, home } = await served();
  // A long interval: only the journal can tell it.
  const { names, changed } = await listening(home, readOwnerToken(home), 600_000);
  const before = await names();

  await mkdir(home, { recursive: true });
  const file = join(home, "double.ts");
  await writeFile(file, 'export default workflow({ description: "Double", input: z.object({ n: z.number() }), output: z.number() }, async ({ n }) => n * 2);');
  const { id } = await host.call(workflowRegister, { file });

  await eventually(() => changed() === 1, 10_000, "no list_changed for the registered workflow");
  const after = await names();
  expect(after.filter((name) => !before.includes(name))).toEqual([`flow_${id.replace("-", "_")}`]);
}, 60_000);

test("a session that may not read the journal is told of a tool declared after it connected", async () => {
  const { host, home } = await served();
  const secret = host.issueToken(principalOf("session", "narrow"), { grant: grant(["changes.greet"]) });
  // The premise: this grant does not read the journal.
  const probe = await connect({ home, id: "session:narrow", token: secret });
  cleanups.unshift(() => probe.close());
  await expect(probe.records.read()).rejects.toThrow();

  const { names, changed } = await listening(home, secret, 100);
  expect(await names()).toContain("changes_greet");
  expect(await names()).not.toContain("changes_later");

  host.use(later);
  await eventually(() => changed() === 1, 10_000, "no list_changed for the declared action");
  expect(await names()).toContain("changes_later");
}, 60_000);
