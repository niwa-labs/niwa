/**
 * The fixtures of the conformance suite for Claude Code: the four scenarios written the way the
 * harness writes them (format.ts, paths.ts). `home` is the directory the reading side is opened
 * on, and the harness keeps its sessions under `<home>/projects`.
 */

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";
import { harnessId, sessionId } from "@niwa-labs/harness";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("claude-code");

/** The id of the session a scenario writes; it is a uuid, as the harness writes. */
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** The id of the subagent the nested scenario spawns. */
const AGENT_ID = "agent-1";

/** The directory of the project inside the home of the fixtures. */
const PROJECT_DIR = "-work-project";

const record = (value: object): string => `${JSON.stringify(value)}\n`;

const user = (text: string): string =>
  record({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-07T12:00:00.000Z",
    cwd: "/work/project",
    sessionId: SESSION_ID,
    message: { role: "user", content: text },
  });

const answer = (text: string): string =>
  record({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-10-07T12:00:01.000Z",
    cwd: "/work/project",
    sessionId: SESSION_ID,
    message: { role: "assistant", model: "claude-test-1", content: [{ type: "text", text }] },
  });

/** The half-written line is cut inside a string: not parseable until the rest arrives. */
const FINAL_ANSWER = answer("the finished answer");
const CUT = FINAL_ANSWER.length - 12;

export const writeClaudeCodeFixtures: FixtureWriter = async (home, scenario) => {
  const projectDir = join(home, "projects", PROJECT_DIR);
  await mkdir(projectDir, { recursive: true });
  const log = join(projectDir, `${SESSION_ID}.jsonl`);
  const body = bodyOf(scenario);
  await writeFile(log, body.text);
  if (scenario === "nested") await writeChild(projectDir, "toolu_01spawn");

  const result: FixtureResult = {
    session: sessionId(FIXTURE_HARNESS, SESSION_ID),
    ...(body.child === undefined ? {} : { child: sessionId(FIXTURE_HARNESS, body.child) }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(scenario === "running"
      ? { finish: () => appendFile(log, FINAL_ANSWER.slice(CUT)) }
      : {}),
    makeUnreadable: async () => {
      await rm(log);
      await mkdir(log);
    },
    remove: () => rm(projectDir, { recursive: true, force: true }),
  };
  return result;
};

/** The child session of the nested scenario, with the description that names the call. */
async function writeChild(projectDir: string, toolUseId: string): Promise<void> {
  const dir = join(projectDir, SESSION_ID, "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "work", toolUseId }),
  );
  await writeFile(
    join(dir, `agent-${AGENT_ID}.jsonl`),
    record({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-07T12:00:02.000Z",
      cwd: "/work/project",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      isSidechain: true,
      message: { role: "user", content: "the work" },
    }),
  );
}

function bodyOf(scenario: Scenario): { text: string; child?: string; summary?: string } {
  const start = user("hello") + answer("hi there");
  switch (scenario) {
    case "running":
      return { text: start + FINAL_ANSWER.slice(0, CUT) };
    case "nested":
      return {
        text:
          start +
          record({
            type: "assistant",
            uuid: "a2",
            timestamp: "2026-10-07T12:00:02.000Z",
            cwd: "/work/project",
            sessionId: SESSION_ID,
            message: {
              role: "assistant",
              model: "claude-test-1",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_01spawn",
                  name: "Agent",
                  input: { description: "work", prompt: "do it" },
                },
              ],
            },
          }),
        child: `subagent-${AGENT_ID}`,
      };
    case "compaction":
      return {
        text:
          start +
          record({
            type: "system",
            subtype: "compact_boundary",
            uuid: "s1",
            timestamp: "2026-10-07T12:00:03.000Z",
            cwd: "/work/project",
            sessionId: SESSION_ID,
            content: "Conversation compacted",
          }) +
          record({
            type: "user",
            uuid: "u2",
            isCompactSummary: true,
            timestamp: "2026-10-07T12:00:03.100Z",
            cwd: "/work/project",
            sessionId: SESSION_ID,
            message: { role: "user", content: "what happened so far" },
          }),
        summary: "what happened so far",
      };
    case "broken":
      return { text: `${start}{"unfamiliar":"shape"}\nnot json at all\n` };
  }
}
