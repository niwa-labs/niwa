// Waiting for the end of a watched session from a workflow script: one wait for the end record of
// the session, under the label it is given, typed by the record.

import { afterEach, expect, test } from "bun:test";

import { harnessId, sessionId } from "@niwa-labs/harness";

import { untilSessionEnded } from "../src/flow.ts";
import { HistorySessionEnded, sessionEnded } from "../src/records.ts";

const session = sessionId(harnessId("codex"), "s-1");

const waits: Array<{ query: unknown; opts: unknown }> = [];
const scripted = globalThis as { wait?: unknown };

/** The `wait` a workflow script has, answered with what the test says. */
function script(answer: unknown): void {
  scripted.wait = async (query: unknown, opts: unknown) => {
    waits.push({ query, opts });
    return answer;
  };
}

afterEach(() => {
  delete scripted.wait;
  waits.length = 0;
});

test("the end of a session is a query of its type, filtered on both parts of the session's id", () => {
  expect(sessionEnded(session)).toEqual({
    types: [HistorySessionEnded],
    filter: { "session.harness": "codex", "session.native": "s-1" },
  });
});

test("untilSessionEnded waits for the end of the session under its label and answers how it ended", async () => {
  script({ data: { session, certainty: "exact", why: "session-ended" }, at: 42 });
  expect(await untilSessionEnded("end", { session, from: 7, timeout: "30m" })).toEqual({ ended: true, certainty: "exact", why: "session-ended", at: 42 });
  expect(waits).toEqual([{ query: sessionEnded(session), opts: { from: 7, timeout: "30m", label: "end" } }]);
});

test("untilSessionEnded says the session did not end when the wait ran out of time", async () => {
  script({ timedOut: true });
  expect(await untilSessionEnded("end", { session, timeout: "1m" })).toEqual({ ended: false });
  expect(waits).toEqual([{ query: sessionEnded(session), opts: { timeout: "1m", label: "end" } }]);
});

test("untilSessionEnded runs inside a workflow script only", async () => {
  await expect(untilSessionEnded("end", { session })).rejects.toThrow('"wait" is not a global here');
});
