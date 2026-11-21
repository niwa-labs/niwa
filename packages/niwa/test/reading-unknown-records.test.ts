// A record niwa does not understand is not an error.
//
// The reading side of every harness kind that is installed on this machine is read against the
// REAL home of that kind: the sessions there were started by hand, in the harnesses themselves.
// For each kind the check lists the sessions, reads an old one, and holds the side to its promise:
// reading does not throw, and a record the side does not understand comes back as "unknown" with
// its raw data kept.
//
// The check is read-only: the side only opens the files of the real home and never writes there.
// No host is started, so no journal is written at all.
//
// The check is skipped unless NIWA_LIVE=1 and the home of the kind is on this machine.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { harnessId } from "@niwa-labs/harness";
import type { SessionInfo, SessionRecord, SessionReading } from "@niwa-labs/harness";

import { ClaudeCodeReading } from "@niwa-labs/harness-claude";
import { CodexReading } from "@niwa-labs/harness-codex";
import { McodeReading } from "@niwa-labs/harness-mcode";
import { piReading } from "@niwa-labs/harness-pi";
import { ZcodeReading } from "@niwa-labs/harness-zcode";
import { live } from "@niwa-labs/testing";

/** The kinds of record the reading sides speak about; anything else comes back as "unknown". */
const KNOWN_KINDS = ["user", "assistant", "tool-call", "tool-result", "checklist", "permission", "compaction", "nested"];

/** How many of the oldest sessions of a kind the check reads before it gives up on finding one. */
const CANDIDATES = 25;

/** The oldest sessions of a kind, as a share of the whole list. */
const OLD_SHARE = 0.3;

/**
 * The sessions root of pi.
 *
 * pi is a library niwa reads the files of, and it keeps its sessions where it likes. The root is
 * named by `NIWA_PI_SESSIONS_ROOT`; without it the default of the installation is used, when it is
 * there.
 */
const PI_ROOT = process.env["NIWA_PI_SESSIONS_ROOT"] ?? join(homedir(), ".pi", "agent", "sessions");

/** A harness kind of this machine, with the reading side that serves it. */
interface Kind {
  /** The id of the kind. */
  readonly id: string;
  /** The home of the real installation on this machine. */
  readonly home: string;
  /** The reading side of that installation. */
  readonly reading: () => SessionReading;
}

/** The kinds of this machine, each with the home it lives in. */
const KINDS: readonly Kind[] = [
  {
    id: "claude-code",
    home: join(homedir(), ".claude"),
    reading: () =>
      new ClaudeCodeReading({ harness: harnessId("claude-code"), home: join(homedir(), ".claude") }),
  },
  {
    id: "codex",
    home: join(homedir(), ".codex"),
    reading: () => new CodexReading({ harness: harnessId("codex"), home: join(homedir(), ".codex") }),
  },
  {
    id: "mcode",
    home: join(homedir(), ".minimax"),
    reading: () => new McodeReading({ harness: harnessId("mcode"), home: join(homedir(), ".minimax") }),
  },
  {
    id: "zcode",
    home: join(homedir(), ".zcode"),
    reading: () => new ZcodeReading({ harness: harnessId("zcode"), home: join(homedir(), ".zcode") }),
  },
  {
    id: "pi",
    home: PI_ROOT,
    reading: () => piReading({ harness: harnessId("pi"), sessionsRoot: PI_ROOT }),
  },
];

/**
 * The check of one kind: list the sessions of the real home, read the old ones, and hold the
 * side to its promise.
 */
async function checkKind(kind: Kind): Promise<void> {
  const reading = kind.reading();
  const startedAt = Date.now();

  // The sessions that are there: the side lists them from the files of the real home.
  const infos: SessionInfo[] = [];
  for await (const info of reading.list()) infos.push(info);
  expect(infos.length).toBeGreaterThan(0);

  // An old session: one of the ones the side has had the longest.
  const old = [...infos]
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, Math.max(1, Math.ceil(infos.length * OLD_SHARE)));
  expect(old.length).toBeGreaterThan(0);

  const failures: string[] = [];
  let recordsRead = 0;
  let unknownSeen = 0;
  let textSeen = 0;
  let sessionsRead = 0;
  let emptySeen = 0;
  let chosen = "";

  for (const info of old.slice(0, CANDIDATES)) {
    // Reading never throws: an unfamiliar record is a record, not a failure.
    let records: SessionRecord[];
    try {
      records = [];
      for await (const record of reading.read(info.id)) records.push(record);
    } catch (error) {
      failures.push(`reading ${info.id.native} threw: ${reasonOf(error)}`);
      continue;
    }

    // The side says what it knows about the session, and it knows it.
    let coverage: { readonly status: string };
    try {
      coverage = await reading.coverage(info.id);
    } catch (error) {
      failures.push(`the coverage of ${info.id.native} threw: ${reasonOf(error)}`);
      continue;
    }
    if (coverage.status === "failed" || coverage.status === "unavailable") {
      failures.push(`the coverage of ${info.id.native} is ${coverage.status}`);
      continue;
    }

    // A session that holds nothing is empty, and empty is not a failure: the old sessions of
    // a kind are not all alike, and some of them were closed before they said anything.
    if (records.length === 0) {
      emptySeen += 1;
      continue;
    }

    sessionsRead += 1;
    recordsRead += records.length;

    for (const record of records) {
      // A kind niwa does not know is "unknown", and nothing else.
      expect([...KNOWN_KINDS, "unknown"]).toContain(record.kind);

      if (record.kind !== "unknown") {
        if ((record.kind === "user" || record.kind === "assistant") && record.text !== "") textSeen += 1;
        continue;
      }

      // An unfamiliar record keeps its raw data: the harness's own record, whole.
      unknownSeen += 1;
      if (record.raw === undefined) {
        failures.push(`the unknown record at ${record.locator} of ${info.id.native} kept no raw data`);
        continue;
      }
      try {
        const raw = await reading.raw(info.id, record.locator);
        if (raw === undefined || !reading.rawSchema.safeParse(raw).success) {
          failures.push(`the raw data at ${record.locator} of ${info.id.native} is not the harness's own record`);
        }
      } catch (error) {
        failures.push(`the raw data at ${record.locator} of ${info.id.native} could not be read: ${reasonOf(error)}`);
      }
    }

    if (chosen === "") chosen = `${kind.id}/${info.id.native}`;
  }

  // The old sessions read: the side gave the records of the sessions that are on disk.
  expect(failures).toEqual([]);
  expect(sessionsRead).toBeGreaterThan(0);
  expect(recordsRead).toBeGreaterThan(0);

  console.log(
    `${kind.id}: sessions listed ${String(infos.length)}, ` +
      `old sessions read ${String(sessionsRead)} (${chosen}), ` +
      `empty old sessions ${String(emptySeen)}, ` +
      `records read ${String(recordsRead)}, text records ${String(textSeen)}, ` +
      `unknown records ${String(unknownSeen)}, ` +
      `in ${String(Date.now() - startedAt)} ms`,
  );
}

for (const kind of KINDS) {
  // A kind whose home is not on this machine is skipped, and the reason is said.
  if (!existsSync(kind.home)) {
    test.skipIf(!live)(`${kind.id}: skipped — the home of the kind is not on this machine`, () => {
      console.log(`${kind.id}: skipped — no home to read at ${kind.home}`);
    });
    continue;
  }

  test.skipIf(!live)(
    `${kind.id}: the sessions of the real home are listed and read, and an unfamiliar record comes back as unknown with its raw data`,
    async () => {
      await checkKind(kind);
    },
    300_000,
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
