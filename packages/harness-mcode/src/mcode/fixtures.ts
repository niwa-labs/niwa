/**
 * The fixtures of the conformance suite for MiniMax Code: the four scenarios written the way the
 * harness writes them (format.ts, paths.ts). `home` is the directory the reading side is opened on.
 */

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";
import { harnessId, sessionId } from "@niwa-labs/harness";

import { LOG_NAME, MANIFEST_NAME, encodeNativeId } from "./paths.ts";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("mcode");

const line = (message: object): string => `${JSON.stringify({ message_id: "m", message })}\n`;
const user = (text: string): string => line({ role: "user", timestamp: 1000, content: text });
const answer = (text: string): string =>
  line({ role: "assistant", timestamp: 2000, model: "mcode-1", content: [{ type: "text", text }] });

/** The half-written line is cut inside a string: not parseable until the rest arrives. */
const FINAL_ANSWER = answer("the finished answer");
const CUT = FINAL_ANSWER.length - 12;

export const writeMcodeFixtures: FixtureWriter = async (home, scenario) => {
  const native = `mvs_${scenario}`;
  const dir = join(
    home,
    "v2",
    "sessions",
    "2026",
    "10",
    "07",
    `12-00-00-000-session_${encodeNativeId(native)}`,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, MANIFEST_NAME),
    JSON.stringify({ sessionId: native, createdAtMs: 1000, updatedAtMs: 2000 }),
  );
  const log = join(dir, LOG_NAME);
  const body = bodyOf(scenario);
  await writeFile(log, body.text);

  const result: FixtureResult = {
    session: sessionId(FIXTURE_HARNESS, native),
    ...(body.child === undefined ? {} : { child: sessionId(FIXTURE_HARNESS, body.child) }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(scenario === "running"
      ? { finish: () => appendFile(log, FINAL_ANSWER.slice(CUT)) }
      : {}),
    makeUnreadable: async () => {
      await rm(log);
      await mkdir(log);
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
  return result;
};

function bodyOf(scenario: Scenario): { text: string; child?: string; summary?: string } {
  const start = user("hello") + answer("hi there");
  switch (scenario) {
    case "running":
      return { text: start + FINAL_ANSWER.slice(0, CUT) };
    case "nested":
      return {
        text:
          start +
          line({
            role: "assistant",
            timestamp: 3000,
            content: [{ type: "toolCall", id: "call_1", name: "task", arguments: { prompt: "work" } }],
          }) +
          line({
            role: "toolResult",
            timestamp: 4000,
            toolCallId: "call_1",
            toolName: "task",
            content: [{ type: "text", text: 'started session_id="mvs_child"' }],
          }),
        child: "mvs_child",
      };
    case "compaction":
      return {
        text: start + line({ role: "compactionSummary", timestamp: 3000, summary: "what happened so far" }),
        summary: "what happened so far",
      };
    case "broken":
      return { text: `${start}{"unfamiliar":"shape"}\nnot json at all\n` };
  }
}
