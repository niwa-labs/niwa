// The host program of the signs-of-life test: the signs of life of a session across a restart of the host.
//
// The fake control side reports the signs of life the test writes into a file of the home: one
// instruction per line, "turn-started <n>" or "turn-ended <n> [completed|failed|unknown]". The fake reads the file from
// where it left off, so a host that starts again reports only what is told to it after the
// restart. The cursor of the fake is a file of its own, so the instructions are only ever
// appended to.
//
// The home comes from argv[2]. The test imports this file for the names it needs, so the host
// only starts when the file is run directly.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { InputNotSent, InputPossiblySent, TurnOutcomeSchema, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
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
import { createNiwa, openBoxes } from "@niwa-labs/testing";

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
  private turn = 0;
  private held = false;
  private disposed = false;

  constructor(log: string, cursor: string, private readonly tracked: boolean) {
    this.log = log;
    this.cursor = cursor;
    this.reported = readCursor(cursor);
  }

  async start(options: { prompt: { sections: Array<{ text: string }> } }): Promise<{ session: SessionId; first?: DeliveryReceipt }> {
    this.held = true;
    // A prompt with text becomes the session's first turn, as a real control side delivers it.
    const text = options.prompt.sections.map((section) => section.text).join("\n\n").trim();
    if (text === "") return { session: sessionId(harnessId(HARNESS), "session-1") };
    this.turn = 1;
    return { session: sessionId(harnessId(HARNESS), "session-1"), first: { status: "started", turn: 1 } };
  }

  async resume(): Promise<void> {
    this.held = true;
  }

  async send(id: SessionId, message: string): Promise<DeliveryReceipt> {
    if (message === "handled") return { status: "handled" };
    if (message === "unsent") throw new InputNotSent(id.harness, "send", "refused");
    if (message === "uncertain") throw new InputPossiblySent(id.harness, "send", "lost reply");
    const turn = ++this.turn;
    if (message.startsWith("instant ")) {
      // The life stream can observe the result before this receipt is returned.
      appendFileSync(this.log, `turn-started ${turn}\nturn-ended ${turn} completed ${message.slice(8)}\n`);
      await sleep(75);
    }
    return { status: turn === 1 || message.startsWith("instant ") ? "started" : "queued", turn };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    return { session: id, value: options.schema.parse({ answer: "legacy" }) as T, at: 0 as never };
  }

  async state(): Promise<SessionState> {
    return this.tracked && !this.held ? "unknown" : "idle";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** The signs of life are the instructions of the file, one after another. */
  async *life(): AsyncIterable<LifeEvent> {
    while (!this.disposed) {
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
  if (kind === "turn-discarded") return { kind, turn };
  if (kind === "turn-failed") return { kind: "turn-ended", turn, outcome: "failed", diagnostic: parts.slice(2).join(" ") };
  if (kind === "turn-ended") {
    const outcome = TurnOutcomeSchema.safeParse(parts[2]);
    const answer = parts.length > 3 ? parts.slice(3).join(" ") : undefined;
    return { kind, turn, ...(outcome.success ? { outcome: outcome.data } : {}), ...(answer === undefined ? {} : { answer }) };
  }
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
        interrupt: true,
        ask: true,
        structuredOutput: true, launch: { model: false, effort: [], modes: [] },
      },
    },
  };
}

export function fakeHost(home: string, tracked = false) {
  const niwa = createNiwa({ home });
  niwa.use(
    sessions({
      sandbox: openBoxes(),
      harnesses: [
        {
          instance: installation(),
          control: new FakeControl(join(home, INSTRUCTIONS), join(home, CURSOR), tracked),
        },
      ],
    }),
  );
  return niwa;
}

if (import.meta.main) {
  const home = process.argv[2];
  if (home === undefined) {
    console.error("usage: bun restart-host.ts <home>");
    process.exit(2);
  }
  const niwa = fakeHost(home, process.argv.includes("--tracked"));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
