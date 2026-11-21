// A native session of the owner attached to an agent: the attachment is a record (one agent per session, a
// new one replaces the one before), history watches the session, and the answer is the agent's briefing.

import { afterEach, expect, test } from "bun:test";

import { action, actionRef, agent as agentAddress } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { RequestCreated } from "@niwa-labs/requests";
import { connectAsOwner } from "@niwa-labs/testing";
import { AGENT_BRIEFING, BriefingSectionInput, BriefingSectionOutput } from "@niwa-labs/agent";

import { HARNESS, KIND, agentHost, dataOf, until } from "./fixtures/agent-host.ts";
import type { AgentHost } from "./fixtures/agent-host.ts";

const RIN = { name: "rin", harness: HARNESS, prompt: "You keep the owner's work in order." };
const BOB = { name: "bob", harness: HARNESS, prompt: "Another agent." };

const open: AgentHost[] = [];
afterEach(async () => {
  for (const host of open.splice(0)) await host.close();
});

async function served(...args: Parameters<typeof agentHost>): Promise<AgentHost> {
  const host = await agentHost(...args);
  open.push(host);
  return host;
}

async function asOwner<O>(host: AgentHost, name: string, input: unknown): Promise<O> {
  const client = await connectAsOwner(host.home);
  try {
    return (await client.call(name as ActionName, input)) as O;
  } finally {
    await client.close();
  }
}

type Attached = { agent: string; session: string; replaced?: string; watching: boolean; briefing: string };

test("a native session found by its kind is attached, watched, and answered with the briefing; attaching it elsewhere replaces the agent", async () => {
  const host = await served({ agents: [RIN, BOB] });
  const attached = await asOwner<Attached>(host, "agent.attach", { agent: "rin", kind: KIND, native: "ext-1", cwd: "/work" });
  expect(attached).toMatchObject({ agent: "rin", session: `${HARNESS} ext-1`, watching: true });
  expect(attached.replaced).toBeUndefined();
  expect(attached.briefing).toContain("Agent rin (agent:rin), new;");
  const records = await host.records();
  expect(dataOf(records, "agent.attached")).toEqual([{ agent: "rin", session: `${HARNESS} ext-1`, cwd: "/work" }]);
  expect(dataOf(records, "history.session.seen")).toContainEqual({ session: { harness: HARNESS, native: "ext-1" }, harness: HARNESS, cwd: "/work" });

  // Attached again to the same agent, nothing new is written.
  await asOwner(host, "agent.attach", { agent: "rin", harness: HARNESS, native: "ext-1", cwd: "/work" });
  expect(dataOf(await host.records(), "agent.attached")).toHaveLength(1);

  const moved = await asOwner<Attached>(host, "agent.attach", { agent: "bob", harness: HARNESS, native: "ext-1", cwd: "/work" });
  expect(moved.replaced).toBe("rin");
  expect(await host.host.call("agent.attachment" as ActionName, { session: `${HARNESS} ext-1` })).toEqual({ agent: "bob" });
  expect(await asOwner(host, "agent.detach", { session: `${HARNESS} ext-1` })).toEqual({ agent: "bob" });
  expect(await host.host.call("agent.attachment" as ActionName, { session: `${HARNESS} ext-1` })).toEqual({});
  expect(dataOf(await host.records(), "history.session.unwatched")).toEqual([{ session: { harness: HARNESS, native: "ext-1" } }]);
});

test("a new session of the same harness in the same directory is a sign that the one before it ended", async () => {
  const host = await served({ agents: [RIN] });
  await asOwner(host, "agent.attach", { agent: "rin", harness: HARNESS, native: "ext-1", cwd: "/work" });
  await asOwner(host, "agent.attach", { agent: "rin", harness: HARNESS, native: "ext-2", cwd: "/work" });
  expect(dataOf(await host.records(), "history.session.ended")).toEqual([{ session: { harness: HARNESS, native: "ext-1" }, certainty: "guessed", why: "new-binding" }]);
  // Another directory is another place: nothing is guessed of it.
  await asOwner(host, "agent.attach", { agent: "rin", harness: HARNESS, native: "ext-3", cwd: "/elsewhere" });
  expect(dataOf(await host.records(), "history.session.ended")).toHaveLength(1);
});

test("without a name the default agent is attached, and without a default the attach says why it is refused", async () => {
  const withDefault = await served({ agents: [RIN], default: "rin" });
  expect(await asOwner(withDefault, "agent.attach", { harness: HARNESS, native: "ext-1", cwd: "/work" })).toMatchObject({ agent: "rin" });
  const without = await served({ agents: [RIN] });
  await expect(asOwner(without, "agent.attach", { harness: HARNESS, native: "ext-1", cwd: "/work" })).rejects.toThrow(/no default agent/);
  await expect(asOwner(without, "agent.attach", { agent: "rin", kind: "no-such-kind", native: "ext-1", cwd: "/work" })).rejects.toThrow(/no harness of the kind "no-such-kind"/);
});

const memoryBrief = actionRef("memtest.brief", { description: "A section of the briefing.", input: BriefingSectionInput, output: BriefingSectionOutput });

test("the briefing holds the inbox, the open tasks and questions of the agent, its latest facts and the sections plugins offer", async () => {
  const sections = plugin("memtest", (api) => {
    api.offer(AGENT_BRIEFING, { title: "What it remembers", action: memoryBrief.name });
    api.action(action(memoryBrief, { recovery: "repeat", effect: "read", run: async ({ agent }) => ({ text: `the top notes of ${agent}` }) }));
  });
  const host = await served({ agents: [RIN] }, { after: [sections] });
  await asOwner(host, "task.create", {
    kind: "review",
    description: "review the change",
    text: "Review it.",
    askedBy: agentAddress("rin"),
    responsible: { kind: "owner" },
    reportTo: agentAddress("rin"),
  });
  await host.host.emit(RequestCreated, {
    id: "req-a1b2c3" as never,
    to: { kind: "owner" },
    question: "pick" as never,
    input: { title: "Which release goes first?", kind: "text" } as never,
    from: agentAddress("rin"),
  });
  await asOwner(host, "agent.notify", { agent: "rin", text: "CI is red on main" });
  await until(host.records, "agent.turn.delivered");
  const { text } = await host.host.call("agent.briefing" as ActionName, { agent: "rin" }) as { text: string };
  expect(text).toContain("Tasks it asked for that are open:\n- task-");
  expect(text).toContain("review the change (the owner)");
  expect(text).toContain("Its questions to the owner that wait:\n- req-a1b2c3: Which release goes first?");
  expect(text).toContain("The latest facts it was told:\n- from the owner: CI is red on main");
  expect(text).toContain("What it remembers:\nthe top notes of rin");
});
