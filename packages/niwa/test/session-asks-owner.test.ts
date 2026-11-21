// Live: a session asks the owner.
//
// A session whose visible actions include "submit-answer" is asked through "session.ask" with
// an answer schema. The installation cannot answer natively, so the question niwa asks of the
// session is a request, and the answer comes back through "submit-answer".
//
// The scenario has two parts:
//
//   1. the session is asked, and its answer validates against the schema;
//   2. the owner is asked a question of its own, and the test answers it through
//      "request.answer" — the request was addressed to the owner, and only the owner may
//      answer it.
//
// The assertions are on the journal: the records of the requests, the answers and the sessions.
//
// The test is skipped unless NIWA_LIVE=1 and the "mcode" binary is on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { ActionName as NiwaActionName, StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = new URL("./fixtures/ask-owner-host.ts", import.meta.url).pathname;

/** The action the test calls to start the scenario. */
const ASK: NiwaActionName = actionName("ownerask.ask");

/** The action that answers a request. */
const REQUEST_ANSWER: NiwaActionName = actionName("request.answer");

/** The action that lists what waits. */
const REQUEST_OPEN: NiwaActionName = actionName("request.open");

/** How long the scenario may take before the test gives up on it. */
const DEADLINE_MS = 600_000;

/** The type of a record, as a plain string. */
function typeOf(record: StoredRecord): string {
  return String(record.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((record) => typeOf(record) === type);
}

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/** The data of a "request.created" record. */
const RequestCreatedData = z.object({
  id: z.string(),
  to: z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }),
  question: z.string(),
});

/** The data of an "ownerask.answered" record. */
const AnsweredData = z.object({
  ownerAnswer: z.unknown().optional(),
  sessionAnswer: z.unknown().optional(),
  error: z.string().optional(),
});

/** The answer the owner gives: a text. */
const OwnerAnswer = z.object({ text: z.string().min(1) });

/** The answer the session gives: the same shape, checked against the schema. */
const SessionAnswer = z.object({ answer: z.string().min(1) });

/** Wait until the condition holds; the failure says what was waited for. */
async function until(
  fn: () => boolean | Promise<boolean>,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const untilAt = Date.now() + deadlineMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= untilAt) throw new Error(`${what} did not happen within ${String(deadlineMs)} ms`);
    await Bun.sleep(250);
  }
}

test.skipIf(!(live && Bun.which("mcode")))(
  "a session asks the owner: the answer comes through submit-answer, the owner answers its own question, and the structured answer passes the schema",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      // The client speaks for the owner: a client whose id starts with "owner:" is the owner,
      // and only the owner may answer a question that was addressed to the owner.
      api = await connectAsOwner(home.path, "owner:ask");

      const startedAt = Date.now();
      await api.call(ASK, { what: "which colour does the owner like?" });

      // The owner is asked first: the request reaches the owner and waits there.
      await until(
        async () => {
          const records = await api!.records.read();
          const created = recordsOf(records, "request.created").find((record) => {
            const data = record.data as { question?: string } | undefined;
            return data?.question === "ownerask.choice";
          });
          return created !== undefined;
        },
        DEADLINE_MS,
        "the question of the owner did not reach the owner",
      );

      // The question waits: it is open, and it is addressed to the owner.
      const open = z
        .object({ requests: z.array(z.record(z.string(), z.unknown())) })
        .parse(await api.call(REQUEST_OPEN, {}));
      const ownerRequests = open.requests.filter((entry) => entry["question"] === "ownerask.choice");
      expect(ownerRequests).toHaveLength(1);
      expect(ownerRequests[0]?.["to"]).toEqual({ kind: "owner" });

      // The test answers it through "request.answer", as the owner.
      const requestId = String(ownerRequests[0]?.["id"] ?? "");
      expect(requestId).not.toBe("");
      const accepted = z
        .object({ id: z.string(), accepted: z.boolean() })
        .parse(await api.call(REQUEST_ANSWER, { id: requestId, answer: { text: "teal" } }));
      expect(accepted.accepted).toBe(true);
      expect(accepted.id).toBe(requestId);

      // The scenario finishes: the owner answered, and the session answered the niwa way.
      await until(
        async () => {
          const records = await api!.records.read();
          return recordsOf(records, "ownerask.answered").length > 0;
        },
        DEADLINE_MS,
        "the scenario did not finish",
      );
      const elapsedMs = Date.now() - startedAt;

      const records = await api.records.read();
      const answered = must(recordsOf(records, "ownerask.answered")[0], "record of the outcome");
      const outcome = AnsweredData.parse(answered.data);
      expect(outcome.error).toBeUndefined();

      // The answer of the owner is what the test gave it.
      expect(OwnerAnswer.parse(outcome.ownerAnswer)).toEqual({ text: "teal" });

      // The answer of the session validates against the schema: it is a value, not a text.
      const sessionAnswer = SessionAnswer.parse(outcome.sessionAnswer);
      expect(sessionAnswer.answer.toLowerCase()).toContain("teal");

      // The journal tells the story: the request of the session was answered through
      // "submit-answer", and the request of the owner was answered by the owner.
      const created = recordsOf(records, "request.created").map((record) =>
        RequestCreatedData.parse(record.data),
      );
      const sessionQuestions = created.filter((entry) => entry.question === "session.answer");
      expect(sessionQuestions).toHaveLength(1);
      expect(sessionQuestions[0]?.to.kind).toBe("session");

      const answeredRecords = recordsOf(records, "request.answered");
      // Two requests ended: the one of the session and the one of the owner.
      expect(answeredRecords.length).toBeGreaterThanOrEqual(2);
      const ownerAnswered = answeredRecords.find((record) => {
        const data = record.data as { id?: string } | undefined;
        return data?.id === requestId;
      });
      expect(ownerAnswered).toBeDefined();
      // The session answered its own request.
      expect(
        answeredRecords.some((record) => {
          const data = record.data as { id?: string } | undefined;
          return data?.id === sessionQuestions[0]?.id;
        }),
      ).toBe(true);

      console.log(`live timings: the scenario finished in ${String(elapsedMs)} ms`);
      console.log(`answers: owner=${JSON.stringify(outcome.ownerAnswer)} session=${JSON.stringify(outcome.sessionAnswer)}`);
    } finally {
      await api?.close().catch(() => undefined);
      // A clean stop: the host disposes its harness children, which run in process groups of
      // their own and would outlive a SIGKILL of the host.
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  DEADLINE_MS + 300_000,
);
