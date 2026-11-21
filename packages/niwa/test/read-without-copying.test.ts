// Sessions started without niwa, read without copying.
//
// The sessions on this machine were started by hand, in the harnesses themselves: niwa did not
// start them and holds no record of them. The reading side must still list them and read them,
// and reading must copy nothing into niwa's journal.
//
// The check is read-only against the REAL homes of this machine: it only opens their files, and it
// never writes there. Each kind gets its own niwa home — a temporary one — so its journal starts
// empty and every session the reading side lists is one niwa never started.
//
// What it proves, for every kind whose home is on this machine:
//   1. session.list returns sessions that niwa never started (none has a session.started record)
//   2. session.read of the newest such session returns records, with the text of the conversation
//   3. the journal grows by less than a tenth of the bytes read: reading copies nothing
//   4. an unfamiliar record kind comes back as "unknown", with no failure
//
// The test is skipped unless NIWA_LIVE=1 and the home of the kind is on this machine.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { actionName, idSchema, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading } from "@niwa-labs/harness";
import { SessionStarted, sessionRef, sessions } from "@niwa-labs/sessions";
import { tempHome, live } from "@niwa-labs/testing";
import { z } from "zod";

import {
  dirNamesOf,
  entryNamesOf,
  fileNamesOf,
  projectsRootOf,
  sessionLogOf,
  subagentsDirOf,
  ClaudeCodeReading,
} from "@niwa-labs/harness-claude";
import { nativeIdOfFileName, CodexReading } from "@niwa-labs/harness-codex";
import { logPathOf, nativeIdFromDirName, McodeReading } from "@niwa-labs/harness-mcode";
import { piReading } from "@niwa-labs/harness-pi";

/** How many of the newest sessions a kind may look at before it gives up on one with text. */
const CANDIDATES = 10;

/** How much of the bytes read the journal may grow by, as a fraction. */
const GROWTH_BUDGET = 0.1;

/** What `session.list` answers, as far as the check reads it. */
const ListOutput = z.looseObject({
  sessions: z.array(
    z.looseObject({
      ref: z.string(),
      state: z.string(),
      startedAt: z.number().optional(),
      lastActivityAt: z.number().optional(),
    }),
  ),
  unreadable: z.array(z.looseObject({ harness: z.string(), reason: z.string() })),
});

/** What `session.read` answers, as far as the check reads it. */
const ReadOutput = z.looseObject({
  records: z.array(
    z.looseObject({
      kind: z.string(),
      locator: z.string(),
      incomplete: z.boolean(),
      text: z.string().optional(),
    }),
  ),
  coverage: z.looseObject({ status: z.string(), reason: z.string().optional() }),
});

/** The record of a session that was started: the session it names. */
const StartedData = z.looseObject({ session: z.string() });

/** The kinds of a record the reading side speaks about; the rest is "unknown". */
const KNOWN_KINDS = ["user", "assistant", "tool-call", "tool-result", "checklist", "permission", "compaction", "nested"];

/** A harness of this machine, with the reading side that serves it. */
interface Kind {
  /** The id of the harness. */
  readonly id: string;
  /** The home of the real installation on this machine. */
  readonly home: string;
  /** The reading side of that installation. */
  readonly reading: () => SessionReading;
  /** The file of every session on disk, by the id the harness gave it. */
  readonly files: () => Promise<Map<string, string>>;
}

/** The size of the journal of a home: the database and the write-ahead log beside it. */
async function journalBytes(home: string): Promise<number> {
  let total = 0;
  for (const name of ["journal.db", "journal.db-wal"]) {
    try {
      total += (await stat(join(home, name))).size;
    } catch {
      // The file is not there: it holds nothing.
    }
  }
  return total;
}

/** The size of a file, or zero when it is not there. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The directories under a path, at one level. */
async function dirsOf(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The files under a path, at one level. */
async function filesOf(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The log of every session of a Claude Code installation, by the id the harness gave it.
 *
 * The log of a session is `<projects>/<slug>/<native>.jsonl`; the log of a subagent is
 * `agent-<id>.jsonl` beside it, and the harness calls that session `subagent-<id>`.
 */
async function claudeFiles(root: string): Promise<Map<string, string>> {
  const logs = new Map<string, string>();
  for (const projectDir of await dirNamesOf(root)) {
    const dir = join(root, projectDir);
    for (const name of await entryNamesOf(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const native = name.slice(0, name.length - ".jsonl".length);
      logs.set(native, sessionLogOf(dir, native));
    }
    for (const sessionDir of await dirNamesOf(dir)) {
      const subagents = subagentsDirOf(dir, sessionDir);
      for (const name of await fileNamesOf(subagents)) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        const agentId = name.slice("agent-".length, name.length - ".jsonl".length);
        logs.set(`subagent-${agentId}`, join(subagents, name));
      }
    }
  }
  return logs;
}

/** The rollout of every session of a Codex installation, by the id in the name of the file. */
async function codexFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const native = nativeIdOfFileName(entry.name);
      if (native !== null) {
        files.set(native, path);
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return files;
}

/** The journal of every session of a MiniMax Code installation, by the id of its manifest. */
async function mcodeFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const year of await dirsOf(root)) {
    for (const month of await dirsOf(join(root, year))) {
      for (const day of await dirsOf(join(root, year, month))) {
        const dayPath = join(root, year, month, day);
        for (const dirName of await dirsOf(dayPath)) {
          const native = nativeIdFromDirName(dirName);
          if (native === null) continue;
          files.set(native, logPathOf(join(dayPath, dirName)));
        }
      }
    }
  }
  return files;
}

/** The file of a session of a pi installation: the id is in the name, after the timestamp. */
const PI_SESSION_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/;

/** The files pi writes that are not sessions. */
const PI_NOT_A_SESSION = [".pass1.jsonl", "run-history.jsonl"];

/** The file of every session of a pi installation, by the id in the name of the file. */
async function piFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const project of await dirsOf(root)) {
    for (const name of await filesOf(join(root, project))) {
      if (PI_NOT_A_SESSION.some((suffix) => name.endsWith(suffix))) continue;
      const native = PI_SESSION_FILE.exec(name)?.[1];
      if (native === undefined) continue;
      files.set(native, join(root, project, name));
    }
  }
  return files;
}

/**
 * The sessions root of pi.
 *
 * pi is a library niwa reads the files of, and it keeps its sessions where it likes. The root is
 * named by `NIWA_PI_SESSIONS_ROOT`; without it the default of the installation is used, when it is
 * there. Without a root there is nothing to read, and the check says so and skips.
 */
const PI_ROOT = process.env["NIWA_PI_SESSIONS_ROOT"] ?? join(homedir(), ".pi", "agent", "sessions");
const PI_ROOT_EXISTS = existsSync(PI_ROOT);

/** The kinds of this machine, each with the home it lives in. */
const KINDS: readonly Kind[] = [
  {
    id: "claude-code",
    home: join(homedir(), ".claude"),
    reading: () => new ClaudeCodeReading({ harness: harnessId("claude-code"), home: join(homedir(), ".claude") }),
    files: () => claudeFiles(projectsRootOf(join(homedir(), ".claude"))),
  },
  {
    id: "codex",
    home: join(homedir(), ".codex"),
    reading: () => new CodexReading({ harness: harnessId("codex"), home: join(homedir(), ".codex") }),
    files: () => codexFiles(join(homedir(), ".codex", "sessions")),
  },
  {
    id: "mcode",
    home: join(homedir(), ".minimax"),
    reading: () => new McodeReading({ harness: harnessId("mcode"), home: join(homedir(), ".minimax") }),
    files: () => mcodeFiles(join(homedir(), ".minimax", "v2", "sessions")),
  },
  {
    id: "pi",
    home: PI_ROOT,
    reading: () => piReading({ harness: harnessId("pi"), sessionsRoot: PI_ROOT }),
    files: () => piFiles(PI_ROOT),
  },
];

/**
 * The check of one kind: list the sessions niwa never started, read the newest of them, and
 * measure how much the journal grew while they were read.
 */
async function checkKind(kind: Kind): Promise<void> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  // The installation as it is on this machine, with its reading side and nothing else.
  const instance: Harness = {
    id: harnessId(kind.id),
    kind: harnessKind(kind.id),
    machine: machineId("here"),
    home: kind.home,
    sides: { reading: { list: true, read: true, watch: false } },
  };
  host.use(sessions({ harnesses: [{ instance, reading: kind.reading() }] }));
  await host.serve();

  try {
    // The sessions that are there. The side that could not list them is named, not hidden.
    const listed = ListOutput.parse(await host.call(actionName("session.list"), {}));
    expect(listed.unreadable).toEqual([]);
    expect(listed.sessions.length).toBeGreaterThan(0);

    // None of them was started by niwa: this journal is new and holds no session.started record.
    const started = await host.records.read(seq(0), { type: SessionStarted });
    const startedRefs = new Set(
      started.map((record) => StartedData.safeParse(record.data).data?.session ?? ""),
    );
    const foreign = listed.sessions.filter((entry) => !startedRefs.has(entry.ref));
    expect(foreign.length).toBe(listed.sessions.length);
    expect(foreign.length).toBeGreaterThan(0);

    const files = await kind.files();
    const newest = [...foreign].sort(
      (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
    );

    let recordsRead = 0;
    let unknownSeen = 0;
    let growthTotal = 0;
    let bytesRead = 0;
    let target: { ref: string; rank: number; records: number; text: number; file: number } | undefined;
    const growthBefore = await journalBytes(home.path);

    // The newest sessions are read one by one, until one of them holds a conversation.
    for (const [rank, entry] of newest.slice(0, CANDIDATES).entries()) {
      const before = await journalBytes(home.path);
      const read = ReadOutput.parse(await host.call(actionName("session.read"), { session: entry.ref }));
      const after = await journalBytes(home.path);
      growthTotal += Math.max(0, after - before);

      // Reading did not fail: what could not be read is said, and the rest is not shown as empty.
      expect(read.coverage.status).not.toBe("failed");
      expect(read.coverage.status).not.toBe("unavailable");

      // An unfamiliar record kind comes back as "unknown", with no failure.
      for (const record of read.records) {
        expect([...KNOWN_KINDS, "unknown"]).toContain(record.kind);
      }
      unknownSeen += read.records.filter((record) => record.kind === "unknown").length;
      recordsRead += read.records.length;

      const native = entry.ref.slice(kind.id.length + 1);
      const path = files.get(native);
      const file = path === undefined ? 0 : await sizeOf(path);
      // A session kept outside a file (MiniMax Code's durable history is a database), or whose file
      // is empty, is measured by what was read from it: no bytes read would make the budget zero.
      bytesRead += file > 0 ? file : Buffer.byteLength(JSON.stringify(read.records));

      const text = read.records.filter(
        (record) => (record.kind === "user" || record.kind === "assistant") && (record.text ?? "") !== "",
      ).length;

      // A session with nothing in it holds no conversation: the next one is the one to read.
      if (target === undefined && text > 0) {
        target = { ref: entry.ref, rank: rank + 1, records: read.records.length, text, file };
      }
    }

    // The newest session niwa never started holds the text of a conversation.
    expect(target).toBeDefined();
    expect(target?.records ?? 0).toBeGreaterThan(0);
    expect(target?.text ?? 0).toBeGreaterThan(0);

    // An unfamiliar kind of record was met, and it came back as "unknown" rather than an error.
    expect(unknownSeen).toBeGreaterThan(0);

    // The journal holds no part of the transcript: over every read it grew by less than a
    // tenth of the bytes that were read.
    expect(growthTotal).toBeLessThan(bytesRead * GROWTH_BUDGET);
    expect(await journalBytes(home.path)).toBeLessThan(growthBefore + bytesRead * GROWTH_BUDGET);

    // The measure is a real one: a write of niwa's own does move the journal, so a growth of
    // zero after the reads is the reading side keeping its copies, not a measure that sees
    // nothing.
    const beforeWrite = await journalBytes(home.path);
    await host.emit(SessionStarted, {
      session: sessionRef(sessionId(harnessId(kind.id), "h9-measure")),
      id: idSchema("session").parse("s-c0ffee"),
    });
    expect(await journalBytes(home.path)).toBeGreaterThan(beforeWrite);

    console.log(
      `${kind.id}: sessions listed ${String(listed.sessions.length)}, ` +
        `records read ${String(recordsRead)} over ${String(Math.min(CANDIDATES, newest.length))} sessions, ` +
        `bytes read ${String(bytesRead)} B, ` +
        `journal growth ${String(growthTotal)} B ` +
        `(${((growthTotal / Math.max(bytesRead, 1)) * 100).toFixed(4)}% of the bytes read), ` +
        `newest session with text ${target?.ref ?? ""} (rank ${String(target?.rank ?? 0)}) ` +
        `file ${String(target?.file ?? 0)} B, records ${String(target?.records ?? 0)}, ` +
        `text records ${String(target?.text ?? 0)}, unknown records ${String(unknownSeen)}`,
    );
  } finally {
    await host.close();
    await home.cleanup();
  }
}

for (const kind of KINDS) {
  test.skipIf(!live || !existsSync(kind.home))(
    `${kind.id}: a session niwa never started is listed and read, and reading copies nothing into the journal`,
    async () => {
      await checkKind(kind);
    },
    600_000,
  );
}

test.skipIf(!live || PI_ROOT_EXISTS)("pi: the sessions root of pi is not on this machine", () => {
  console.log(
    `pi: skipped — no sessions root to read (NIWA_PI_SESSIONS_ROOT is ${process.env["NIWA_PI_SESSIONS_ROOT"] === undefined ? "not set" : "set to a root that is not there"}, and ${PI_ROOT} is not there)`,
  );
});
