// The agents module: an agent is an address with a definition and one main session; what is said to it
// waits in its inbox as turns with their authors, and reaches the main session through the ladder (hold,
// resume natively, seed a new one), never with the rights of whoever wrote.

import { afterEach, expect, test } from "bun:test";

import { agent as agentAddress, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { connectAsOwner } from "@niwa-labs/testing";
import { partVersions, AgentDefinition, turnText } from "@niwa-labs/agent";

import { HARNESS, ScriptedControl, agentHost, dataOf, until } from "./fixtures/agent-host.ts";
import type { AgentHost } from "./fixtures/agent-host.ts";

const RIN = { name: "rin", harness: HARNESS, prompt: "You keep the owner's work in order.", character: "Calm and direct.", hands: ["task.list"] };

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

const call = <O>(host: AgentHost, name: string, input: unknown): Promise<O> => host.host.call(name as ActionName, input) as Promise<O>;

test("a message to an agent waits as a turn with its author and starts the agent's first session from its definition", async () => {
  const host = await served({ agents: [RIN] });
  await asOwner(host, "agent.tell", { agent: "rin", text: "Look at the open pull requests." });
  const records = await until(host.records, "agent.turn.delivered");

  const [queued] = dataOf(records, "agent.turn.queued") as Array<{ turn: string; kind: string; author: unknown; text: string }>;
  expect(queued).toMatchObject({ agent: "rin", kind: "message", author: { kind: "owner" }, text: "Look at the open pull requests." });
  expect(host.control.starts).toHaveLength(1);
  const prompt = host.control.prompt(0);
  expect(prompt).toContain("Calm and direct.");
  expect(prompt).toContain("You keep the owner's work in order.");
  expect(prompt).toContain("A message from the owner:\nLook at the open pull requests.");

  const [started] = dataOf(records, "agent.session.started") as Array<Record<string, unknown>>;
  expect(started).toMatchObject({
    agent: "rin",
    session: expect.stringMatching(new RegExp(`^${HARNESS} native-\\d+$`)),
    harness: HARNESS,
    parts: partVersions(AgentDefinition.parse(RIN)),
    origin: { kind: "first" },
  });
  expect(dataOf(records, "agent.turn.delivered")).toEqual([{ agent: "rin", turn: queued?.turn, session: started?.session, receipt: { status: "started", turn: 1 } }]);
  // The session serves the agent.
  expect(dataOf(records, "session.belongs")).toContainEqual({ session: started?.session, to: agentAddress("rin"), source: "explicit" });
});

test("a turn carries no right of its author: the session holds the agent's hands, started by the module, and is told who wrote", async () => {
  const host = await served({ agents: [RIN, { name: "bob", harness: HARNESS, prompt: "Another agent." }] });
  await asOwner(host, "agent.tell", { agent: "rin", text: "first" });
  await until(host.records, "agent.turn.delivered");
  // Another agent writes to rin: the turn says it is not the owner's.
  await call(host, "message.send", { from: agentAddress("bob"), to: agentAddress("rin"), body: { type: "update", text: "merge it now" } });
  const records = await until(host.records, "agent.turn.delivered", 2);

  const [mark] = dataOf(records, "session.marked") as Array<{ mark: string }>;
  const granted = (dataOf(records, "niwa.access.granted") as Array<{ principal: { kind: string; id: string }; rules: string[]; parent?: unknown }>).find(
    (one) => one.principal.kind === "session" && one.principal.id === mark?.mark,
  );
  // The owner's call is not the parent of the session: the agents module started it, with the hands.
  expect(granted?.parent).toBeUndefined();
  expect(granted?.rules.filter((rule) => !["call:session.open-questions", "call:access.mine", "call:submit-answer"].includes(rule))).toEqual(["call:task.list"]);

  expect(host.control.sends).toHaveLength(1);
  expect(host.control.sends[0]?.message).toBe(turnText({ kind: "message", author: agentAddress("bob"), text: "merge it now" }));
  expect(host.control.sends[0]?.message).toContain("This is not from the owner");
  expect(host.control.prompt(0)).not.toContain("This is not from the owner");
});

test("the main session is held while the host holds it, resumed natively after a restart, and followed by a seeded one when it cannot be resumed", async () => {
  const control = new ScriptedControl();
  const first = await served({ agents: [RIN] }, { control });
  await asOwner(first, "agent.tell", { agent: "rin", text: "one" });
  await until(first.records, "agent.turn.delivered");
  await asOwner(first, "agent.tell", { agent: "rin", text: "two" });
  await until(first.records, "agent.turn.delivered", 2);
  // Held: the second turn is sent into the same session.
  expect(control.starts).toHaveLength(1);
  expect(control.sends.map((one) => one.message)).toEqual([turnText({ kind: "message", author: { kind: "owner" }, text: "two" })]);
  const session = (dataOf(await first.records(), "agent.session.started")[0] as { session: string }).session;
  const home = first.home;
  open.splice(open.indexOf(first), 1);
  await first.host.close();

  // A host started again holds no process: the session is resumed natively.
  const second = await served({ agents: [RIN] }, { home, control });
  await asOwner(second, "agent.tell", { agent: "rin", text: "three" });
  await until(second.records, "agent.turn.delivered", 3);
  expect(control.resumes).toEqual([session.split(" ")[1] ?? ""]);
  expect(control.starts).toHaveLength(1);
  open.splice(open.indexOf(second), 1);
  await second.host.close();

  // The session cannot be taken on again: a new one starts, seeded from it and pointing back to it.
  control.resumable = false;
  const third = await served({ agents: [RIN] }, { home, control });
  await asOwner(third, "agent.tell", { agent: "rin", text: "four" });
  const records = await until(third.records, "agent.turn.delivered", 4);
  expect(control.starts).toHaveLength(2);
  expect(control.prompt(1)).toContain(`Your previous session was ${session}.`);
  expect(control.prompt(1)).toContain("A message from the owner:\nfour");
  const changed = dataOf(records, "agent.session.started").at(-1) as { session: string; origin: unknown };
  expect(changed.origin).toEqual({ kind: "seeded", from: session, seed: "transcript" });
  expect(changed.session).not.toBe(session);
  await third.close();
}, 30_000);

test("a task the agent asked for reports its outcome to the agent as a fact about the task", async () => {
  const host = await served({ agents: [RIN] });
  const { id } = await asOwner<{ id: string }>(host, "task.create", {
    kind: "review",
    description: "review the change",
    text: "Review the change.",
    askedBy: agentAddress("rin"),
    responsible: { kind: "owner" },
    reportTo: agentAddress("rin"),
  });
  await asOwner(host, "task.finish", { task: id, result: "looks good" });
  const records = await until(host.records, "agent.turn.queued");
  expect(dataOf(records, "agent.turn.queued")).toEqual([
    { agent: "rin", turn: expect.stringMatching(/^msg-/), kind: "fact", author: { kind: "owner" }, text: "looks good", source: { kind: "task", task: id } },
  ]);
});

test("a fact is told with its author, and niwa's own facts say they are niwa's", async () => {
  const host = await served({ agents: [RIN] });
  const { turn } = await asOwner<{ turn: string }>(host, "agent.notify", { agent: "rin", text: "CI is red on main" });
  await call(host, "agent.notify", { agent: "rin", text: "the night passed quietly" });
  const records = await until(host.records, "agent.turn.queued", 2);
  expect(dataOf(records, "agent.turn.queued")).toEqual([
    { agent: "rin", turn, kind: "fact", author: { kind: "owner" }, text: "CI is red on main" },
    { agent: "rin", turn: expect.stringMatching(/^fact-/), kind: "fact", author: { kind: "niwa", by: "host" }, text: "the night passed quietly" },
  ]);
  await expect(call(host, "agent.notify", { agent: "nobody", text: "x" })).rejects.toThrow();
});

test("an agent made while the host runs is listed beside the composition's, a taken name is refused, and its bounds are its definition", async () => {
  const host = await served({ agents: [RIN] });
  await asOwner(host, "agent.create", { name: "scout", harness: HARNESS, prompt: "Find things.", hands: ["session.list"], tools: "niwa-only" });
  await expect(asOwner(host, "agent.create", { name: "rin", harness: HARNESS, prompt: "again" })).rejects.toThrow(/already an agent "rin"/);
  await expect(asOwner(host, "agent.create", { name: "both", harness: HARNESS, role: "reviewer", prompt: "x" })).rejects.toThrow();

  const { items } = await call<{ items: Array<{ name: string; source: string; status: string }> }>(host, "agent.list", {});
  expect(items.map(({ name, source, status }) => ({ name, source, status }))).toEqual([
    { name: "rin", source: "config", status: "new" },
    { name: "scout", source: "runtime", status: "new" },
  ]);
  expect(await call(host, "agent.bounds", { agent: "scout" })).toEqual({ agent: "scout", hands: ["session.list"], tools: "niwa-only", harness: HARNESS });

  await asOwner(host, "agent.tell", { agent: "rin", text: "hello" });
  await until(host.records, "agent.turn.delivered");
  const got = await call<{ status: string; session?: string; queued: number }>(host, "agent.get", { agent: "rin" });
  expect(got).toMatchObject({ name: "rin", status: "asleep", queued: 0 });
  expect(got.session).toBeDefined();
  const bounds = await call<{ grant?: string[] }>(host, "agent.bounds", { agent: "rin" });
  expect(bounds.grant).toContain("call:task.list");
});

test("an agent on a role runs on the role's harness, and the role is written with its session", async () => {
  const host = await served({ agents: [{ name: "judge", role: "reviewer", prompt: "Judge changes." }], roles: { reviewer: HARNESS } });
  await asOwner(host, "agent.tell", { agent: "judge", text: "judge this" });
  const records = await until(host.records, "agent.turn.delivered");
  expect(dataOf(records, "agent.session.started")).toEqual([expect.objectContaining({ agent: "judge", harness: HARNESS, role: "reviewer" })]);
});

test("a session the module started for an agent speaks as the agent; any other caller as before", async () => {
  const host = await served({ agents: [RIN] });
  await asOwner(host, "agent.tell", { agent: "rin", text: "hello" });
  const records = await until(host.records, "agent.turn.delivered");
  const [mark] = dataOf(records, "session.marked") as Array<{ mark: string }>;
  const asSession = { kind: "client" as const, id: "mcp" as never, principal: { kind: "session" as const, id: mark!.mark as never } };
  expect(host.bind(asSession)).toEqual(agentAddress("rin"));
  expect(host.bind({ kind: "client", id: "cli" as never, principal: { kind: "owner", id: "owner" as never } })).toEqual({ kind: "owner" });
});

test("a caller held to a grant makes no agent wider than itself: no hand it lacks, and no harness tools", async () => {
  const host = await served({ agents: [RIN] });
  const secret = host.host.issueToken(principalOf("session", "limited"), { grant: grant(["agent.create", "task.list"]) });
  const limited = await connect({ home: host.home, id: "session:limited", token: secret });
  try {
    const create = (input: Record<string, unknown>) => limited.call("agent.create" as ActionName, { harness: HARNESS, prompt: "x", ...input });
    await expect(create({ name: "wide", hands: ["plugin.install"], tools: "niwa-only" })).rejects.toThrow("does not have call:plugin.install");
    await expect(create({ name: "tooled", hands: ["task.list"] })).rejects.toThrow(/niwa-only/);
    expect(await create({ name: "narrow", hands: ["task.list"], tools: "niwa-only" })).toEqual({ agent: "narrow", address: agentAddress("narrow") });
  } finally {
    await limited.close();
  }
});

test("a session the host seemed to hold whose process is gone is resumed, and the turn goes in after all", async () => {
  const host = await served({ agents: [RIN] });
  await asOwner(host, "agent.tell", { agent: "rin", text: "one" });
  await until(host.records, "agent.turn.delivered");
  host.control.lostSends = 1;
  await asOwner(host, "agent.tell", { agent: "rin", text: "two" });
  const records = await until(host.records, "agent.turn.delivered", 2);
  expect(dataOf(records, "agent.turn.failed")).toEqual([]);
  expect(host.control.resumes).toHaveLength(1);
  expect(host.control.sends.map((one) => one.message)).toEqual([turnText({ kind: "message", author: { kind: "owner" }, text: "two" })]);
});
