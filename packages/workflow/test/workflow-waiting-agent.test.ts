// A run that waits for an agent says which: `agent <harness> session <session> turn N`.
// The agent action here is a stub that records the start of a session and a turn, then holds.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { action, actionName, idSchema } from "@niwa-labs/core";
import { harnessId, sessionId } from "@niwa-labs/harness";
import { plugin } from "@niwa-labs/plugin";
import { SessionStarted, SessionTurnStarted, sessionRef } from "@niwa-labs/sessions/records";
import { createNiwa, gate, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";
import { z } from "zod";

const hosts: Host[] = [];
const homes: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

test("a run waiting for an agent shows its harness, session and turn", async () => {
  const home = await tempHome();
  homes.push(home);
  const session = sessionRef(sessionId(harnessId("fake"), "0a1b2c3d-1111-2222-3333-444455556666"));
  const fake = action("session.start.fake", {
    description: "A stub agent: it starts a session and a turn, and holds.",
    input: z.object({ prompt: z.string() }),
    output: z.object({ answer: z.string() }),
    recovery: "repeat",
    effect: "write",
    run: async (_input, ctx) => {
      await ctx.emit(SessionStarted, { session, id: idSchema("session").parse("s-0a1b2c") });
      await ctx.emit(SessionTurnStarted, { session, turn: 1 });
      await gate(home.path, "agent-held").wait();
      return { answer: "done" };
    },
  });
  const host = createNiwa({ home: home.path });
  host.use(
    plugin("fake-agent", (api) => {
      api.declare(SessionStarted, SessionTurnStarted);
      api.action(fake);
    }),
    workflow({ agents: { fake } }),
  );
  await host.serve();
  hosts.push(host);
  await mkdir(home.path, { recursive: true });
  const file = join(home.path, "agent.js");
  await writeFile(file, 'export default workflow({ output: z.json() }, async () => { return await agent("hello", { harness: "fake" }); });');
  await host.call(actionName("workflow.start"), { file });
  const started = Date.now();
  let line = "";
  while (!line.includes("turn 1") && Date.now() - started < 20_000) {
    line = ((await host.call(actionName("workflow.runs"), {})) as { runs: string[] }).runs[0] ?? "";
    await Bun.sleep(100);
  }
  expect(line).toContain("running  agent fake session s-0a1b2c turn 1");
  gate(home.path, "agent-held").open();
}, 30_000);
