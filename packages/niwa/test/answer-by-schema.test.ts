// An answer by schema.
//
// The check asks a real session for a value that passed a schema:
//
//   1. on a kind whose control side has structured output: the harness answers by itself, and
//      the value comes back;
//   2. on a kind whose control side does not: the question is a request, it waits for an
//      answer, and the answer comes back through "submit-answer".
//
// Then the other half of the check: a schema the model cannot satisfy is not returned as a
// value. The ask fails, and the failure is typed.
//
// The models are the ones the task names: codex on luna, mcode on MiniMax-M3.1-Flash.
//
// The check is skipped unless NIWA_LIVE=1 and the "codex" and "mcode" binaries are on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = new URL("./fixtures/schema-host.ts", import.meta.url).pathname;

/** The installation whose control side answers by itself. */
const CODEX_HARNESS = "codex-test";

/** The installation that is asked the niwa way. */
const MCODE_HARNESS = "mcode-test";

/** The model the codex sessions run on. */
const CODEX_MODEL = "gpt-6-luna";

/** The model the MiniMax Code sessions run on. */
const MCODE_MODEL = "minimax/MiniMax-M3.1-Flash";

/** How long one ask may take before the check gives up on it. */
const ASK_DEADLINE_MS = 300_000;

/** The record that says what an ask came back with. */
const ANSWERED = "schema.answered";

/** The type of a record, as a plain string. */
function typeOf(record_: StoredRecord): string {
  return String(record_.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((entry) => typeOf(entry) === type);
}

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/** What an ask came back with: the value, or the failure that says it did not pass. */
const Answer = z.looseObject({
  session: z.string(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});

/** Wait until the answer of an ask is in the journal. */
async function untilAnswered(
  api: Awaited<ReturnType<typeof connect>>,
  session: string,
  deadlineMs: number,
): Promise<z.infer<typeof Answer>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const records = await api.records.read();
    const answered = recordsOf(records, ANSWERED).find((entry) => {
      const parsed = Answer.safeParse(entry.data);
      return parsed.success && parsed.data.session === session;
    });
    if (answered !== undefined) return Answer.parse(answered.data);
    if (Date.now() >= until) {
      throw new Error(`the session "${session}" answered nothing within ${String(deadlineMs)} ms`);
    }
    await Bun.sleep(250);
  }
}

/** How many invocation states in the journal say "paused". */
function pausedCount(records: readonly StoredRecord[]): number {
  return recordsOf(records, "niwa.invocation.state").filter(
    (entry) => (entry.data as { state?: string } | undefined)?.state === "paused",
  ).length;
}

/**
 * Wait until the ask has an outcome: an answer, or an invocation that paused because the ask
 * failed. A pause is the typed failure of an ask that did not pass its schema; it is reported
 * as an error here, with the reason the pause gave.
 */
async function untilAnsweredOrPaused(
  api: Awaited<ReturnType<typeof connect>>,
  session: string,
  pausedBefore: number,
  deadlineMs: number,
): Promise<z.infer<typeof Answer>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const records = await api.records.read();
    const answered = recordsOf(records, ANSWERED).find((entry) => {
      const parsed = Answer.safeParse(entry.data);
      return parsed.success && parsed.data.session === session;
    });
    if (answered !== undefined) return Answer.parse(answered.data);
    if (pausedCount(records) > pausedBefore) {
      const reasons = recordsOf(records, "niwa.invocation.state")
        .filter((entry) => (entry.data as { state?: string } | undefined)?.state === "paused")
        .map((entry) => JSON.stringify(entry.data));
      return { session, error: `paused: ${reasons.at(-1) ?? ""}` };
    }
    if (Date.now() >= until) throw new Error(`the ask of "${session}" had no outcome within ${String(deadlineMs)} ms`);
    await Bun.sleep(250);
  }
}

/** Start a session of an installation and ask it. */
async function askOf(
  api: Awaited<ReturnType<typeof connect>>,
  harness: string,
  model: string,
  schema: "valid" | "impossible",
  cwd: string,
  pausedBefore?: number,
): Promise<{ session: string; answer: z.infer<typeof Answer>; elapsedMs: number }> {
  const startedAt = Date.now();
  const started = (await api.call(actionName("session.start"), {
    harness,
    prompt: "Reply with the single word ok.",
    model,
    // An empty directory: the model has nothing of this repository to wander through.
    cwd,
    // A session that may see no niwa action is given no MCP server, so it could not answer.
    ...(harness === MCODE_HARNESS ? { visible: { actions: ["submit-answer"] } } : {}),
  })) as { session: string; ref: string };
  expect(started.session).toMatch(/^s-/);

  // The ask runs inside the invocation of the action, so the wait for the answer can last.
  await api.call(actionName("schema.ask"), { session: started.session, schema });
  const answer =
    pausedBefore === undefined
      ? await untilAnswered(api, started.ref, ASK_DEADLINE_MS)
      : await untilAnsweredOrPaused(api, started.ref, pausedBefore, ASK_DEADLINE_MS);
  return { session: started.ref, answer, elapsedMs: Date.now() - startedAt };
}

test.skipIf(!(live && Bun.which("codex") && Bun.which("mcode")))(
  "an answer by schema: a native answer comes back as a value, and a schema the model cannot satisfy does not",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      // The kind that answers by itself: the value comes back, and it passed the schema.
      const native = await askOf(api, CODEX_HARNESS, CODEX_MODEL, "valid", home.path);
      expect(native.answer.error).toBeUndefined();
      expect(native.answer.value).toEqual({ answer: 42 });

      // A schema no answer can satisfy: the ask fails, and it does not come back as a value.
      // A failed step pauses the invocation that asked, so the failure is a paused invocation.
      const pausedBefore = pausedCount(await api.records.read());
      const refused = await askOf(api, CODEX_HARNESS, CODEX_MODEL, "impossible", home.path, pausedBefore);
      expect(refused.answer.value).toBeUndefined();
      expect(refused.answer.error).toBeDefined();

      console.log(
        `live timings: native answer ${String(native.elapsedMs)} ms, ` +
          `impossible schema ${String(refused.elapsedMs)} ms`,
      );
      console.log(`native answer: ${JSON.stringify(native.answer.value)}`);
      console.log(`impossible answer refused: ${refused.answer.error ?? ""}`);
    } finally {
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
      // Nothing outlives the host: the MCP server the session was given is stopped with it.
      await Bun.sleep(1_000);
      const left = Bun.spawnSync(["pgrep", "-f", `niwa.ts --home ${home.path} mcp`]);
      expect(left.stdout.toString().trim()).toBe("");
    }
  },
  ASK_DEADLINE_MS * 2 + 120_000,
);

test.skipIf(!(live && Bun.which("mcode")))(
  "the non-native way: the session is asked, answers through submit-answer, and an invalid answer is not a value",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);
      const client = api;

      // A valid schema: the question reaches the session, the session answers by calling
      // "submit-answer", and the ask comes back with a value that passed the schema.
      const startedAt = Date.now();
      const valid = await askOf(client, MCODE_HARNESS, MCODE_MODEL, "valid", home.path);
      expect(valid.answer.error).toBeUndefined();
      const value = z.object({ answer: z.number().int() }).parse(valid.answer.value);
      expect(value.answer).toBe(42);

      const records = await client.records.read();
      const created = must(
        recordsOf(records, "request.created").find((entry) => {
          const data = entry.data as { to?: { kind?: string; harness?: string } } | undefined;
          return data?.to?.kind === "session" && data.to.harness === MCODE_HARNESS;
        }),
        "the record of the request the session was asked",
      );
      const requestId = (created.data as { id: string }).id;
      expect((created.data as { question: string }).question).toBe("session.answer");

      // The session received the question: niwa sent it a message that names the request and
      // says to answer with submit-answer.
      const delivered = recordsOf(records, "niwa.step.intent").filter((entry) => {
        const data = entry.data as { action?: string; input?: { message?: string } };
        const message = data.input?.message ?? "";
        return data.action === "session.send" && message.includes(requestId) && message.includes("submit-answer");
      });
      expect(delivered.length).toBeGreaterThan(0);

      // And the request was answered, by the session, not by the owner.
      expect(recordsOf(records, "request.answered").some((entry) => JSON.stringify(entry.data).includes(requestId))).toBe(
        true,
      );

      // A schema nothing satisfies: whatever the session submits is refused, so the request
      // stays open and the ask never comes back as a value.
      const stuck = client.call(actionName("session.start"), {
        harness: MCODE_HARNESS,
        prompt: "Reply with the single word ok.",
        model: MCODE_MODEL,
        cwd: home.path,
        visible: { actions: ["submit-answer"] },
      }) as Promise<{ session: string; ref: string }>;
      const second = await stuck;
      void client.call(actionName("schema.ask"), { session: second.session, schema: "impossible" }).catch(() => undefined);
      await Bun.sleep(90_000);
      const after = await client.records.read();
      const answers = recordsOf(after, ANSWERED).filter((entry) => {
        const parsed = Answer.safeParse(entry.data);
        return parsed.success && parsed.data.session === second.ref;
      });
      for (const entry of answers) {
        expect(Answer.parse(entry.data).value).toBeUndefined();
      }
      // The address of a session carries the harness's own id, the last word of its reference.
      const nativeId = second.ref.split(" ").at(-1) ?? second.ref;
      const secondRequests = recordsOf(after, "request.created").filter(
        (entry) => entry !== created && JSON.stringify(entry.data).includes(nativeId),
      );
      expect(secondRequests.length).toBeGreaterThan(0);
      for (const entry of secondRequests) {
        const id = (entry.data as { id: string }).id;
        expect(
          recordsOf(after, "request.answered").some((answered) => JSON.stringify(answered.data).includes(id)),
        ).toBe(false);
      }

      console.log(
        `non-native: request ${requestId} answered through submit-answer ${JSON.stringify(value)} ` +
          `in ${String(valid.elapsedMs)} ms (total ${String(Date.now() - startedAt)} ms); ` +
          `impossible schema: ${String(answers.length)} answers, none a value, ${String(secondRequests.length)} open request(s)`,
      );
    } finally {
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
      // Nothing outlives the host: the MCP server the session was given is stopped with it.
      await Bun.sleep(1_000);
      const left = Bun.spawnSync(["pgrep", "-f", `niwa.ts --home ${home.path} mcp`]);
      expect(left.stdout.toString().trim()).toBe("");
    }
  },
  ASK_DEADLINE_MS * 2 + 200_000,
);
