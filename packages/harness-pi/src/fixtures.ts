/**
 * The fixtures of the conformance suite for pi: the four scenarios written the way pi writes
 * them. `home` is the directory the reading side is opened on.
 *
 * pi keeps a session in `<home>/--<slug(cwd)>--/<fileTimestamp>_<sessionId>.jsonl`, one JSON
 * object per line, the first of which is the header. The sessions of a run of subagents live in
 * a directory named after the session that spawned them:
 * `<home>/--<slug(cwd)>--/<fileTimestamp>_<sessionId>/<run>/run-N/session.jsonl`.
 */

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { FixtureResult, FixtureWriter, Scenario } from "@niwa-labs/harness";

/** The installation id the fixtures are written for; the suite opens its reading side with it. */
export const FIXTURE_HARNESS = harnessId("pi");

/** The working directory the fixtures pretend to run in. */
const CWD = "/fixtures/project";

/** The project directory pi keeps the sessions of that working directory in. */
const PROJECT = "--fixtures-project--";

/** The start time of a session, as pi writes it into the name of the file. */
const FILE_TIMESTAMP = "2026-10-27T09-15-00-000Z";

/** The id of the session of a scenario. */
const nativeOf = (scenario: Scenario): string => `pi-fixture-${scenario}`;

/** The id pi writes into the header of a session of a run of subagents. */
const NATIVE_OF_CHILD = "pi-fixture-child";

/** The header of a session. */
const header = (native: string): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: native,
    timestamp: "2026-10-27T09:15:00.000Z",
    cwd: CWD,
  });

/** An entry of a session. */
const entry = (value: object): string => `${JSON.stringify(value)}\n`;

/** What the owner said. */
const user = (text: string): string =>
  entry({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-27T09:15:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });

/** What the model said. */
const assistant = (text: string, id = "a1"): string =>
  entry({
    type: "message",
    id,
    parentId: "u1",
    timestamp: "2026-10-27T09:15:02.000Z",
    message: { role: "assistant", model: "pi-1", content: [{ type: "text", text }] },
  });

/** The last answer of a running session, cut in the middle so that it is half written. */
const FINAL_ANSWER = assistant("the finished answer", "a2");
const CUT = FINAL_ANSWER.length - 12;

export const writePiFixtures: FixtureWriter = async (home, scenario) => {
  const native = nativeOf(scenario);
  const dir = join(home, PROJECT);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${FILE_TIMESTAMP}_${native}.jsonl`);
  const body = bodyOf(scenario);
  await writeFile(file, header(native) + "\n" + body.text);

  // The session of a run of subagents is a file of its own, in the directory of the session that
  // spawned it.
  if (body.child !== undefined) {
    const run = join(dir, `${FILE_TIMESTAMP}_${native}`, "run-1", "run-0");
    await mkdir(run, { recursive: true });
    await writeFile(
      join(run, "session.jsonl"),
      header(NATIVE_OF_CHILD) + "\n" + user("work in the child") + assistant("done in the child"),
    );
  }

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
  const start = user("hello") + assistant("hi there");
  switch (scenario) {
    case "running":
      return { text: start + FINAL_ANSWER.slice(0, CUT) };
    case "nested":
      return { text: start, child: NATIVE_OF_CHILD };
    case "compaction":
      return {
        text:
          start +
          entry({
            type: "compaction",
            id: "k1",
            parentId: "a1",
            timestamp: "2026-10-27T09:15:03.000Z",
            summary: "what happened so far",
          }),
        summary: "what happened so far",
      };
    case "broken":
      return { text: `${start}{"unfamiliar":"shape"}\nnot json at all\n` };
  }
}
