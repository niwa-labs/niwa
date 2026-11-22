import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { connectAsOwner, eventually, spawnHost, tempHome } from "@niwa-labs/testing";

import { SessionTurnResult, SessionTurnStarted, sessionAsk, sessionInterrupt, sessionResume, sessionSend, sessionStart, sessionTurnSend, sessionTurnWait } from "../src/index.ts";
import { fakeHost, HARNESS, INSTRUCTIONS } from "./fixtures/restart-host.ts";

const HOST = new URL("./fixtures/restart-host.ts", import.meta.url).pathname;

test("tracked sends correlate concurrent waits despite duplicate starts and persist the exact outcomes", async () => {
  const home = await tempHome();
  let client = fakeHost(home.path, true);
  const write = (lines: string) => appendFileSync(join(home.path, INSTRUCTIONS), lines);
  try {
    await client.serve();
    const { session } = await client.call(sessionStart, { harness: HARNESS, prompt: "" });
    const send = (message: string) => client.call(sessionTurnSend, { session, message });
    const wait = (handle: Awaited<ReturnType<typeof send>>["handle"], timeoutMs = 3000) =>
      client.call(sessionTurnWait, { ...handle, timeoutMs });
    const firstInput = { session, message: "first", operation: "first" };
    const [first, retry] = await Promise.all([
      client.call(sessionTurnSend, firstInput), client.call(sessionTurnSend, firstInput),
    ]);
    expect(retry).toEqual(first);
    const second = await client.call(sessionTurnSend, {
      session, message: "second", schema: {
        type: "object", properties: { count: { type: "integer" } }, required: ["count"],
      },
    });
    expect(first.receipt).toMatchObject({ status: "started", turn: 1 });
    expect(second.receipt).toMatchObject({ status: "queued", turn: 2 });
    expect(await wait(second.handle, 0)).toEqual({ status: "timed-out" });

    const firstWaits = [wait(first.handle), wait(first.handle)];
    const secondWait = wait(second.handle);
    write("turn-started 1\nturn-started 1\nturn-ended 1 completed first answer\n");
    expect(await Promise.all(firstWaits)).toEqual([
      { status: "completed", value: "first answer" }, { status: "completed", value: "first answer" },
    ]);
    expect(await wait(second.handle, 0)).toEqual({ status: "timed-out" });
    write('turn-started 2\nturn-started 2\nturn-ended 2 completed {"count":2}\n');
    expect(await secondWait).toEqual({ status: "completed", value: { count: 2 } });
    expect(await wait(second.handle, 0)).toEqual({ status: "completed", value: { count: 2 } });
    expect((await client.records.read({ types: [SessionTurnStarted] })).map(row => row.data.turn)).toEqual([1, 2]);
    expect((await client.records.read({ types: [SessionTurnResult] })).map(row => [row.data.turn, row.data.answer]))
      .toEqual([[1, "first answer"], [2, '{"count":2}']]);
    await expect(client.call(sessionTurnWait, { ...first.handle, turn: second.handle.turn })).rejects.toThrow(/does not match/);

    const fast = await send("instant exact answer");
    expect(await wait(fast.handle)).toEqual({ status: "completed", value: "exact answer" });
    const failed = await send("failed");
    const unknown = await send("unknown");
    const discarded = await send("discarded");
    const missing = await send("no answer");
    const invalid = await client.call(sessionTurnSend, { session, message: "invalid", schema: { type: "integer" } });
    write(`turn-started 4\nturn-failed 4 network denied\nturn-started 5\nturn-ended 5 unknown\nturn-discarded 6\nturn-started 7\nturn-ended 7 completed\nturn-started 8\nturn-ended 8 completed "invalid"\n`);
    expect(await Promise.all([wait(failed.handle), wait(unknown.handle), wait(discarded.handle), wait(missing.handle), wait(invalid.handle)])).toEqual([
      { status: "ended", how: "failed", diagnostic: "network denied" }, { status: "ended", how: "unknown" }, { status: "ended", how: "failed" },
      { status: "no-answer" }, { status: "invalid-answer" },
    ]);
    const handled = await send("handled");
    expect(handled.handle.turn).toBeUndefined();
    expect(await wait(handled.handle)).toEqual({ status: "handled" });
    await expect(send("unsent")).rejects.toThrow(/did not take/);
    await expect(send("uncertain")).rejects.toThrow(/may have taken/);

    const legacy = await client.call(sessionSend, { session, message: "instant legacy text" });
    expect(legacy).toEqual({ receipt: expect.objectContaining({ status: "started", turn: 9 }) });
    expect(await client.call(sessionAsk, {
      session, prompt: "old ask", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    })).toEqual({ value: { answer: "legacy" } });
    const interrupted = await send("interrupt me");
    write("turn-started 10\n");
    await eventually(async () => (await client.records.read({ types: [SessionTurnStarted] })).some((row) => row.data.turn === 10));
    await client.call(sessionInterrupt, { session });
    write("turn-ended 10 failed\n");
    expect(await wait(interrupted.handle)).toEqual({ status: "ended", how: "interrupted" });
    expect((await client.records.read({ types: [SessionTurnResult] })).map((row) => row.data.turn)).not.toContain(9);

    await client.close();
    client = fakeHost(home.path, true);
    await client.serve();
    expect(await wait(first.handle, 0)).toEqual({ status: "completed", value: "first answer" });
    expect(await wait(second.handle, 0)).toEqual({ status: "completed", value: { count: 2 } });
  } finally {
    await client.close();
    await home.cleanup();
  }
}, 20_000);

test("tracked receipts and results survive SIGKILL and queued turn numbers cannot be reused", async () => {
  const home = await tempHome();
  let host = spawnHost(HOST, home.path, ["--tracked"]);
  try {
    await host.ready();
    const before = await connectAsOwner(home.path);
    const { session } = await before.call(sessionStart, { harness: HARNESS, prompt: "" });
    const completed = await before.call(sessionTurnSend, { session, message: "instant retained" });
    expect(await before.call(sessionTurnWait, completed.handle)).toEqual({ status: "completed", value: "retained" });
    const running = await before.call(sessionTurnSend, { session, message: "running" });
    const queued = await before.call(sessionTurnSend, { session, message: "queued", operation: "queue" });
    expect(queued.receipt).toMatchObject({ status: "queued", turn: 3 });
    appendFileSync(join(home.path, INSTRUCTIONS), "turn-started 2\n");
    expect(await before.call(sessionTurnWait, { ...queued.handle, timeoutMs: 50 })).toEqual({ status: "timed-out" });
    await host.kill();
    await before.close();

    host = spawnHost(HOST, home.path, ["--tracked"]);
    await host.ready();
    const after = await connectAsOwner(home.path);
    try {
      expect(await after.call(sessionTurnWait, completed.handle)).toEqual({ status: "completed", value: "retained" });
      expect(await after.call(sessionTurnWait, running.handle)).toEqual({ status: "ended", how: "unknown" });
      expect(await after.call(sessionTurnWait, queued.handle)).toEqual({ status: "ended", how: "unknown" });
      await after.call(sessionResume, { session });
      expect(await after.call(sessionTurnSend, { session, message: "queued", operation: "queue" })).toEqual(queued);
      const next = await after.call(sessionTurnSend, { session, message: "instant new" });
      expect(next.handle.turn).toBe(4);
      expect(await after.call(sessionTurnWait, next.handle)).toEqual({ status: "completed", value: "new" });
      expect(await after.call(sessionTurnWait, queued.handle)).toEqual({ status: "ended", how: "unknown" });
    } finally {
      await after.close();
    }
  } finally {
    await host.stop();
    await home.cleanup();
  }
}, 20_000);
