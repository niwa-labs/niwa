// The host program of the signs-of-life test: the signs of life of a session across a restart of the host.
//
// The fake control side reports the signs of life the test writes into a file of the home: one
// instruction per line, "turn-started <n>" or "turn-ended <n>". The fake reads the file from
// where it left off, so a host that starts again reports only what is told to it after the
// restart. The cursor of the fake is a file of its own, so the instructions are only ever
// appended to.
//
// The home comes from argv[2]. The test imports this file for the names it needs, so the host
// only starts when the file is run directly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
} from "@niwa-labs/harness";
import { createNiwa } from "@niwa-labs/testing";

import { sessions } from "../../src/index.ts";

/** The harness the fake control side serves. */
export const HARNESS = "fake-harness";

/** The session the fake control side names. */
export const SESSION = `${HARNESS} session-1`;

/** The file of the home the instructions are in. */
export const INSTRUCTIONS = "life.log";

/** The file of the home the cursor of the fake is in. */
const CURSOR = "life.cursor";

/** How often the fake looks at its instructions. */
const POLL_MS = 25;

/** The fake control side: it reports the signs of life the test tells it to. */
class FakeControl implements SessionControl {
  /** The file the instructions are in. */
  private readonly log: string;
  /** The file the cursor is in. */
  private readonly cursor: string;
  /** How many instructions were reported already. */
  private reported: number;

  constructor(log: string, cursor: string) {
    this.log = log;
    this.cursor = cursor;
    this.reported = readCursor(cursor);
  }

  async start(): Promise<{ session: SessionId }> {
    return { session: sessionId(harnessId(HARNESS), "session-1") };
  }

  async resume(): Promise<void> {}

  async send(): Promise<DeliveryReceipt> {
    return { status: "started", turn: 1 };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(_id: SessionId, _options: AskOptions<T>): Promise<AskAnswer<T>> {
    throw new Error("the fake control side does not ask");
  }

  async state(): Promise<SessionState> {
    return "idle";
  }

  /** The signs of life are the instructions of the file, one after another. */
  async *life(): AsyncIterable<LifeEvent> {
    for (;;) {
      const lines = instructions(this.log);
      while (this.reported < lines.length) {
        const event = eventOf(lines[this.reported] ?? "");
        this.reported += 1;
        // The cursor is written before the sign of life is reported: a host that dies after this
        // must not report the same instruction again.
        writeCursor(this.cursor, this.reported);
        if (event !== undefined) yield event;
      }
      await sleep(POLL_MS);
    }
  }
}

/** The instructions of the file, one per line. A line that is not finished yet is not one. */
function instructions(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.pop(); // what follows the last newline is a line that is still being written
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

/** The sign of life one instruction names. */
function eventOf(line: string): LifeEvent | undefined {
  const parts = line.split(" ");
  const turn = Number(parts[1]);
  if (!Number.isInteger(turn) || turn < 1) return undefined;
  const kind = parts[0];
  if (kind === "turn-started") return { kind: "turn-started", turn };
  if (kind === "turn-ended") return { kind: "turn-ended", turn };
  return undefined;
}

/** How many instructions were reported already, by an earlier host or by this one. */
function readCursor(path: string): number {
  if (!existsSync(path)) return 0;
  const count = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/** Write the cursor of the fake down. */
function writeCursor(path: string, count: number): void {
  writeFileSync(path, String(count));
}

/** The installation the fake control side serves. */
function installation(): Harness {
  return {
    id: harnessId(HARNESS),
    kind: harnessKind("fake-kind"),
    machine: machineId("machine-1"),
    home: "/tmp/fake-home",
    sides: {
      control: {
        start: true,
        resume: true,
        send: true,
        interrupt: false,
        ask: false,
        structuredOutput: false, launch: { model: false, effort: [], modes: [] },
      },
    },
  };
}

if (import.meta.main) {
  const home = process.argv[2];
  if (home === undefined) {
    console.error("usage: bun restart-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(
    sessions({
      harnesses: [
        {
          instance: installation(),
          control: new FakeControl(join(home, INSTRUCTIONS), join(home, CURSOR)),
        },
      ],
    }),
  );
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
