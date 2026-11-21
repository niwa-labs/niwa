/**
 * The fixtures of the conformance suite for Codex: the four scenarios written the way Codex writes
 * them (a rollout file of JSONL records under `sessions/YYYY/MM/DD`). `home` is the directory the
 * reading side is opened on.
 */

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";
import { harnessId, sessionId } from "@niwa-labs/harness";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("codex");

/** The uuid of the session of a scenario: the name of a rollout file carries it. */
const NATIVE_IDS: Record<Scenario, string> = {
  running: "00000000-0000-4000-8000-000000000001",
  nested: "00000000-0000-4000-8000-000000000002",
  compaction: "00000000-0000-4000-8000-000000000003",
  broken: "00000000-0000-4000-8000-000000000004",
};

/** The uuid of the session spawned inside the nested scenario. */
const CHILD_ID = "00000000-0000-4000-8000-0000000000ff";

/** One native record of a rollout. */
function record(ordinal: number, type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: `2026-01-01T00:00:0${ordinal}.000Z`, ordinal, type, payload })}\n`;
}

/** A message of the conversation layer. */
function message(ordinal: number, role: string, text: string): string {
  return record(ordinal, "response_item", {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  });
}

/** The half-written line is cut inside a string: it does not parse until the rest arrives. */
const FINAL_ANSWER = message(9, "assistant", "the finished answer");
const CUT = FINAL_ANSWER.length - 12;

export const writeCodexFixtures: FixtureWriter = async (home, scenario) => {
  const native = NATIVE_IDS[scenario];
  const dir = join(home, "sessions", "2026", "01", "01");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-01-01T00-00-00-${native}.jsonl`);
  const body = bodyOf(scenario);
  await writeFile(file, body.text);

  const result: FixtureResult = {
    session: sessionId(FIXTURE_HARNESS, native),
    ...(body.child === undefined ? {} : { child: sessionId(FIXTURE_HARNESS, body.child) }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(scenario === "running" ? { finish: () => appendFile(file, FINAL_ANSWER.slice(CUT)) } : {}),
    makeUnreadable: async () => {
      await rm(file);
      await mkdir(file);
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
  return result;
};

function bodyOf(scenario: Scenario): { text: string; child?: string; summary?: string } {
  const head = record(0, "session_meta", {
    id: NATIVE_IDS[scenario],
    session_id: NATIVE_IDS[scenario],
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/niwa-conformance",
  });
  const start = head + message(1, "user", "hello") + message(2, "assistant", "hi there");

  switch (scenario) {
    case "running":
      return { text: start + FINAL_ANSWER.slice(0, CUT) };
    case "nested":
      return {
        text:
          start +
          record(3, "event_msg", {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              kind: "started",
              id: "call_1",
              agent_thread_id: CHILD_ID,
              agent_path: "/root/worker",
            },
          }),
        child: CHILD_ID,
      };
    case "compaction":
      return {
        text: start + record(3, "compacted", { message: "what happened so far" }),
        summary: "what happened so far",
      };
    case "broken":
      return { text: `${start}{"unfamiliar":"shape"}\nnot json at all\n` };
  }
}
