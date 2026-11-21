// What an assignment carries reaches the agent it is given to: the task, the kind of work and the shape of the result,
// not only the words of the text.

import { afterEach, expect, test } from "bun:test";

import { agent as agentAddress } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";

import { HARNESS, agentHost, dataOf, until } from "./fixtures/agent-host.ts";
import type { AgentHost } from "./fixtures/agent-host.ts";

const RIN = { name: "rin", harness: HARNESS, prompt: "You keep the owner's work in order." };

const open: AgentHost[] = [];
afterEach(async () => {
  for (const host of open.splice(0)) await host.close();
});

test("an assignment to an agent reaches its session with the task, the kind of work and the result schema, from its author", async () => {
  const host = await agentHost({ agents: [RIN] });
  open.push(host);
  const result = { type: "object", properties: { merged: { type: "boolean" } }, required: ["merged"] };
  await host.host.call("message.send" as ActionName, {
    from: agentAddress("bob"),
    to: agentAddress("rin"),
    task: "task-3fa9c2",
    body: { type: "assignment", text: "Merge the open pull request.", kind: "review", result },
  });
  const records = await until(host.records, "agent.turn.delivered");

  const [queued] = dataOf(records, "agent.turn.queued") as Array<{ kind: string; author: unknown; text: string }>;
  expect(queued).toMatchObject({ kind: "message", author: agentAddress("bob") });
  for (const part of ["Merge the open pull request.", "Task: task-3fa9c2", "Kind of work: review", "The result must fit this JSON Schema:", '"required":["merged"]']) {
    expect(queued?.text).toContain(part);
  }

  // The session reads the same, with the author in the head of the turn.
  const sent = host.control.prompt(0) + (host.control.sends[0]?.message ?? "");
  expect(sent).toContain("A message from agent bob:");
  expect(sent).toContain("Task: task-3fa9c2");
  expect(sent).toContain('"required":["merged"]');
});

test("an update about a task stays the words of the fact, which the head of the turn ties to the task", async () => {
  const host = await agentHost({ agents: [RIN] });
  open.push(host);
  await host.host.call("message.send" as ActionName, {
    from: agentAddress("bob"),
    to: agentAddress("rin"),
    task: "task-3fa9c2",
    body: { type: "update", text: "Half done." },
  });
  const records = await until(host.records, "agent.turn.delivered");
  const [queued] = dataOf(records, "agent.turn.queued") as Array<{ kind: string; text: string; source?: unknown }>;
  expect(queued).toMatchObject({ kind: "fact", text: "Half done.", source: { kind: "task", task: "task-3fa9c2" } });
});
