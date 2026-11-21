// The pi insert: what pi does that cannot be seen from outside.
//
// The extension is loaded the way pi loads it: its default export gets an API, and the handlers
// it registers are called with pi's own event shapes, against a real host that serves the shared
// insert plugin. The reports arrive in niwa's journal as the records of that plugin.

import { afterEach, expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, sessionId } from "@niwa-labs/harness";
import { PermissionRouter, insertPlugin } from "@niwa-labs/sessions";
import type { HarnessInsert, PermissionAskedEvent } from "@niwa-labs/harness";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";

import { PiInsert, niwaPiExtension, piSession } from "@niwa-labs/harness-pi";
import type { PiExtensionApi, PiExtensionContext } from "@niwa-labs/harness-pi";
import { niwaCli } from "./fixtures/niwa-cli.ts";

type Handler = (event: never, ctx: PiExtensionContext) => Promise<void>;

/** What pi does with an extension: it gets the handlers and calls them. */
function loadExtension(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const api: PiExtensionApi = { on: (name, handler) => void handlers.set(name, handler as Handler) };
  niwaPiExtension(api);
  return handlers;
}

const ctx: PiExtensionContext = { sessionManager: { getSessionId: () => "sess-1" }, cwd: "/tmp/work" };
const session = { id: "sess-1", cwd: "/tmp/work" };

const env = { home: process.env.NIWA_HOME, marker: process.env.NIWA_SESSION, cli: process.env.NIWA_CLI };
afterEach(() => {
  for (const [key, value] of [
    ["NIWA_HOME", env.home],
    ["NIWA_SESSION", env.marker],
    ["NIWA_CLI", env.cli],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function recordsOf(
  client: Awaited<ReturnType<typeof connect>>,
  type: string,
  expected: number,
): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  const stream = client.records.since({ types: [type as never] }) as AsyncGenerator<StoredRecord>;
  for (let index = 0; index < expected; index += 1) {
    const next = await Promise.race([stream.next(), Bun.sleep(500).then(() => "timed out" as const)]);
    if (next === "timed out" || next.done === true) break;
    found.push(next.value);
  }
  return found;
}

test("the pi extension reports a session opened by hand, a compaction and a question to the host", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(insertPlugin());
  await niwa.serve();
  process.env.NIWA_HOME = home.path;
  process.env.NIWA_CLI = await niwaCli(home.path);
  delete process.env.NIWA_SESSION;

  try {
    const client = await connectAsOwner(home.path);
    const handlers = loadExtension();

    await handlers.get("session_start")?.({ reason: "startup" } as never, ctx);
    await handlers.get("session_start")?.({ reason: "reload" } as never, ctx);
    await handlers.get("session_start")?.({ reason: "resume" } as never, ctx);
    await handlers.get("session_compact")?.({ compactionEntry: { summary: "so far" } } as never, ctx);
    await handlers.get("ui_prompt_start")?.({ kind: "confirm", title: "Run rm -rf build?" } as never, ctx);
    await handlers.get("ui_prompt_start")?.({ kind: "input", title: "a name" } as never, ctx);

    const [opened] = await recordsOf(client, "insert.opened-by-hand", 2);
    expect(opened?.data).toMatchObject({ session: piSession("sess-1"), cwd: "/tmp/work" });
    expect(await recordsOf(client, "insert.opened-by-hand", 2)).toHaveLength(1);

    const [compacted] = await recordsOf(client, "insert.compacted", 1);
    expect(compacted?.data).toMatchObject({ session: piSession("sess-1"), summary: "so far" });

    const asked = await recordsOf(client, "insert.permission-asked", 2);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.data).toMatchObject({
      session: piSession("sess-1"),
      requestId: "sess-1:prompt:1",
      tool: "ui:confirm",
      detail: "Run rm -rf build?",
    });

    await client.close().catch(() => {});
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("a session niwa started is not reported as opened by hand", async () => {
  const reported: unknown[] = [];
  const insert = new PiInsert({ report: async (event) => void reported.push(event), owned: true });
  await insert.onSessionStart({ reason: "startup" }, session);
  expect(reported).toEqual([]);
});

test("pi leaving a session is its end, and a reload is not", async () => {
  const reported: unknown[] = [];
  const insert = new PiInsert({ report: async (event) => void reported.push(event) });
  await insert.onSessionShutdown({ reason: "reload" }, session);
  expect(reported).toEqual([]);
  for (const reason of ["quit", "new", "resume", "fork"] as const) await insert.onSessionShutdown({ reason }, session);
  expect(reported).toEqual(["quit", "new", "resume", "fork"].map((reason) => ({ kind: "session-ended", session: piSession(session.id), reason, at: expect.any(Number) })));
});

test("the readers of the insert get the events from the moment they listen", async () => {
  const insert = new PiInsert({ report: async () => {} });
  await insert.onSessionCompact({ compactionEntry: { summary: "missed" } }, session);
  const events = insert.events()[Symbol.asyncIterator]();
  const next = events.next();
  await insert.onSessionCompact({ compactionEntry: { summary: "seen" } }, session);
  expect((await next).value).toMatchObject({ kind: "compacted", summary: "seen" });
  await events.return?.();
});

test("the extension never fails pi, whatever is wrong", async () => {
  const handlers = loadExtension();

  // The home is not set.
  delete process.env.NIWA_HOME;
  await handlers.get("session_start")?.({ reason: "startup" } as never, ctx);

  // No host is running at the home.
  const home = await tempHome();
  process.env.NIWA_HOME = home.path;
  try {
    await handlers.get("session_compact")?.({ compactionEntry: { summary: "x" } } as never, ctx);
    // The event is not what pi documents.
    await handlers.get("session_compact")?.({} as never, ctx);
    // The context cannot tell the session.
    const broken = { cwd: "/", sessionManager: { getSessionId: () => { throw new Error("no session"); } } };
    await handlers.get("session_start")?.({ reason: "startup" } as never, broken);
  } finally {
    await home.cleanup();
  }
}, 30_000);

test("a permission answer goes only to the side that asked, once", async () => {
  const answered: string[] = [];
  const side = (name: string): HarnessInsert => ({
    events: async function* () {},
    answerPermission: async (answer) => void answered.push(`${name}:${answer.requestId}`),
  });
  const claude = side("claude");
  const other = side("other");
  const router = new PermissionRouter();
  const asked = (harness: string): PermissionAskedEvent => ({
    kind: "permission-asked",
    session: sessionId(harnessId(harness), "s1"),
    requestId: "req-1",
    tool: "bash",
  });
  router.ask(claude, asked("claude-code"));
  router.ask(other, asked("other"));

  const answer = { requestId: "req-1", allow: false };
  await router.answer(asked("claude-code").session, answer);
  expect(answered).toEqual(["claude:req-1"]);
  await expect(router.answer(asked("claude-code").session, answer)).rejects.toThrow("req-1");

  const pi = new PiInsert({ report: async () => {} });
  router.ask(pi, asked("pi"));
  await expect(router.answer(asked("pi").session, answer)).rejects.toThrow("cannot carry answers");
});
