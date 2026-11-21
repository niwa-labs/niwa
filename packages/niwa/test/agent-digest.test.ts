// The digest of an attached session: at each pause of a native session attached to an agent, the built-in
// workflow reads what the session did since the last digest and tells the agent as a fact, which wakes it.

import { afterEach, expect, test } from "bun:test";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActionName } from "@niwa-labs/core";
import { LocatorSchema } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";
import { connectAsOwner, workflow } from "@niwa-labs/testing";

import { HARNESS, agentHost, dataOf, transcripts, until } from "./fixtures/agent-host.ts";
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

test("a session whose history started over is not told again from its top: the agent is told that it did, and the position moves on", async () => {
  const transcript: SessionRecord[] = [said(1, "user", "an old request"), said(2, "assistant", "an old answer")];
  const host = await attachedHost(transcript);
  transcript.push(said(3, "user", "fix the build"), said(4, "assistant", "the build is fixed"));
  const [first] = await digestsOf(host, 1);
  expect(first?.source?.upto).toBe("L4");
  // The transcript is written again under other positions: the last position read is no longer in it.
  const again = (n: number, kind: "user" | "assistant", text: string): SessionRecord => ({ kind, text, locator: LocatorSchema.parse(`M${String(n)}`), incomplete: false }) as SessionRecord;
  transcript.splice(0, transcript.length, again(1, "user", "an old request"), again(2, "assistant", "an old answer"), again(3, "user", "fix the build"), again(4, "assistant", "the build is fixed"), again(5, "user", "now the tests"));
  const [, second] = await digestsOf(host, 2);
  expect(second?.source).toEqual({ kind: "session-digest", session: `${HARNESS} ext-1`, from: "L4", upto: "M5" });
  expect(second?.text).toContain("started over");
  // Nothing of the old stretch is told as news.
  expect(second?.text).not.toContain("an old request");
  expect(second?.text).not.toContain("fix the build");
  // The next digest goes on from the new position.
  transcript.push(again(6, "assistant", "the tests pass"));
  const [, , third] = await digestsOf(host, 3);
  expect(third?.source).toEqual({ kind: "session-digest", session: `${HARNESS} ext-1`, from: "M5", upto: "M6" });
  expect(third?.text).toContain("The session: the tests pass");
}, 90_000);

test("a public fact cannot set the transcript cursor", async () => {
  const host = await attachedHost([said(1, "user", "old")]);
  await expect(host.host.call("agent.notify" as ActionName, {
    agent: "rin", text: "an ordinary fact", source: { kind: "session-digest", session: `${HARNESS} ext-1`, upto: "other" },
  })).rejects.toThrow();
  expect(await host.host.call("agent.attachment" as ActionName, { session: `${HARNESS} ext-1` })).toMatchObject({ upto: "L1" });
});

test("a replaced attachment rejects its previous cursor and competing readers commit only once", async () => {
  const transcript = [said(1, "user", "old")];
  const host = await agentHost({ agents: [RIN] }, { transcripts: new Map([["ext-1", transcript]]) });
  open.push(host);
  const session = `${HARNESS} ext-1`;
  const attach = () => host.host.call("agent.attach" as ActionName, { harness: HARNESS, native: "ext-1", cwd: "/work", agent: "rin" });
  const state = () => host.host.call("agent.attachment" as ActionName, { session }) as Promise<{ attachment: string; upto: string }>;
  const read = (attachment: string, from: string) => host.host.call("agent.digest.read" as ActionName, { session, attachment, from, ended: false });
  await attach();
  const old = await state();
  transcript.push(said(2, "assistant", "first attachment"));
  await read(old.attachment, old.upto);
  await host.host.call("agent.detach" as ActionName, { session });
  transcript.push(said(3, "user", "between attachments"));
  await attach();
  const current = await state();
  expect(current.upto).toBe("L3");
  expect(current.attachment).not.toBe(old.attachment);
  transcript.push(said(4, "user", "new attachment"));
  await read(old.attachment, "L2");
  await Promise.all([read(current.attachment, "L3"), read(current.attachment, "L3")]);
  const facts = dataOf(await host.records(), "agent.turn.queued") as Turn[];
  expect(facts.map((turn) => turn.source?.upto)).toEqual(["L2", "L4"]);
  expect(facts[1]?.text).not.toContain("between attachments");
});

test("a final event skips silent windows and delivers the following mailbox text", async () => {
  const transcript: SessionRecord[] = [];
  const host = await attachedHost(transcript);
  for (let n = 1; n <= 8; n++) transcript.push({ kind: "thinking", locator: at(n), incomplete: false, redacted: false, text: "x".repeat(30000) });
  transcript.push(said(9, "assistant", "visible after the quiet windows"));
  const session = `${HARNESS} ext-1`;
  await host.host.call("history.signal" as ActionName, { session: { harness: HARNESS, native: "ext-1" }, signal: "end-hook" });
  const turns = dataOf(await until(host.records, "agent.turn.queued", 1, 5000), "agent.turn.queued") as Turn[];
  expect(turns[0]?.text).toContain("visible after the quiet windows");
  expect(await host.host.call("agent.attachment" as ActionName, { session })).toMatchObject({ upto: "L9" });
}, 15000);

test("a rewritten transcript longer than six windows reanchors at its tail", async () => {
  const transcript = [said(1, "user", "old")];
  const host = await attachedHost(transcript);
  transcript.splice(0, 1, ...Array.from({ length: 10 }, (_, n) => said(n + 11, "user", "old".repeat(10000))));
  const [reset] = await digestsOf(host, 1);
  expect(reset?.source?.upto).toBe("L20");
  expect(reset?.text).toContain("started over");
}, 15000);

test("a final digest fits multibyte text into separate facts and keeps a large excerpt as an artifact", async () => {
  const transcript: SessionRecord[] = [];
  const host = await attachedHost(transcript);
  const long = "я".repeat(30000);
  for (let n = 1; n <= 6; n++) transcript.push(said(n, "user", long));
  const large = "文".repeat(100000);
  transcript.push(said(7, "user", large));
  await host.host.call("history.signal" as ActionName, { session: { harness: HARNESS, native: "ext-1" }, signal: "end-hook" });
  const rows = await until(host.records, "agent.turn.queued", 4, 6000);
  const facts = dataOf(rows, "agent.turn.queued") as Turn[];
  expect(facts.map((fact) => fact.source?.upto)).toEqual(["L2", "L4", "L6", "L7"]);
  for (const fact of facts) expect(Buffer.byteLength(JSON.stringify(fact))).toBeLessThan(256 * 1024);
  const digest = facts[3]!.text.match(/sha256:[0-9a-f]{64}/)?.[0];
  expect(digest).toBeDefined();
  expect(await readFile(join(host.home, "artifacts", digest!.slice("sha256:".length)), "utf8")).toContain(large);
}, 15000);

test("an unknown tail establishes a boundary after reading recovers", async () => {
  const transcript = [said(1, "user", "before attachment")];
  let failed = true;
  const reading = transcripts(new Map([["ext-1", transcript]]));
  const host = await agentHost({ agents: [RIN] }, { reading: { ...reading, coverage: async () => failed ? { status: "failed", reason: "offline" } : { status: "not-scanned" } } });
  open.push(host);
  const session = `${HARNESS} ext-1`;
  const bound = await host.host.call("agent.attach" as ActionName, { agent: "rin", harness: HARNESS, native: "ext-1", cwd: "/work" });
  expect(bound).toMatchObject({ pending: true });
  const state = () => host.host.call("agent.attachment" as ActionName, { session }) as Promise<{ attachment: string; upto?: string; pending?: boolean }>;
  const before = await state();
  failed = false;
  await host.host.call("agent.digest.read" as ActionName, { session, attachment: before.attachment, pending: true, ended: false, ...(before.upto === undefined ? {} : { from: before.upto }) });
  expect(await state()).toMatchObject({ upto: "L1" });
  expect((await state()).pending).toBeUndefined();
  expect(dataOf(await host.records(), "agent.turn.queued")).toHaveLength(0);
});
