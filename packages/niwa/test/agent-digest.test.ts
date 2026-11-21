// The digest of an attached session: at each pause of a native session attached to an agent, the built-in
// workflow reads what the session did since the last digest and tells the agent as a fact, which wakes it.

import { afterEach, expect, test } from "bun:test";

import type { ActionName } from "@niwa-labs/core";
import { LocatorSchema } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";
import { connectAsOwner, workflow } from "@niwa-labs/testing";

import { HARNESS, agentHost, dataOf, until } from "./fixtures/agent-host.ts";
import type { AgentHost } from "./fixtures/agent-host.ts";

const RIN = { name: "rin", harness: HARNESS, prompt: "You keep the owner's work in order." };
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const said = (n: number, kind: "user" | "assistant", text: string): SessionRecord => ({ kind, text, locator: at(n), incomplete: false }) as SessionRecord;

const open: AgentHost[] = [];
afterEach(async () => {
  for (const host of open.splice(0)) await host.close();
});

async function attachedHost(transcript: SessionRecord[]): Promise<AgentHost> {
  const host = await agentHost(
    { agents: [RIN], digests: true },
    { transcripts: new Map([["ext-1", transcript]]), after: [workflow()], timing: { pollMs: 20, pauseMs: 150, endMs: 600_000 } },
  );
  open.push(host);
  // The built-in is installed when the host starts: the pauses after it are its records.
  await until(host.records, "workflow.subscription.installed", 1, 30_000);
  const client = await connectAsOwner(host.home);
  try {
    await client.call("agent.attach" as ActionName, { agent: "rin", harness: HARNESS, native: "ext-1", cwd: "/work" });
  } finally {
    await client.close();
  }
  return host;
}

type Turn = { text: string; source?: { kind: string; session?: string; from?: string; upto?: string }; author: unknown };

const digestsOf = async (host: AgentHost, count: number): Promise<Turn[]> =>
  (dataOf(await until(host.records, "agent.turn.queued", count, 60_000), "agent.turn.queued") as Turn[]).filter((turn) => turn.source?.kind === "session-digest");

test("each pause of an attached session tells its agent what the session did since it was attached, then since the last digest", async () => {
  const transcript: SessionRecord[] = [said(1, "user", "an old request"), said(2, "assistant", "an old answer")];
  const host = await attachedHost(transcript);
  expect(dataOf(await host.records(), "agent.attached")).toEqual([{ agent: "rin", session: `${HARNESS} ext-1`, cwd: "/work", from: "L2" }]);

  transcript.push(said(3, "user", "fix the build"), said(4, "assistant", "the build is fixed"));
  const [first] = await digestsOf(host, 1);
  expect(first?.source).toEqual({ kind: "session-digest", session: `${HARNESS} ext-1`, from: "L2", upto: "L4" });
  expect(first?.text).toContain("The owner: fix the build");
  expect(first?.text).toContain("The session: the build is fixed");
  // What came before the attachment is not told again.
  expect(first?.text).not.toContain("an old request");
  expect(first?.author).toMatchObject({ kind: "niwa" });
  // The fact wakes the agent.
  await until(host.records, "agent.turn.delivered", 1, 30_000);
  expect(host.control.prompt(0)).toContain("about what happened in session");

  transcript.push(said(5, "user", "now the tests"), said(6, "assistant", "the tests pass"));
  const [, second] = await digestsOf(host, 2);
  expect(second?.source).toEqual({ kind: "session-digest", session: `${HARNESS} ext-1`, from: "L4", upto: "L6" });
  expect(second?.text).toContain("since the last digest");
  expect(second?.text).toContain("The owner: now the tests");
  expect(second?.text).not.toContain("fix the build");

  // Only the attached session made digests due: the agent's own session pauses too, and starts no run.
  const due = dataOf(await host.records(), "agent.digest.due") as Array<{ session: string }>;
  expect(new Set(due.map((one) => one.session))).toEqual(new Set([`${HARNESS} ext-1`]));
}, 90_000);

test("one digest holds a bounded part of a long stretch, and the next pause goes on from where it stopped", async () => {
  const transcript: SessionRecord[] = [];
  const host = await attachedHost(transcript);
  const long = "x".repeat(20_000);
  for (let n = 1; n <= 30; n += 1) transcript.push(said(n, n % 2 === 1 ? "user" : "assistant", `${String(n)} ${long}`));
  const [first] = await digestsOf(host, 1);
  expect(first?.text).toContain("It did more after this");
  expect(first?.text.length).toBeLessThan(250_000);
  expect(first?.source?.upto).not.toBe("L30");
  transcript.push(said(31, "user", "and the last one"));
  const digests = await digestsOf(host, 2);
  expect(digests[1]?.source?.from).toBe(first?.source?.upto);
}, 90_000);
