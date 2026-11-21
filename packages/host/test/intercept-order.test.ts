// Intercept order.
//
// The scenario runs against a real host process (fixtures/intercept-order-host.ts):
//
//   1. spawn the host, connect a client, watch the journal from the beginning
//   2. write Start: the handler calls the action with the text "requested"
//   3. the adjust changes it to "adjusted", the guard sees "adjusted" and allows
//      it, and the action is called with "adjusted"
//   4. the journal holds the decision: the requested input and the final one
//   5. the handler calls the action with the text "forbidden": the guard refuses
//      it, the decision is recorded with the reason and with both inputs, and the
//      action is not called
//   6. the invocation pauses on the refused step, and the owner answers "retry"
//   7. on the retry the guard is asked again, and this time it allows the call:
//      the action runs with "forbidden"
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { action, deny, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { StoredRecord } from "@niwa-labs/core";
import { z } from "zod";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import {
  ADJUSTED,
  CALL_LOG,
  FORBIDDEN,
  GUARD_LOG,
  REQUESTED,
  Start,
} from "./fixtures/intercept-order-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/intercept-order-host.ts", import.meta.url));

/** The record type the core writes for what the intercepts decided. */
const DECISION_TYPE = "niwa.step.decision";

/** The record type the core writes for the intent of a step. */
const INTENT_TYPE = "niwa.step.intent";

/** The record type the core writes for the outcome of a step. */
const OUTCOME_TYPE = "niwa.step.outcome";

/** The action the owner calls to answer a paused invocation. */
const RESOLVE_ACTION = "niwa.invocation.resolve";

/** What a decision record holds. */
type DecisionData = {
  invocation: string;
  key: string;
  attempt: number;
  requested: { text: string };
  final: { text: string };
  denied: boolean;
  reason?: string;
};

/** What an outcome record holds. */
type OutcomeData = {
  invocation: string;
  key: string;
  outcome: { status: string; reason?: string };
};

/** The lines of a file the host wrote, or nothing when it wrote none. */
async function linesOf(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split("\n").filter((line) => line.trim() !== "");
}

test("intercept order: the adjust changes the input, the guard sees the changed one, the denial is recorded and the action does not run, and a retry asks the guard again", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The host, a client, and a watch on the journal from the beginning.
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);

    const seen: StoredRecord[] = [];
    const watcher = await connectAsOwner(homePath);
    const watch = (async () => {
      for await (const record of watcher.records.since()) {
        seen.push(record);
      }
    })().catch(() => {});

    const decisions = () =>
      seen
        .filter((record) => record.type === DECISION_TYPE)
        .map((record) => record.data as DecisionData);
    const outcomes = () =>
      seen
        .filter((record) => record.type === OUTCOME_TYPE)
        .map((record) => record.data as OutcomeData);
    const states = () =>
      seen
        .filter((record) => record.type === "niwa.invocation.state")
        .map((record) => record.data as { invocation: string; state: string; reason?: string });

    // 2. The handler wakes and calls the action with the text "requested".
    await client.emit(Start, {});

    // 3. The adjust changed the input, the guard saw the changed one and allowed
    //    it, and the action was called with the changed input.
    await eventually(
      async () => (await linesOf(`${homePath}/${CALL_LOG}`)).length === 1,
      10_000,
      "the action should have been called once",
    );
    const calls = await linesOf(`${homePath}/${CALL_LOG}`);
    expect(calls[0]?.startsWith(`${ADJUSTED}:`)).toBe(true);

    // The guard was asked for the first step, and it saw the adjusted input, not
    // the requested one.
    const guards = await linesOf(`${homePath}/${GUARD_LOG}`);
    expect(guards.length).toBeGreaterThanOrEqual(1);
    expect(guards[0]?.startsWith(`${ADJUSTED}:`)).toBe(true);
    expect(guards[0]).not.toContain(REQUESTED);

    // 4. The decision is recorded with both inputs: the requested one and the
    //    final one.
    await eventually(() => decisions().length >= 1, 10_000, "the decision should be recorded");
    const first = decisions()[0] as DecisionData;
    expect(first.requested).toEqual({ text: REQUESTED });
    expect(first.final).toEqual({ text: ADJUSTED });
    expect(first.denied).toBe(false);
    expect(first.reason).toBeUndefined();

    // 5. The handler calls the action with the text "forbidden": the guard refuses
    //    it, and the action is not called.
    await eventually(
      () => decisions().length >= 2,
      10_000,
      "the second decision should be recorded",
    );
    const denied = decisions().find((decision) => decision.denied);
    expect(denied).toBeDefined();
    expect(denied?.requested).toEqual({ text: FORBIDDEN });
    expect(denied?.final).toEqual({ text: FORBIDDEN });
    expect(denied?.reason).toBe("not tonight");

    // The action was not called for the refused text.
    const afterDenial = await linesOf(`${homePath}/${CALL_LOG}`);
    expect(afterDenial.filter((line) => line.startsWith(`${FORBIDDEN}:`))).toHaveLength(0);

    // The order of the records: the decision comes before the intent, the intent holds the final
    // input, and the outcome comes last.
    const at = (type: string, text: string) =>
      seen.find(
        (record) =>
          record.type === type &&
          (record.data as { requested?: { text: string }; input?: { text: string } })[
            type === DECISION_TYPE ? "requested" : "input"
          ]?.text === text,
      );
    const deniedDecision = at(DECISION_TYPE, FORBIDDEN);
    const deniedIntent = at(INTENT_TYPE, FORBIDDEN);
    expect(deniedDecision).toBeDefined();
    expect(deniedIntent).toBeDefined();
    expect((deniedDecision?.seq ?? 0) < (deniedIntent?.seq ?? 0)).toBe(true);
    const adjustedIntent = seen.find(
      (record) =>
        record.type === INTENT_TYPE && (record.data as { input: { text: string } }).input.text === ADJUSTED,
    );
    expect(adjustedIntent).toBeDefined();
    expect((at(DECISION_TYPE, REQUESTED)?.seq ?? 0) < (adjustedIntent?.seq ?? 0)).toBe(true);

    // The step ended as denied, with the reason of the guard.
    await eventually(
      () => outcomes().some((outcome) => outcome.outcome.status === "denied"),
      10_000,
      "the refused step should have ended as denied",
    );
    const deniedOutcome = outcomes().find((outcome) => outcome.outcome.status === "denied");
    expect(deniedOutcome?.outcome.reason).toBe("not tonight");

    // 6. The invocation paused on the refused step, and the owner answers "retry".
    await eventually(
      () => states().some((state) => state.state === "paused"),
      10_000,
      "the invocation should have paused",
    );
    const invocation = states().find((state) => state.state === "paused")?.invocation ?? "";
    expect(invocation).not.toBe("");

    await client.call(RESOLVE_ACTION as never, {
      invocation,
      choice: "retry",
    } as never);

    // 7. On the retry the guard was asked again, and this time it allowed the call:
    //    the action ran with "forbidden".
    await eventually(
      async () =>
        (await linesOf(`${homePath}/${CALL_LOG}`)).filter((line) =>
          line.startsWith(`${FORBIDDEN}:`),
        ).length === 1,
      10_000,
      "the action should have been called after the retry",
    );
    const guardsAfter = await linesOf(`${homePath}/${GUARD_LOG}`);
    expect(guardsAfter.filter((line) => line.startsWith(`${FORBIDDEN}:`)).length).toBe(2);

    // The retry is a new attempt, and it has its own decision: the first one denied
    // it, the second one allowed it.
    const attempts = decisions()
      .filter((decision) => decision.requested.text === FORBIDDEN)
      .map((decision) => decision.attempt);
    expect(attempts).toEqual([0, 1]);
    const allowed = decisions().find(
      (decision) => decision.requested.text === FORBIDDEN && !decision.denied,
    );
    expect(allowed?.final).toEqual({ text: FORBIDDEN });

    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("intercept cycle: an intercept that calls its own action is refused, and a denied outside call does not run", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  let ran = 0;
  const Ping = action("c11cycle.ping", {
    description: "Counts its runs.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    recovery: "repeat",
    run: (input) => {
      ran += 1;
      return input;
    },
  });
  let inner: unknown;
  host.use(
    plugin("c11cycle", (api) => {
      api.action(Ping);
      api.adjust(Ping, async (input) => {
        inner = await host.call(Ping, { n: input.n }).catch((error: unknown) => error);
        return undefined;
      });
      api.guard(Ping, (input) => (input.n === 0 ? deny("zero") : undefined));
    }),
  );
  await host.serve();
  try {
    // The adjust calls the action it is registered on: the inner call is refused, not looped.
    await expect(host.call(Ping, { n: 1 })).resolves.toEqual({ n: 1 });
    expect((inner as { code?: string }).code).toBe("Denied");
    expect((inner as Error).message).toContain("intercept cycle");
    expect(ran).toBe(1);

    // A guard's denial of an outside call: the error says why and the action did not run.
    await expect(host.call(Ping, { n: 0 })).rejects.toMatchObject({ code: "Denied", reason: "zero" });
    expect(ran).toBe(1);
  } finally {
    await host.close();
    await home.cleanup();
  }
});
