// The handle of a start's first turn, and the group wait over tracked turns.
//
//   1. a start with a real first prompt answers the handle of that exact turn, and two calls cover
//      the question and its answer; an empty start answers no handle, a retry answers the same one,
//      and a schema at the start validates the first answer as a send's schema does;
//   2. `session.turn-wait-many` wakes on the first terminal outcome (a failure included), waits for
//      all under one deadline with the partial state on timeout, keys every entry by its input
//      index and handle in input order, takes duplicate handles deliberately, leaves every turn
//      running (nothing sent, consumed or cancelled), and refuses the whole call when one handle is
//      not a tracked turn — before anything is reported;
//   3. both survive a restart of the host: what settled reads the same, and a turn lost with the
//      host reads as ended;
//   4. a schema cannot manufacture a turn out of an empty start: a prompt with no text and a
//      schema together are refused before the harness is asked anything.

import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { connectAsOwner, spawnHost, tempHome } from "@niwa-labs/testing";

import { sessionStart, sessionTurnSend, sessionTurnWait, sessionTurnWaitMany } from "../src/index.ts";
import type { SessionTurnHandle } from "../src/index.ts";
import { fakeHost, HARNESS, INSTRUCTIONS, SESSION } from "./fixtures/restart-host.ts";

const HOST = new URL("./fixtures/restart-host.ts", import.meta.url).pathname;
const COUNT = { type: "object", properties: { count: { type: "integer" } }, required: ["count"] };

test("a start with a real first prompt answers the handle of that turn, and the handle waits", async () => {
  const home = await tempHome();
  const client = fakeHost(home.path, true);
  const write = (lines: string) => appendFileSync(join(home.path, INSTRUCTIONS), lines);
  try {
    await client.serve();
    const started = await client.call(sessionStart, { harness: HARNESS, prompt: "open the shop", operation: "shop" });
    const handle = started.handle!;
    expect(handle).toEqual({ session: SESSION, operation: "shop", turn: 1 });
    expect(started.receipt).toMatchObject({ status: "started", turn: 1 });
    // The turn is running: a look with no budget says nothing yet, and the turn keeps running.
    expect(await client.call(sessionTurnWait, { ...handle, timeoutMs: 0 })).toEqual({ status: "timed-out" });
    write("turn-started 1\nturn-ended 1 completed first answer\n");
    expect(await client.call(sessionTurnWait, { ...handle, timeoutMs: 3000 })).toEqual({ status: "completed", value: "first answer" });
    // A wait consumes nothing: the same handle answers again, and so does a restart of the host.
    expect(await client.call(sessionTurnWait, { ...handle, timeoutMs: 0 })).toEqual({ status: "completed", value: "first answer" });
    await client.close();
    const after = fakeHost(home.path, true);
    try {
      await after.serve();
      expect(await after.call(sessionTurnWait, { ...handle, timeoutMs: 0 })).toEqual({ status: "completed", value: "first answer" });
      // A retry of the start answers the session it made, with the same handle.
      const retry = await after.call(sessionStart, { harness: HARNESS, prompt: "open the shop", operation: "shop" });
      expect(retry).toEqual(started);
    } finally {
      await after.close();
    }
  } finally {
    await client.close().catch(() => undefined);
    await home.cleanup();
  }
}, 20_000);

test("an empty start answers no handle, and a schema at the start validates the first answer", async () => {
  const home = await tempHome();
  const client = fakeHost(home.path, true);
  const write = (lines: string) => appendFileSync(join(home.path, INSTRUCTIONS), lines);
  try {
    await client.serve();
    const empty = await client.call(sessionStart, { harness: HARNESS, prompt: "", operation: "empty" });
    expect(empty.handle).toBeUndefined();
    expect(empty.receipt).toBeUndefined();
    await expect(client.call(sessionTurnWait, { session: SESSION, operation: "empty", timeoutMs: 0 })).rejects.toThrow(/no accepted tracked send/);

    const typed = await client.call(sessionStart, {
      harness: HARNESS, prompt: "count the stock", operation: "count", schema: COUNT,
    });
    expect(typed.handle).toEqual({ session: SESSION, operation: "count", turn: 1 });
    write('turn-started 1\nturn-ended 1 completed {"count": 7}\n');
    expect(await client.call(sessionTurnWait, { ...typed.handle!, timeoutMs: 3000 })).toEqual({ status: "completed", value: { count: 7 } });
  } finally {
    await client.close();
    await home.cleanup();
  }
}, 20_000);

test("a start with a schema and no prompt text refuses, and manufactures no turn or receipt", async () => {
  const home = await tempHome();
  const client = fakeHost(home.path, true);
  try {
    await client.serve();
    // The schema's instructions are the only content such a start would deliver: the two together
    // are a caller error, refused before the harness is asked anything.
    await expect(client.call(sessionStart, {
      harness: HARNESS, prompt: " ", operation: "review-empty", schema: { type: "integer" },
    })).rejects.toThrow(/an empty prompt starts no turn/);
    await expect(client.call(sessionStart, {
      harness: HARNESS,
      prompt: { sections: [{ id: "quiet", tier: "volatile", text: " \t " }] },
      operation: "review-sections", schema: { type: "string" },
    })).rejects.toThrow(/an empty prompt starts no turn/);

    // Nothing was made: no session exists, and the operations have no turn to wait for.
    expect((await client.records.read()).filter((row) => row.type === "session.started")).toEqual([]);
    await expect(client.call(sessionTurnWait, { session: SESSION, operation: "review-empty", timeoutMs: 0 }))
      .rejects.toThrow(/no accepted tracked send/);

    // The same schema with a real prompt is the ordinary typed start it always was.
    const typed = await client.call(sessionStart, {
      harness: HARNESS, prompt: "count again", operation: "count-again", schema: { type: "integer" },
    });
    expect(typed.handle).toEqual({ session: SESSION, operation: "count-again", turn: 1 });
  } finally {
    await client.close();
    await home.cleanup();
  }
}, 20_000);

test("turn-wait-many wakes on the first terminal outcome, and waits for all under one deadline", async () => {
  const home = await tempHome();
  const client = fakeHost(home.path, true);
  const write = (lines: string) => appendFileSync(join(home.path, INSTRUCTIONS), lines);
  const many = (handles: SessionTurnHandle[], until: "first" | "all", timeoutMs?: number) =>
    client.call(sessionTurnWaitMany, { handles, until, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  try {
    await client.serve();
    await client.call(sessionStart, { harness: HARNESS, prompt: "" });
    const one = await client.call(sessionTurnSend, { session: SESSION, message: "one", operation: "one" });
    const two = await client.call(sessionTurnSend, { session: SESSION, message: "two", operation: "two", schema: COUNT });
    const three = await client.call(sessionTurnSend, { session: SESSION, message: "three", operation: "three" });
    const failed = await client.call(sessionTurnSend, { session: SESSION, message: "failed", operation: "failed" });

    // Nothing settled: a look with no budget names every handle pending, in input order.
    expect(await many([one.handle, two.handle, three.handle], "first", 0)).toEqual({
      done: [],
      pending: [
        { index: 0, handle: one.handle },
        { index: 1, handle: two.handle },
        { index: 2, handle: three.handle },
      ],
      timedOut: true,
    });

    // The first terminal outcome wakes `first`; the sibling turns keep running.
    write("turn-started 1\nturn-ended 1 completed group one\n");
    expect(await many([one.handle, two.handle, three.handle], "first", 3000)).toEqual({
      done: [{ index: 0, handle: one.handle, result: { status: "completed", value: "group one" } }],
      pending: [{ index: 1, handle: two.handle }, { index: 2, handle: three.handle }],
      timedOut: false,
    });

    // `all` shares one deadline: on its expiry the partial state comes back, nothing is cancelled.
    expect(await many([one.handle, two.handle, three.handle, failed.handle], "all", 60)).toEqual({
      done: [{ index: 0, handle: one.handle, result: { status: "completed", value: "group one" } }],
      pending: [
        { index: 1, handle: two.handle },
        { index: 2, handle: three.handle },
        { index: 3, handle: failed.handle },
      ],
      timedOut: true,
    });

    // A turn that settles while the group waits wakes it: one call is out, then the turns settle.
    const waiting = many([one.handle, two.handle, failed.handle], "all", 3000);
    write('turn-started 2\nturn-ended 2 completed {"count": 2}\nturn-started 4\nturn-ended 4 failed\n');
    expect(await waiting).toEqual({
      done: [
        { index: 0, handle: one.handle, result: { status: "completed", value: "group one" } },
        { index: 1, handle: two.handle, result: { status: "completed", value: { count: 2 } } },
        { index: 2, handle: failed.handle, result: { status: "ended", how: "failed" } },
      ],
      pending: [],
      timedOut: false,
    });

    // A failure wakes `first` too, and an already-settled handle is done with no wait at all.
    expect(await many([three.handle, failed.handle], "first", 0)).toEqual({
      done: [{ index: 1, handle: failed.handle, result: { status: "ended", how: "failed" } }],
      pending: [{ index: 0, handle: three.handle }],
      timedOut: false,
    });

    // Duplicate handles are deliberate: the same handle is answered once per place.
    expect(await many([one.handle, one.handle], "all", 0)).toEqual({
      done: [
        { index: 0, handle: one.handle, result: { status: "completed", value: "group one" } },
        { index: 1, handle: one.handle, result: { status: "completed", value: "group one" } },
      ],
      pending: [],
      timedOut: false,
    });

    // The group wait consumed nothing: the single wait still answers, on a handle the group named done.
    expect(await client.call(sessionTurnWait, { ...one.handle, timeoutMs: 0 })).toEqual({ status: "completed", value: "group one" });
    write("turn-started 3\nturn-ended 3 completed three answer\n");
    const settled = await many([one.handle, two.handle, three.handle, failed.handle], "all", 3000);
    expect(settled.timedOut).toBe(false);
    expect(settled.pending).toEqual([]);
    expect(settled.done.map((entry) => [entry.index, entry.result.status])).toEqual([[0, "completed"], [1, "completed"], [2, "completed"], [3, "ended"]]);

    // One handle nothing knows refuses the whole call, settled handles included, before anything is reported.
    await expect(many([one.handle, { session: SESSION, operation: "nope" }], "first", 0)).rejects.toThrow(/no accepted tracked send/);
    await expect(many([{ ...one.handle, turn: 99 }], "all", 0)).rejects.toThrow(/does not match/);
  } finally {
    await client.close();
    await home.cleanup();
  }
}, 20_000);

test("group waits and start handles read the same after a restart, and a turn lost with the host reads as ended", async () => {
  const home = await tempHome();
  let host = spawnHost(HOST, home.path, ["--tracked"]);
  try {
    await host.ready();
    const before = await connectAsOwner(home.path);
    const started = await before.call(sessionStart, { harness: HARNESS, prompt: "open" });
    appendFileSync(join(home.path, INSTRUCTIONS), "turn-started 1\nturn-ended 1 completed kept\n");
    const open = await before.call(sessionTurnSend, { session: SESSION, message: "open turn", operation: "open" });
    expect(await before.call(sessionTurnWaitMany, {
      handles: [started.handle!, open.handle], until: "first", timeoutMs: 3000,
    })).toEqual({
      done: [{ index: 0, handle: started.handle!, result: { status: "completed", value: "kept" } }],
      pending: [{ index: 1, handle: open.handle }],
      timedOut: false,
    });
    await before.close();
    await host.kill();

    host = spawnHost(HOST, home.path, ["--tracked"]);
    await host.ready();
    const after = await connectAsOwner(home.path);
    try {
      expect(await after.call(sessionTurnWaitMany, {
        handles: [started.handle!, open.handle], until: "all", timeoutMs: 0,
      })).toEqual({
        done: [
          { index: 0, handle: started.handle!, result: { status: "completed", value: "kept" } },
          { index: 1, handle: open.handle, result: { status: "ended", how: "unknown" } },
        ],
        pending: [],
        timedOut: false,
      });
      expect(await after.call(sessionTurnWait, { ...started.handle!, timeoutMs: 0 })).toEqual({ status: "completed", value: "kept" });
    } finally {
      await after.close();
    }
  } finally {
    await host.stop();
    await home.cleanup();
  }
}, 20_000);
