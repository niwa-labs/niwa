/**
 * The fixtures of the conformance suite for ZCode: the four scenarios written the way the harness
 * writes them (format.ts, paths.ts). `home` is the directory the reading side is opened on.
 *
 * The database is a copy of the harness's own tables, with the columns the reading side uses, in
 * rollback-journal mode so no `-wal` or `-shm` file is left behind.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";

import { dbPathOf } from "./paths.ts";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("zcode");

const SCHEMA = [
  `create table session (id text primary key, project_id text not null, directory text not null, title text not null,
     title_source text not null, parent_id text, time_created integer not null, time_updated integer not null, time_deleted integer)`,
  `create table message (id text primary key, session_id text not null, time_created integer not null,
     time_updated integer not null, data text not null, sequence integer)`,
  `create table part (id text primary key, message_id text not null, session_id text not null,
     time_created integer not null, time_updated integer not null, data text not null, sequence integer)`,
  `create table local_setting (scope text not null, scope_id text not null, namespace text not null, key text not null,
     value text not null, schema_version integer not null, time_created integer not null, time_updated integer not null,
     primary key(scope, scope_id, namespace, key))`,
];

/** The session as a database of the harness holds it, and what the tests write into it. */
export function createDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  for (const statement of SCHEMA) db.run(statement);
  return db;
}

/** One message of a session: its row, and the rows of its parts. */
export interface FixtureMessage {
  readonly id: string;
  readonly data: Record<string, unknown>;
  /** The JSON of each part; a string is written as it is, so a part that is not JSON can be made. */
  readonly parts: ReadonlyArray<Record<string, unknown> | string>;
}

/** Writes a session with its messages, in the order given. `at` is the time of the first message. */
export function writeSession(
  db: Database,
  native: string,
  messages: readonly FixtureMessage[],
  options: { readonly directory?: string; readonly parent?: string; readonly at?: number; readonly title?: string; readonly project?: string } = {},
): void {
  const at = options.at ?? 1_000;
  db.query(
    "insert into session (id, project_id, directory, title, title_source, parent_id, time_created, time_updated) values (?, ?, ?, ?, 'generated', ?, ?, ?)",
  ).run(native, options.project ?? "p", options.directory ?? "/work/zcode", options.title ?? `title of ${native}`, options.parent ?? null, at, at + messages.length * 10);
  const insertMessage = db.query(
    "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)",
  );
  const insertPart = db.query(
    "insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [index, message] of messages.entries()) {
    const created = at + index * 10;
    insertMessage.run(message.id, native, created, created, JSON.stringify(message.data), index);
    for (const [place, part] of message.parts.entries()) {
      insertPart.run(`${message.id}_part${place}`, message.id, native, created, created, typeof part === "string" ? part : JSON.stringify(part), place);
    }
  }
}

export const user = (id: string, text: string): FixtureMessage => ({
  id,
  data: { role: "user", time: { created: 1000 }, semantics: { uiVisibility: "visible" } },
  parts: [{ type: "text", text, time: { start: 1000, end: 1000 } }],
});

export const assistant = (id: string, text: string, completed = true): FixtureMessage => ({
  id,
  data: {
    role: "assistant",
    time: completed ? { created: 2000, completed: 2100 } : { created: 2000 },
    modelId: "fixture-model",
    providerId: "fixture",
  },
  parts: [{ type: "text", text, time: { start: 2000 } }],
});

export const writeZcodeFixtures: FixtureWriter = async (home, scenario) => {
  const native = `sess_fixture-${scenario}`;
  const path = dbPathOf(home);
  await mkdir(dirname(path), { recursive: true });
  const db = createDatabase(path);
  try {
    writeSession(db, native, messagesOf(scenario), { at: 1_000 });
    if (scenario === "nested") {
      writeSession(db, "sess_subagent_agent_fixture", [user("child_user", "work")], { parent: native, at: 1_000 + 25 });
    }
  } finally {
    db.close();
  }

  const result: FixtureResult = {
    session: sessionId(FIXTURE_HARNESS, native),
    ...(scenario === "nested" ? { child: sessionId(FIXTURE_HARNESS, "sess_subagent_agent_fixture") } : {}),
    ...(scenario === "compaction" ? { summary: "what happened so far" } : {}),
    ...(scenario === "running"
      ? {
          finish: async () => {
            const writable = new Database(path);
            try {
              writable
                .query("update message set data = ? where id = 'm_final'")
                .run(JSON.stringify({ ...assistant("m_final", "").data, time: { created: 2000, completed: 2100 } }));
            } finally {
              writable.close();
            }
          },
        }
      : {}),
    makeUnreadable: () => writeFile(path, "this is not a database"),
    remove: () => rm(path, { force: true }),
  };
  return result;
};

function messagesOf(scenario: Scenario): FixtureMessage[] {
  const start = [user("m_user", "hello"), assistant("m_answer", "hi there")];
  switch (scenario) {
    case "running":
      return [...start, assistant("m_final", "the finished answer", false)];
    case "nested":
      return [
        ...start,
        {
          id: "m_tool",
          data: { role: "assistant", time: { created: 2000, completed: 2100 } },
          parts: [
            {
              type: "tool",
              callID: "call_1",
              tool: "Agent",
              state: { status: "completed", input: { prompt: "work" }, output: "done", time: { start: 2000, end: 2100 } },
            },
          ],
        },
      ];
    case "compaction":
      return [
        ...start,
        {
          id: "m_summary",
          data: { role: "user", time: { created: 3000 }, summary: { title: "Compact summary", body: "what happened so far" } },
          parts: [{ type: "text", text: "This session is being continued from a previous conversation." }],
        },
        {
          id: "m_boundary",
          data: { role: "assistant", time: { created: 3000, completed: 3000 } },
          parts: [{ type: "compaction", summaryMessageId: "m_summary", time: { start: 3000, end: 3000 } }],
        },
      ];
    case "broken":
      return [
        ...start,
        {
          id: "m_odd",
          data: { role: "assistant", time: { created: 3000, completed: 3000 } },
          parts: [{ type: "frobnicate", shape: "unfamiliar" }, "not json at all"],
        },
      ];
  }
}
