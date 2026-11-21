// The sessions module against a fake reading side and a fake journal reader: list, read, running.
// No host is started; the plugin's own setup is driven with a minimal PluginApi.

import { expect, test } from "bun:test";

import { principalOf, seq } from "@niwa-labs/core";
import type { Action, ActionName, JournalReader, StoredRecord, Timestamp } from "@niwa-labs/core";
import {
  AssistantRecordSchema,
  CompactionRecordSchema,
  harnessId,
  harnessKind,
  machineId,
  NestedRecordSchema,
  sessionId,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  UnknownRecordSchema,
  UserRecordSchema,
} from "@niwa-labs/harness";
import type { Coverage, Harness, SessionInfo, SessionReading, SessionRecord } from "@niwa-labs/harness";
import type { PluginApi } from "@niwa-labs/plugin";
import { connect, createNiwa, tempHome } from "@niwa-labs/testing";

import {
  lifeOf,
  SessionActivity,
  SessionBelongs,
  SessionCatalog,
  SessionEnded,
  SessionModel,
  sessionRef,
  sessions,
  SessionStarted,
  SessionTurnEnded,
  SessionTurnStarted,
} from "../src/index.ts";

const BOOT = 1_000 as Timestamp;
const BEFORE = 500;
const AFTER = 2_000;

function instance(id: string, reading: boolean): Harness {
  return {
    id: harnessId(id),
    kind: harnessKind("fake"),
    machine: machineId("here"),
    home: "/tmp/fake",
    sides: reading ? { reading: { list: true, read: true, watch: false } } : {},
  };
}

let counter = 0;
function stored(type: string, data: object, at: number): StoredRecord {
  counter += 1;
  return {
    id: `r${counter}`,
    seq: seq(counter),
    stream: "s",
    type,
    schema: 1,
    data,
    actor: "test",
    cause: null,
    root: `r${counter}`,
    at: at as Timestamp,
  } as unknown as StoredRecord;
}

function reader(records: StoredRecord[]): JournalReader {
  return {
    get: (id) => records.find((record) => record.id === id),
    since: (from, types) =>
      records.filter((record) => record.seq > from && (types === undefined || types.includes(record.type))),
    find: (query) => records.filter((record) => query.type === undefined || record.type === query.type),
    last: () => seq(records.length),
  };
}

const info = (harness: string, native: string, cwd?: string, title?: string): SessionInfo => ({
  id: sessionId(harnessId(harness), native),
  cwd,
  ...(title === undefined ? {} : { title }),
});

function fakeReading(options: {
  list?: SessionInfo[];
  listFails?: boolean;
  records?: SessionRecord[];
  readFailsAfter?: number;
  coverage?: Coverage;
}): SessionReading {
  return {
    async *list() {
      if (options.listFails) throw new Error("the directory is gone");
      yield* options.list ?? [];
    },
    async *read(_id, from) {
      const records = options.records ?? [];
      const start = from === undefined ? 0 : records.findIndex((record) => record.locator === from) + 1;
      let given = 0;
      for (const record of records.slice(start)) {
        if (options.readFailsAfter !== undefined && given >= options.readFailsAfter) throw new Error("torn file");
        given += 1;
        yield record;
      }
    },
    raw: async () => undefined,
    rawSchema: { parse: (value: unknown) => value } as never,
    coverage: async () => options.coverage ?? { status: "not-scanned" },
  };
}

/**
 * Install the plugin on a minimal API and hand back its actions by name.
 *
 * The output is parsed by the action's own schema, the way the host checks it on every call: an
 * action that returns something its schema does not accept is a failure, and the test sees it.
 */
function install(
  options: Parameters<typeof sessions>[0],
  journal: JournalReader | undefined,
): Record<string, (input: unknown) => Promise<any>> {
  const found: Record<string, (input: unknown) => Promise<any>> = {};
  const api: Partial<PluginApi> = {
    declare: () => {},
    action: (a: Action<any, any>) => {
      found[a.name] = async (input) => a.output.parse(await a.run(a.input.parse(input), undefined as never));
    },
    // The cockpit module is offered by its path; this stub lists none.
    offer: () => {},
    // The plugin handles the questions of the sessions it serves; this stub serves none.
    on: () => {},
    // The disposal of the control sides is a service; this stub runs none.
    service: () => {},
    summarize: () => {},
    journal: () => journal,
  };
  sessions(options).setup(api as PluginApi);
  return found;
}

const text = (locator: string): SessionRecord =>
  ({ kind: "user", text: "hello", locator, incomplete: false }) as unknown as SessionRecord;

test("list merges niwa's records with the reading side and states a failing side", async () => {
  const a = sessionRef(sessionId(harnessId("a"), "s1"));
  const journal = reader([
    stored(SessionStarted.name, { session: a, id: "s-a1a1a1", cwd: "/w" }, BEFORE),
    stored(SessionBelongs.name, { session: a, to: { kind: "agent", id: "x" }, source: "explicit" }, BEFORE),
  ]);
  const actions = install(
    {
      harnesses: [
        {
          instance: instance("a", true),
          reading: fakeReading({ list: [info("a", "s1", "/w", "the release"), info("a", "s2", "/v")] }),
        },
        { instance: instance("b", true), reading: fakeReading({ listFails: true }) },
        { instance: instance("c", false) },
      ],
    },
    journal,
  );

  const all = await actions["session.list"]!({});
  expect(all.sessions.map((s: { ref: string }) => s.ref)).toEqual(["a s1", "a s2"]);
  // The readable title the reading side gives is listed next to the pointer; none is invented.
  expect(all.sessions[0]).toMatchObject({ ref: "a s1", title: "the release" });
  expect(all.sessions[1]?.title).toBeUndefined();
  // A session niwa started is listed with the id it gave; one only the machine knows has none.
  expect(all.sessions[0]?.id).toBe("s-a1a1a1");
  expect(all.sessions[1]?.id).toBeUndefined();
  // A session that only the reading side knows is unknown, and its cwd is kept for filtering.
  expect(all.sessions[1]).toMatchObject({ state: "unknown", cwd: "/v" });
  // Belonging is a record of its own, with its source; the session carries no relation field.
  expect(all.belongings).toEqual([{ session: "a s1", to: { kind: "agent", id: "x" }, source: "explicit" }]);
  expect(Object.keys(all.sessions[0])).not.toContain("belongs");
  // The failing side is named, not silently dropped.
  expect(all.unreadable).toEqual([{ harness: "b", reason: "the directory is gone" }]);

  const filtered = await actions["session.list"]!({ cwd: "/v" });
  expect(filtered.sessions.map((s: { ref: string }) => s.ref)).toEqual(["a s2"]);
});

test("list pages through sessions of every harness, newest first, each exactly once", async () => {
  const kinds = ["a", "b", "c", "d", "e"];
  const harnesses = kinds.map((kind) => ({
    instance: instance(kind, true),
    reading: fakeReading({
      list: Array.from({ length: 230 }, (_, n) => ({ ...info(kind, `s${n}`, "/w", `session ${n} of ${kind}`), updatedAt: (n % 97) * 1000 + kinds.indexOf(kind) })),
    }),
  }));
  const actions = install({ harnesses });
  const list = actions["session.list"]!;

  // With no limit said, one page is bounded and says where the rest is.
  const first = await list({});
  expect(first.sessions).toHaveLength(100);
  expect(first.total).toBe(1150);
  expect(first.nextCursor).toBeDefined();
  expect(first.hint).toContain("nextCursor");
  expect(first.belongings).toEqual([]);

  const seen: string[] = [];
  const times: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await list({ limit: 70, ...(cursor === undefined ? {} : { cursor }) });
    expect(page.sessions.length).toBeLessThanOrEqual(70);
    expect(page.total).toBe(1150);
    for (const entry of page.sessions) {
      seen.push(entry.ref);
      times.push(entry.lastActivityAt ?? 0);
    }
    cursor = page.nextCursor;
    if (cursor === undefined) expect(page.hint).toBeUndefined();
    pages += 1;
  } while (cursor !== undefined);
  expect(pages).toBe(17);
  expect(new Set(seen).size).toBe(1150);
  expect(times).toEqual([...times].sort((a, b) => b - a));

  // A list that fits one page has no cursor.
  const whole = await list({ harness: "a", limit: 500 });
  expect(whole.sessions).toHaveLength(230);
  expect(whole.nextCursor).toBeUndefined();

  await expect(list({ cursor: "not-a-cursor" })).rejects.toThrow("cursor");
});

test("managed list reads the journal without listing harness sessions", async () => {
  const managed = sessionRef(sessionId(harnessId("a"), "s1"));
  const excluded = sessionRef(sessionId(harnessId("a"), "s2"));
  const to = { kind: "agent", id: "x" };
  const journal = reader([
    stored(SessionStarted.name, { session: managed, id: "s-a1a1a1", cwd: "/w" }, BEFORE),
    stored(SessionTurnStarted.name, { session: managed, turn: 1 }, BEFORE),
    stored(SessionModel.name, { session: managed, model: "model-actually-running" }, BEFORE),
    stored(SessionBelongs.name, { session: managed, to, source: "explicit" }, BEFORE),
    stored(SessionStarted.name, { session: excluded, id: "s-a2a2a2", cwd: "/v" }, BEFORE),
    stored(SessionBelongs.name, { session: excluded, to, source: "explicit" }, BEFORE),
  ]);
  let listed = 0;
  const reading: SessionReading = {
    ...fakeReading({}),
    async *list() {
      listed += 1;
      yield info("a", "s1", "/w", "the release");
      yield info("a", "external", "/w");
    },
  };
  const actions = install({ harnesses: [{ instance: instance("a", true), reading }] }, journal);
  const list = actions["session.list"]!;

  const own = await list({ managedOnly: true, harness: "a", cwd: "/w" });
  expect(own).toEqual({
    sessions: [{ ref: managed, id: "s-a1a1a1", cwd: "/w", model: "model-actually-running", startedAt: BEFORE, state: "unknown" }],
    total: 1,
    belongings: [{ session: managed, to, source: "explicit" }],
    unreadable: [],
  });
  expect(listed).toBe(0);

  const all = await list({ managedOnly: false, harness: "a", cwd: "/w" });
  expect(all.sessions).toMatchObject([{ ref: managed, title: "the release" }, { ref: "a external" }]);
  expect(listed).toBe(1);
});

test("read passes the harness's records through and never states ignorance as empty", async () => {
  const records = [text("l1"), text("l2")];
  const actions = install(
    {
      harnesses: [
        { instance: instance("a", true), reading: fakeReading({ records, coverage: { status: "empty" } }) },
        { instance: instance("t", true), reading: fakeReading({ records, readFailsAfter: 1 }) },
        { instance: instance("n", false) },
      ],
    },
    undefined,
  );

  const whole = await actions["session.read"]!({ session: "a s1" });
  expect(whole.records.map((r: { locator: string }) => r.locator)).toEqual(["l1", "l2"]);
  expect(whole.coverage).toEqual({ status: "empty" });
  expect(whole.page).toBeUndefined();

  const continued = await actions["session.read"]!({ session: "a s1", from: "l1" });
  expect(continued.records.map((r: { locator: string }) => r.locator)).toEqual(["l2"]);
  expect(continued.page).toBeUndefined();

  const torn = await actions["session.read"]!({ session: { harness: "t", native: "s1" } });
  expect(torn.records).toHaveLength(1);
  expect(torn.coverage).toEqual({ status: "failed", reason: "torn file" });

  const none = await actions["session.read"]!({ session: "n s1" });
  expect(none.records).toEqual([]);
  expect(none.coverage.status).toBe("unavailable");

  const missing = await actions["session.read"]!({ session: "zzz s1" });
  expect(missing.coverage.status).toBe("unavailable");
});

test("read windows page back exclusively in harness order", async () => {
  const records = Array.from({ length: 8 }, (_, index) => text(`l${index + 1}`));
  const actions = install({ harnesses: [{ instance: instance("a", true), reading: fakeReading({ records }) }] }, undefined);
  const read = async (before?: string) => actions["session.read"]!({ session: "a s1", window: { limit: 3, before } });

  const latest = await read();
  expect(latest.records).toEqual(records.slice(5));
  expect(latest.page).toEqual({ hasEarlier: true });
  expect(latest.coverage).toEqual({ status: "not-scanned" });

  const previous = await read(latest.records[0].locator);
  expect(previous.records).toEqual(records.slice(2, 5));
  expect(previous.page).toEqual({ hasEarlier: true });

  const first = await read(previous.records[0].locator);
  expect(first.records).toEqual(records.slice(0, 2));
  expect(first.page).toEqual({ hasEarlier: false });

  const exact = await read("l4");
  expect(exact.records).toEqual(records.slice(0, 3));
  expect(exact.page).toEqual({ hasEarlier: false });

  const beforeFirst = await read("l1");
  expect(beforeFirst.records).toEqual([]);
  expect(beforeFirst.page).toEqual({ hasEarlier: false });
});

test("read windows distinguish an unknown locator from incomplete and unavailable reads", async () => {
  const records = [text("l1"), text("l2"), text("l3"), text("l4")];
  const actions = install({
    harnesses: [
      { instance: instance("a", true), reading: fakeReading({ records }) },
      { instance: instance("t", true), reading: fakeReading({ records, readFailsAfter: 3 }) },
      { instance: instance("n", false) },
    ],
  }, undefined);
  const read = async (session: string, before?: string) => actions["session.read"]!({ session, window: { limit: 2, before } });

  const unknown = await read("a s1", "stale");
  expect(unknown.records).toEqual([]);
  expect(unknown.coverage).toMatchObject({ status: "failed", reason: expect.stringContaining("before locator") });
  expect(unknown.page).toEqual({ hasEarlier: false });

  const partial = await read("t s1");
  expect(partial.records).toEqual(records.slice(1, 3));
  expect(partial.coverage).toEqual({ status: "failed", reason: "torn file" });
  expect(partial.page).toEqual({ hasEarlier: true });

  const unverified = await read("t s1", "l4");
  expect(unverified.records).toEqual([]);
  expect(unverified.coverage).toEqual({ status: "failed", reason: "torn file" });
  expect(unverified.page).toEqual({ hasEarlier: false });

  const found = await read("t s1", "l3");
  expect(found.records).toEqual(records.slice(0, 2));
  expect(found.coverage).toEqual({ status: "not-scanned" });
  expect(found.page).toEqual({ hasEarlier: false });

  const unavailable = await read("n s1", "l1");
  expect(unavailable.records).toEqual([]);
  expect(unavailable.coverage.status).toBe("unavailable");
  expect(unavailable.page).toEqual({ hasEarlier: false });
});

test("read rejects invalid windows before accessing the reading side", async () => {
  const actions = install({}, undefined);
  const session = "a s1";
  const read = actions["session.read"]!;
  await expect(read({ session, from: "l1", window: { limit: 1 } })).rejects.toThrow(/cannot be combined/);
  for (const limit of [0, -1, 1.5, 251]) {
    await expect(read({ session, window: { limit } })).rejects.toThrow();
  }
  await expect(read({ session, window: { limit: 1, before: "" } })).rejects.toThrow();
});

test("a digest read gives entries in windows that go on from next, carrying the file index; a brief sums the session up", async () => {
  const records = [
    { kind: "user", text: "fix it", locator: "l1", incomplete: false },
    { kind: "tool-call", callId: "c1", name: "Read", category: "read", target: "/r/a.ts", input: { file_path: "/r/a.ts" }, locator: "l2", incomplete: false },
    { kind: "tool-result", callId: "c1", output: "x".repeat(2_000), ok: true, locator: "l3", incomplete: false },
    { kind: "tool-call", callId: "c2", name: "Edit", category: "edit", target: "/r/a.ts", input: { file_path: "/r/a.ts" }, locator: "l4", incomplete: false },
    { kind: "assistant", text: "done", locator: "l5", incomplete: false },
  ] as unknown as SessionRecord[];
  const actions = install({ harnesses: [{ instance: instance("a", true), reading: fakeReading({ records }) }] }, undefined);
  const read = actions["session.read"]!;

  const first = await read({ session: "a s1", mode: "digest", budget: 100 });
  expect(first.records).toEqual([]);
  expect(first.digest.view.entries.map((entry: { kind: string }) => entry.kind)).toEqual(["user", "tool"]);
  expect(first.digest.next).toBe("l2");
  const second = await read({ session: "a s1", mode: "digest", from: first.digest.next, files: first.digest.files });
  expect(second.digest.view.entries.map((entry: { kind: string }) => entry.kind)).toEqual(["result", "tool", "assistant"]);
  expect(second.digest.view.entries[1]).toMatchObject({ category: "edit", target: "[F1]" });
  expect(second.digest.next).toBeNull();
  expect(second.digest.files.files).toEqual([{ id: 1, path: "/r/a.ts", changed: true }]);

  const brief = await read({ session: "a s1", mode: "brief" });
  expect(brief.digest.view.brief).toMatchObject({ changed: ["/r/a.ts"], calls: { read: 1, edit: 1 }, outcome: "answered" });
  // A full read is the records, as before.
  expect((await read({ session: "a s1", mode: "full" })).records).toHaveLength(5);
  await expect(read({ session: "a s1", mode: "digest", window: { limit: 2 } })).rejects.toThrow(/takes no digest/);
});

test("read refuses an undeclared ability before reading", async () => {
  const silent = { ...instance("a", true), sides: { reading: { list: true, read: false, watch: false } } };
  const actions = install({ harnesses: [{ instance: silent, reading: fakeReading({ records: [text("l1")] }) }] }, undefined);
  await expect(actions["session.read"]!({ session: "a s1" })).rejects.toThrow(/does not support reading.read/);
});

test("read returns the content of the records, each kind with its own fields", async () => {
  const child = sessionId(harnessId("a"), "child-1");
  const records: SessionRecord[] = [
    UserRecordSchema.parse({ kind: "user", text: "what is the plan?", locator: "l1", at: 10, incomplete: false }),
    AssistantRecordSchema.parse({
      kind: "assistant",
      text: "we ship it on friday",
      model: "m",
      locator: "l2",
      at: 20,
      incomplete: false,
    }),
    ToolCallRecordSchema.parse({
      kind: "tool-call",
      callId: "c1",
      name: "read",
      category: "read",
      target: "plan.md",
      input: { path: "plan.md" },
      locator: "l3",
      incomplete: false,
    }),
    ToolResultRecordSchema.parse({
      kind: "tool-result",
      callId: "c1",
      name: "read",
      output: "the plan",
      ok: true,
      locator: "l4",
      incomplete: false,
    }),
    CompactionRecordSchema.parse({ kind: "compaction", summary: "the plan is friday", locator: "l5", incomplete: false }),
    NestedRecordSchema.parse({ kind: "nested", child, locator: "l6", incomplete: false }),
    UnknownRecordSchema.parse({ kind: "unknown", raw: { the: "harness's own shape" }, locator: "l7", incomplete: false }),
  ];
  const actions = install(
    { harnesses: [{ instance: instance("a", true), reading: fakeReading({ records }) }] },
    undefined,
  );

  const result = await actions["session.read"]!({ session: "a s1" });
  expect(result.records).toEqual([
    { kind: "user", text: "what is the plan?", locator: "l1", at: 10, incomplete: false },
    { kind: "assistant", text: "we ship it on friday", model: "m", locator: "l2", at: 20, incomplete: false },
    { kind: "tool-call", callId: "c1", name: "read", category: "read", target: "plan.md", input: { path: "plan.md" }, locator: "l3", incomplete: false },
    { kind: "tool-result", callId: "c1", name: "read", output: "the plan", ok: true, locator: "l4", incomplete: false },
    { kind: "compaction", summary: "the plan is friday", locator: "l5", incomplete: false },
    { kind: "nested", child: { harness: "a", native: "child-1" }, locator: "l6", incomplete: false },
    { kind: "unknown", locator: "l7", incomplete: false },
  ]);
  // The raw data of an unfamiliar record is not published: it is asked for on demand.
  expect(Object.keys(result.records[6])).not.toContain("raw");
});

test("running separates running from unknown, and never copies content into the journal", async () => {
  const a = sessionRef(sessionId(harnessId("a"), "live"));
  const journal = reader([
    stored(SessionStarted.name, { session: a, id: "s-11fe11" }, BEFORE),
    stored(SessionTurnStarted.name, { session: a, turn: 1 }, BEFORE),
  ]);
  const actions = install(
    { harnesses: [{ instance: instance("a", true), reading: fakeReading({ list: [info("a", "other")] }) }] },
    journal,
  );
  const result = await actions["session.running"]!({});
  // The turn was left open before this process began: unknown, not running and not idle. A session that
  // only the machine knows is not niwa's: it is listed with `all`, and one line each.
  expect(result.running).toEqual([]);
  expect(result.unknown).toEqual(["s-11fe11"]);
  const all = await actions["session.running"]!({ all: true });
  expect(all.unknown.map((line: string) => line.split("  ")[0]).sort()).toEqual(["a other", "s-11fe11"]);
  expect((await actions["session.running"]!({ all: true, limit: 1 })).omitted).toBe(1);
  // A sign of life carries no free text that could hold transcript content.
  expect(SessionActivity.schema.safeParse({ session: a, detail: "secret" }).data).toEqual({ session: a });
  // A tool name survives: a short identifier says what is being done, not what was said.
  expect(SessionActivity.schema.safeParse({ session: a, tool: "mcp__niwa__session.send" }).data).toEqual({ session: a, tool: "mcp__niwa__session.send" });
  expect(SessionActivity.schema.safeParse({ session: a, tool: "ran: cat /etc/passwd" }).success).toBe(false);
});

test("life: a turn open before the restart is unknown, a newer record proves running", () => {
  const ref = sessionRef(sessionId(harnessId("a"), "s"));
  const started = stored(SessionStarted.name, { session: ref, id: "s-5e5e5e" }, BEFORE);
  const turn = stored(SessionTurnStarted.name, { session: ref, turn: 1 }, BEFORE);
  expect(lifeOf([], BOOT)).toBe("unknown");
  expect(lifeOf([started], BOOT)).toBe("idle");
  expect(lifeOf([started, turn], BOOT)).toBe("unknown");
  // Even an activity from before the restart proves nothing about now.
  expect(lifeOf([started, turn, stored(SessionActivity.name, { session: ref }, BEFORE)], BOOT)).toBe("unknown");
  expect(lifeOf([started, turn, stored(SessionActivity.name, { session: ref }, AFTER)], BOOT)).toBe("running");
  const fresh = stored(SessionTurnStarted.name, { session: ref, turn: 2 }, AFTER);
  expect(lifeOf([started, fresh], BOOT)).toBe("running");
  const ended = stored(SessionTurnEnded.name, { session: ref, turn: 1 }, AFTER);
  expect(lifeOf([started, turn, ended], BOOT)).toBe("idle");
  expect(lifeOf([started, turn, stored(SessionEnded.name, { session: ref }, AFTER)], BOOT)).toBe("ended");
});

test("the catalog is built in one pass and keeps what is known when a fact is absent", () => {
  const ref = sessionRef(sessionId(harnessId("a"), "s"));
  const catalog = SessionCatalog.fromRecords(
    [
      stored(SessionStarted.name, { session: ref, id: "s-5e5e5e" }, BEFORE),
      stored(SessionModel.name, { session: ref, model: "m-first" }, BEFORE),
      stored(SessionModel.name, { session: ref, model: "m" }, AFTER),
      stored(SessionActivity.name, { session: ref }, AFTER),
    ],
    BOOT,
  );
  catalog.remember({ ref, cwd: "/w", state: "unknown" });
  // The model is the one the harness named last; a start record carries none.
  expect(catalog.get(ref)).toMatchObject({ model: "m", cwd: "/w", startedAt: BEFORE, lastActivityAt: AFTER, state: "idle" });
});

test("a session whose harness has not named its model has none", () => {
  const ref = sessionRef(sessionId(harnessId("a"), "s"));
  const catalog = SessionCatalog.fromRecords([stored(SessionStarted.name, { session: ref, id: "s-5e5e5e", model: "asked" }, BEFORE)], BOOT);
  expect(catalog.get(ref)?.model).toBeUndefined();
});

test("belong: the catalog lists the belonging with its source, and saying it twice writes nothing new", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: [{ instance: instance("a", true), reading: fakeReading({ list: [info("a", "s1")] }) }] }));
  await host.serve();
  // A client the host issued a token with no grant: nothing limits it, and it is not the owner.
  const client = await connect({ home: home.path, id: "alice", token: host.issueToken(principalOf("client", "alice")) });

  try {
    const session = sessionRef(sessionId(harnessId("a"), "s1"));
    const to = { kind: "agent", id: "rin" } as const;

    const said = await client.call("session.belong" as ActionName, { session, to, source: "explicit" });
    expect(said).toMatchObject({ session, to, source: "explicit", known: false });

    // The catalog shows the belonging, with the source it was written with.
    const listed = await client.call<unknown, { belongings: unknown[] }>("session.list" as ActionName, {});
    expect(listed.belongings).toEqual([{ session, to, source: "explicit" }]);

    // Saying the same thing again is one fact, not two: nothing new is written.
    const again = await client.call("session.belong" as ActionName, { session, to, source: "explicit" });
    expect(again).toMatchObject({ known: true });
    const written = await client.records.read(seq(0), { type: SessionBelongs.name });
    expect(written).toHaveLength(1);
    // The actor is the caller: the one who said it, not the host.
    expect(written[0]?.actor).toMatchObject({ kind: "client" });
    expect(JSON.stringify(written[0]?.actor)).toContain("alice");

    // Another address is another belonging.
    await client.call("session.belong" as ActionName, { session, to: { kind: "task", id: "t1" }, source: "explicit" });
    const both = await client.call<unknown, { belongings: unknown[] }>("session.list" as ActionName, {});
    expect(both.belongings).toEqual([
      { session, to, source: "explicit" },
      { session, to: { kind: "task", id: "t1" }, source: "explicit" },
    ]);
  } finally {
    await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("belong: identical calls made at once write one record", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: [{ instance: instance("a", true), reading: fakeReading({ list: [info("a", "s1")] }) }] }));
  await host.serve();

  try {
    const session = sessionRef(sessionId(harnessId("a"), "s1"));
    const input = { session, to: { kind: "agent", id: "rin" }, source: "explicit" };
    await Promise.all([
      host.call("session.belong" as ActionName, input),
      host.call("session.belong" as ActionName, input),
      host.call("session.belong" as ActionName, input),
    ]);
    expect(await host.records.read(seq(0), { type: SessionBelongs.name })).toHaveLength(1);
  } finally {
    await host.close();
    await home.cleanup();
  }
});

test("search finds the records that hold every word, with their index and a snippet, and states coverage", async () => {
  const records: SessionRecord[] = [
    UserRecordSchema.parse({ kind: "user", text: "what is the plan?", locator: "l1", incomplete: false }),
    AssistantRecordSchema.parse({ kind: "assistant", text: "We ship the PLAN on Friday", locator: "l2", incomplete: false }),
    ToolCallRecordSchema.parse({ kind: "tool-call", callId: "c1", name: "read", category: "read", input: { path: "plan.md" }, locator: "l3", incomplete: false }),
    UnknownRecordSchema.parse({ kind: "unknown", raw: { plan: "friday" }, locator: "l4", incomplete: false }),
    CompactionRecordSchema.parse({ kind: "compaction", summary: "the plan is friday", locator: "l5", incomplete: false }),
  ];
  const actions = install(
    {
      harnesses: [
        { instance: instance("a", true), reading: fakeReading({ records, coverage: { status: "empty" } }) },
        { instance: instance("t", true), reading: fakeReading({ records, readFailsAfter: 1 }) },
        { instance: instance("n", false) },
      ],
    },
    undefined,
  );

  // Every word, case aside; the index counts every record, the unknown one too.
  const both = await actions["session.search"]!({ session: "a s1", query: "plan FRIDAY" });
  expect(both.matches.map((m: { index: number }) => m.index)).toEqual([1, 4]);
  expect(both.matches[0]).toEqual({ index: 1, kind: "assistant", locator: "l2", snippet: "We ship the PLAN on Friday" });
  expect(both.more).toBe(false);
  expect(both.coverage).toEqual({ status: "empty" });

  // A tool call is searched by its name and its input.
  const tool = await actions["session.search"]!({ session: "a s1", query: "plan.md" });
  expect(tool.matches.map((m: { kind: string }) => m.kind)).toEqual(["tool-call"]);

  // Limit and offset page through the matches.
  const first = await actions["session.search"]!({ session: "a s1", query: "plan", limit: 2 });
  expect(first.matches.map((m: { index: number }) => m.index)).toEqual([0, 1]);
  expect(first.more).toBe(true);
  const rest = await actions["session.search"]!({ session: "a s1", query: "plan", limit: 2, offset: 2 });
  expect(rest.matches.map((m: { index: number }) => m.index)).toEqual([2, 4]);
  expect(rest.more).toBe(false);

  // A snippet is cut around the first word that matched.
  const long = install(
    {
      harnesses: [
        {
          instance: instance("a", true),
          reading: fakeReading({
            records: [UserRecordSchema.parse({ kind: "user", text: `${"x ".repeat(100)}needle${" y".repeat(100)}`, locator: "l1", incomplete: false })],
          }),
        },
      ],
    },
    undefined,
  );
  const cut = await long["session.search"]!({ session: "a s1", query: "needle" });
  expect(cut.matches[0].snippet.startsWith("…")).toBe(true);
  expect(cut.matches[0].snippet.endsWith("…")).toBe(true);
  expect(cut.matches[0].snippet).toContain("needle");

  // A read that fails is said, never shown as no matches; what matched before it is kept.
  const torn = await actions["session.search"]!({ session: "t s1", query: "plan" });
  expect(torn.matches.map((m: { index: number }) => m.index)).toEqual([0]);
  expect(torn.coverage).toEqual({ status: "failed", reason: "torn file" });
  const none = await actions["session.search"]!({ session: "n s1", query: "plan" });
  expect(none.coverage.status).toBe("unavailable");
});
