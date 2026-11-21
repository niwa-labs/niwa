// The pi insert: what pi does that cannot be seen from outside.
//
// The extension is loaded the way pi loads it: its default export gets an API, and the handlers
// it registers are called with pi's own event shapes, against a real host that serves the shared
// insert plugin. The reports arrive in niwa's journal as the records of that plugin.

import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, sessionId } from "@niwa-labs/harness";
import { PermissionRouter, insertPlugin } from "@niwa-labs/sessions";
import type { HarnessInsert, PermissionAskedEvent } from "@niwa-labs/harness";
import { eventually, tempDir, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { PiInsert, niwaPiExtension, pi as piKind, piSession } from "@niwa-labs/harness-pi";
import type { PiExtensionApi, PiExtensionContext } from "@niwa-labs/harness-pi";
import { niwaCli } from "./fixtures/niwa-cli.ts";
import { installInsert } from "../src/inserts.ts";

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

  // The pi kind's insert is put into pi and carries no answers.
  const pi = piKind({ harness: harnessId("pi"), sessionsRoot: "/tmp/niwa-pi-insert" }).insert;
  if (pi === undefined) throw new Error("the pi kind has no insert side");
  router.ask(pi, asked("pi"));
  await expect(router.answer(asked("pi").session, answer)).rejects.toThrow("cannot carry answers");
});

/** The pi this machine has, if any: it needs no account and no model for this test, only to start. */
const PI_BIN = process.env["PI_BIN"] ?? Bun.which("pi") ?? "";

test.skipIf(PI_BIN === "")(
  "a pi the owner opened by hand loads the installed insert and its session reaches the host as opened by hand",
  async () => {
    const piHome = await tempDir("pi-insert-home");
    const home = await tempHome();
    const niwa = createNiwa({ home: home.path });
    niwa.use(insertPlugin());
    await niwa.serve();
    const kind = piKind({ harness: harnessId("pi-hand"), sessionsRoot: join(piHome, "sessions") });
    // Put into pi the way an installation is: through niwa, which names its own CLI to report through.
    await installInsert(kind, home.path);

    // A pi nobody started from niwa: its environment names no niwa at all.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NIWA_")));
    const child = Bun.spawn([PI_BIN, "--mode", "rpc"], {
      env: { ...environment, PI_CODING_AGENT_DIR: piHome } as Record<string, string>,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      child.stdin.write(`${JSON.stringify({ type: "get_state", id: "1" })}\n`);
      await child.stdin.flush();
      let opened: StoredRecord | undefined;
      await eventually(
        async () => {
          opened = (await niwa.records.read()).find((record) => record.type === "insert.opened-by-hand");
          return opened !== undefined;
        },
        60_000,
        "the pi insert should report the session",
      );
      expect(opened?.data).toMatchObject({ session: { harness: "pi-hand" } });
    } finally {
      child.kill();
      await niwa.close().catch(() => {});
      await home.cleanup();
      await rm(piHome, { recursive: true, force: true });
    }
  },
  90_000,
);
