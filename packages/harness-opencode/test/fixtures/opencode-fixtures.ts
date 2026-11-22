/**
 * The fixtures of the reading conformance suite for OpenCode: the four scenarios as the data the
 * fake server serves (`FAKE_DATA_DIR`, fake-opencode-server.ts). For this kind the format IS what
 * the HTTP API gives back, so the writer writes the store the server reads — `sessions.json` and
 * `messages-<id>.json`, the rows shaped as opencode's own session and message lists carry them.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("opencode-fake");

/** The session spawned inside the `nested` scenario's session. */
const CHILD = "ses_subagent_fixture";

/** One session row, as opencode's own session list carries it. */
interface SessionRow {
  readonly id: string;
  readonly parentID?: string;
  readonly projectID: string;
  readonly title?: string;
  readonly time: { readonly created: number; readonly updated: number };
  readonly location: { readonly directory: string };
}

/** One message row, as opencode's own message list carries it. */
type MessageRow = Record<string, unknown>;

function sessionRow(id: string, created: number, updated: number, parent?: string): SessionRow {
  return {
    id,
    ...(parent === undefined ? {} : { parentID: parent }),
    projectID: "prj_fixture",
    time: { created, updated },
    location: { directory: "/work/opencode" },
  };
}

const userMessage = (id: string, text: string, created: number): MessageRow => ({
  id,
  time: { created },
  type: "user",
  text,
});

const assistantMessage = (id: string, created: number, content: readonly unknown[], completed = true): MessageRow => ({
  id,
  time: { created, ...(completed ? { completed: created + 100 } : {}) },
  type: "assistant",
  agent: "build",
  model: { id: "fixture-model", providerID: "fixture" },
  content: [...content],
});

function messagesOf(scenario: Scenario): MessageRow[] {
  const start = [userMessage("m_user", "hello", 1_000), assistantMessage("m_answer", 1_010, [{ type: "text", text: "hi there" }])];
  switch (scenario) {
    case "running":
      return [...start, assistantMessage("m_final", 1_020, [{ type: "text", text: "the finished answer" }], false)];
    case "nested":
      return [
        ...start,
        assistantMessage("m_tool", 1_020, [
          {
            type: "tool",
            id: "call_1",
            name: "task",
            state: { status: "completed", input: { description: "work" }, content: [{ type: "text", text: "done" }] },
            time: { created: 1_020, completed: 1_025 },
          },
        ]),
      ];
    case "compaction":
      return [
        ...start,
        { id: "m_summary", time: { created: 1_020 }, type: "compaction", status: "completed", reason: "manual", summary: "what happened so far" },
      ];
    case "broken":
      return [...start, { id: "m_odd", time: { created: 1_020 }, type: "frobnicate", shape: "unfamiliar" }];
  }
}

export const writeOpencodeFixtures: FixtureWriter = async (dir, scenario) => {
  const native = `ses_fixture-${scenario}`;
  const messages = messagesOf(scenario);
  const sessions = [sessionRow(native, 1_000, 1_000 + messages.length * 10)];
  if (scenario === "nested") sessions.push(sessionRow(CHILD, 1_030, 1_040, native));
  await writeFile(join(dir, "sessions.json"), JSON.stringify(sessions));
  await writeFile(join(dir, `messages-${native}.json`), JSON.stringify(messages));
  if (scenario === "nested") {
    await writeFile(join(dir, `messages-${CHILD}.json`), JSON.stringify([userMessage("child_user", "work", 1_030)]));
  }

  const messagesPath = join(dir, `messages-${native}.json`);
  const result: FixtureResult = {
    session: sessionId(FIXTURE_HARNESS, native),
    ...(scenario === "nested" ? { child: sessionId(FIXTURE_HARNESS, CHILD) } : {}),
    ...(scenario === "compaction" ? { summary: "what happened so far" } : {}),
    ...(scenario === "running"
      ? {
          finish: async () => {
            // The half-written line becomes whole: the last message gets its completion.
            const rows = JSON.parse(await readFile(messagesPath, "utf8")) as MessageRow[];
            const last = rows.at(-1);
            if (last !== undefined) {
              last["time"] = { created: 1_020, completed: 1_100 };
              await writeFile(messagesPath, JSON.stringify(rows));
            }
          },
        }
      : {}),
    makeUnreadable: () => writeFile(messagesPath, "this is not json"),
    remove: async () => {
      await writeFile(join(dir, "sessions.json"), JSON.stringify(sessions.filter((session) => session.id !== native)));
      await rm(messagesPath, { force: true });
      await rm(join(dir, `messages-${CHILD}.json`), { force: true });
    },
  };
  return result;
};
