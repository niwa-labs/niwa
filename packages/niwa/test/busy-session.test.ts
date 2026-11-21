// Sending to a busy session.
//
// The check sends a second message into a session that is working, and reads what the receipt
// says:
//
//   - the session is busy: the receipt says "queued";
//   - the message waits for the turn after the running one: it is delivered when the current
//     turn ends, and the turn that ended comes before the turn that carries it;
//   - the session is idle: the receipt says "started".
//
// The run is a real one: a host process on a temporary home and a real Codex session behind it.
//
// The check is skipped unless NIWA_LIVE=1 and the "codex" binary is on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = new URL("./fixtures/busy-host.ts", import.meta.url).pathname;

/** The installation the sessions run in. */
const HARNESS = "codex-test";

/** The model the sessions run on. */
const MODEL = "gpt-6-luna";

/** How long one turn may take before the check gives up on it. */
const TURN_DEADLINE_MS = 300_000;

/** How long the whole check may take. */
const DEADLINE_MS = 600_000;

/**
 * A prompt that keeps the session working for a while.
 *
 * The turn has to be long enough for the second message to arrive while it runs: the check
 * sends it the moment the turn has started.
 */
const LONG_PROMPT = [
  "Count from 1 to 100, one number per line, and nothing else.",
  "Do not stop before 100, and do not say anything else.",
].join("\n");

/** What the receipt of a send says. */
const Receipt = z.object({
  receipt: z.object({
    status: z.enum(["delivered", "queued", "started"]),
    turn: z.number().int().positive().optional(),
  }),
});

/** What the start says: the session, and what became of its first prompt. */
const StartOutput = z.object({
  session: z.string(),
  ref: z.string(),
  receipt: z
    .object({
      status: z.enum(["delivered", "queued", "started"]),
      turn: z.number().int().positive().optional(),
    })
    .optional(),
});

/** The type of a record, as a plain string. */
function typeOf(record_: StoredRecord): string {
  return String(record_.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((entry) => typeOf(entry) === type);
}

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/** The data of a "session.turn-started" record: the session and the turn. */
const TurnStarted = z.object({ session: z.string(), turn: z.number().int().positive() });

/** The data of a "session.turn-ended" record: the session and the turn. */
const TurnEnded = z.object({ session: z.string(), turn: z.number().int().positive() });

/** The turn of a session that a record of this type names. */
function turnOf(entry: StoredRecord, kind: "session.turn-started" | "session.turn-ended"): number | undefined {
  const parsed = (kind === "session.turn-started" ? TurnStarted : TurnEnded).safeParse(entry.data);
  return parsed.success ? parsed.data.turn : undefined;
}

/** Wait until the condition holds; the failure says what was waited for. */
async function until(
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const until_ = Date.now() + deadlineMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= until_) throw new Error(`the ${what} did not happen within ${String(deadlineMs)} ms`);
    await Bun.sleep(100);
  }
}

/** The pids of the Codex processes that are running right now. */
function codexPids(): Set<string> {
  const found = Bun.spawnSync(["pgrep", "-f", "codex app-server"]);
  return new Set(
    found.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

test.skipIf(!(live && Bun.which("codex")))(
  "sending to a busy session: the receipt says queued, the message is delivered after the current turn, and an idle session starts a turn",
  async () => {
    const home = await tempHome();
    const before = codexPids();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);
      const client = api;

      // The session starts: the start returns once the session is named, and the prompt is its
      // first turn, which runs on after it. The session is idle only when that turn has ended.
      const startedAt = Date.now();
      const started = StartOutput.parse(
        await client.call(actionName("session.start"), {
          harness: HARNESS,
          prompt: "Reply with the single word ok.",
          model: MODEL,
        }),
      );
      expect(started.session).not.toBe("");
      const firstTurn = must(started.receipt?.turn, "the number of the first turn");
      expect(started.receipt?.status).toBe("started");
      await until(async () => {
        const records = await client.records.read();
        return recordsOf(records, "session.turn-ended").some((entry) => {
          const parsed = TurnEnded.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === firstTurn;
        });
      }, TURN_DEADLINE_MS, `the first turn of "${started.session}" to end`);

      // A long turn begins: the receipt says "started", and the turn runs on.
      const sentAt = Date.now();
      const running = Receipt.parse(
        await client.call(actionName("session.send"), {
          session: started.session,
          message: LONG_PROMPT,
        }),
      );
      expect(running.receipt.status).toBe("started");
      expect(running.receipt.turn).toBeDefined();

      // The session is busy: the long turn has started.
      const longTurn = must(running.receipt.turn, "the number of the long turn");
      await until(async () => {
        const records = await client.records.read();
        return recordsOf(records, "session.turn-started").some((entry) => {
          const parsed = TurnStarted.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === longTurn;
        });
      }, TURN_DEADLINE_MS, `the turn of "${started.session}" to start`);
      const busyAt = Date.now();

      // The second message waits behind the running turn: the receipt says "queued".
      const queued = Receipt.parse(
        await client.call(actionName("session.send"), {
          session: started.session,
          message: "Reply with the single word second.",
        }),
      );
      expect(queued.receipt.status).toBe("queued");
      const queuedMs = Date.now() - busyAt;

      // The message waits for the turn after the running one: the turn that ended comes before
      // the turn that carries the queued message.
      const runningTurn = must(running.receipt.turn, "the number of the running turn");
      const queuedTurn = must(queued.receipt.turn, "the number of the turn the queued message waits for");
      expect(queuedTurn).toBeGreaterThan(runningTurn);

      await until(async () => {
        const records = await client.records.read();
        return recordsOf(records, "session.turn-ended").some((entry) => {
          const parsed = TurnEnded.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === runningTurn;
        });
      }, TURN_DEADLINE_MS, `the turn ${String(runningTurn)} of "${started.session}" to end`);

      const afterFirstTurn = await client.records.read();
      const firstEnd = must(
        recordsOf(afterFirstTurn, "session.turn-ended").find((entry) => {
          const parsed = TurnEnded.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === runningTurn;
        }),
        "the record of the turn that ended",
      );

      // The queued message begins a turn of its own: the turn it waits for begins after the
      // turn that was running has ended.
      await until(async () => {
        const records = await client.records.read();
        return recordsOf(records, "session.turn-started").some((entry) => {
          const parsed = TurnStarted.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === queuedTurn;
        });
      }, TURN_DEADLINE_MS, `the queued message to be delivered`);

      const afterDelivery = await client.records.read();
      const secondStart = must(
        recordsOf(afterDelivery, "session.turn-started").find((entry) => {
          const parsed = TurnStarted.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === queuedTurn;
        }),
        "the record of the turn that carries the queued message",
      );

      // The order is what the check is about: the turn that ended comes before the turn that
      // carries the message that waited behind it.
      expect(Number(firstEnd.seq)).toBeLessThan(Number(secondStart.seq));

      const deliveredMs = Date.now() - busyAt;

      // The session is idle again: a message to an idle session starts a turn.
      await until(async () => {
        const records = await client.records.read();
        return recordsOf(records, "session.turn-ended").some((entry) => {
          const parsed = TurnEnded.safeParse(entry.data);
          return parsed.success && parsed.data.session === started.ref && parsed.data.turn === queuedTurn;
        });
      }, TURN_DEADLINE_MS, `the session "${started.session}" to be idle again`);

      const idleReceipt = Receipt.parse(
        await client.call(actionName("session.send"), {
          session: started.session,
          message: "Reply with the single word third.",
        }),
      );
      expect(idleReceipt.receipt.status).toBe("started");

      console.log(
        `live timings: session started, long turn sent after ${String(sentAt - startedAt)} ms, ` +
          `turn running after ${String(busyAt - sentAt)} ms, ` +
          `queued receipt after ${String(queuedMs)} ms, ` +
          `queued message delivered after ${String(deliveredMs)} ms, ` +
          `idle receipt "${idleReceipt.receipt.status}"`,
      );
      console.log(
        `turns: running turn ${String(running.receipt.turn)}, ` +
          `queued turn ${String(queued.receipt.turn)}, ` +
          `turn that ended ${String(turnOf(firstEnd, "session.turn-ended"))}, ` +
          `turn that carried it ${String(turnOf(secondStart, "session.turn-started"))}`,
      );
    } finally {
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
      // Nothing outlives the host: no Codex process the check started is still running.
      await Bun.sleep(1_000);
      const left = [...codexPids()].filter((pid) => !before.has(pid));
      expect(left).toEqual([]);
    }
  },
  DEADLINE_MS + 120_000,
);
