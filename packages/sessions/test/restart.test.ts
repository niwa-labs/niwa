// The signs of life of a session across a restart of the host: after a restart a last "turn
// started" does not prove a turn is running now; the state is then "unknown".
//
// The host runs out of process, so it can really be killed:
//
//   1. a session starts, the fake reports a turn that starts and ends, and the journal holds both
//      signs of life;
//   2. the fake reports a turn that starts, the host is killed with SIGKILL while the turn is
//      open, and the host is started again on the same home: the state read through the public
//      API is "unknown", not "running";
//   3. the fake then reports that the turn ended, and the state becomes "idle".
//
// Only the public API is used: "@niwa-labs/core", the sessions entry and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { actionName, seq } from "@niwa-labs/core";
import { connectAsOwner, eventually, spawnHost, tempHome } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { SessionStarted, SessionTurnEnded, SessionTurnStarted } from "../src/index.ts";
import { HARNESS, INSTRUCTIONS, SESSION } from "./fixtures/restart-host.ts";

/** The host program of the test. */
const HOST_SCRIPT = join(import.meta.dir, "fixtures/restart-host.ts");

/** What the public API says about one session. */
const SessionEntry = z.object({
  ref: z.string(),
  state: z.enum(["running", "idle", "ended", "unknown"]),
});

/** The answer of "session.list". */
const SessionList = z.object({
  sessions: z.array(SessionEntry),
  unreadable: z.array(z.unknown()),
});

/** The answer of "session.running". */
const SessionRunning = z.object({
  running: z.array(z.string()),
  unknown: z.array(z.string()),
});

/** The answer of "session.start". */
const Started = z.object({ session: z.string(), ref: z.string() });

/** Call an action by its name, through the public API. */
function call(client: NiwaApi, name: string, input: unknown): Promise<unknown> {
  return client.call(actionName(name), input);
}

/** The types of the signs of life the journal holds, in the order they were written. */
async function lifeTypes(client: NiwaApi): Promise<string[]> {
  const records = await client.records.read(seq(0), {
    types: [SessionStarted, SessionTurnStarted, SessionTurnEnded],
  });
  return records.map((record) => String(record.type));
}

/** How many of the signs of life of one type the journal holds. */
async function countOf(client: NiwaApi, type: string): Promise<number> {
  return (await lifeTypes(client)).filter((entry) => entry === type).length;
}

/** The state of the one session, read through "session.list". */
async function stateOf(client: NiwaApi): Promise<string> {
  const listed = SessionList.parse(await call(client, "session.list", { harness: HARNESS }));
  expect(listed.sessions).toHaveLength(1);
  return listed.sessions[0]?.state ?? "missing";
}

/** Wait until the journal holds as many signs of life of one type as it should. */
async function untilCounted(client: NiwaApi, type: string, count: number, what: string): Promise<void> {
  await eventually(
    async () => (await countOf(client, type)) === count,
    10_000,
    `${what} (${String(count)} of "${type}")`,
  );
}

test("a turn left open by a dead host reads as unknown, and the turn that ends it reads as idle", async () => {
  const home = await tempHome();
  const instructions = join(home.path, INSTRUCTIONS);
  let host = spawnHost(HOST_SCRIPT, home.path);
  let client: NiwaApi | undefined;

  try {
    await host.ready();
    client = await connectAsOwner(home.path);
    const first = client;

    // 1. The session starts, the fake reports a turn that starts and ends, and the journal
    // holds both signs of life.
    const started = Started.parse(await call(first, "session.start", { harness: HARNESS, prompt: "go" }));
    expect(started.ref).toBe(SESSION);

    appendFileSync(instructions, "turn-started 1\n");
    await untilCounted(first, "session.turn-started", 1, "the turn did not start");
    // The turn is open in this very process: it is running now.
    expect(await stateOf(first)).toBe("running");

    appendFileSync(instructions, "turn-ended 1\n");
    await untilCounted(first, "session.turn-ended", 1, "the turn did not end");
    expect(await lifeTypes(first)).toEqual([
      "session.started",
      "session.turn-started",
      "session.turn-ended",
    ]);
    // The turn is closed: the session is idle.
    expect(await stateOf(first)).toBe("idle");

    // 2. The fake reports a turn that starts, and the host is killed while the turn is open.
    appendFileSync(instructions, "turn-started 2\n");
    await untilCounted(first, "session.turn-started", 2, "the second turn did not start");
    await host.kill();

    // The host comes back on the same home, and the fake reports nothing yet.
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();
    await client.close();
    client = await connectAsOwner(home.path);
    const second = client;

    // The open turn proves nothing about now: the state is "unknown", never "running".
    expect(await stateOf(second)).toBe("unknown");
    const running = SessionRunning.parse(await call(second, "session.running", { harness: HARNESS }));
    expect(running.running).toEqual([]);
    expect(running.unknown.map((line) => line.split("  ")[0])).toEqual([started.session]);

    // 3. The fake reports that the turn ended: the session is idle again.
    await call(second, "session.resume", { session: SESSION });
    appendFileSync(instructions, "turn-ended 2\n");
    await untilCounted(second, "session.turn-ended", 2, "the second turn did not end");
    expect(await stateOf(second)).toBe("idle");
  } finally {
    await client?.close().catch(() => undefined);
    await host.stop();
    await home.cleanup();
  }
});
