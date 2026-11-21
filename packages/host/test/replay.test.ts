// Replay of a recorded key by a different call: the invocation pauses, nothing is written twice.
//
// The host runs in this process. The handler of one invocation runs twice: the first run records
// something at the key "k" and fails, the owner retries, and the second run calls something else
// at the same key. The recorded fact is not the answer to that call, so the invocation pauses with
// a replay mismatch instead of returning the old value or crashing the host.

import { expect, test } from "bun:test";

import { action, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Handler, StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Start = record("replay.start", z.object({}));
const Note = record("replay.note", z.object({ n: z.number() }));

const STATE_TYPE = "niwa.invocation.state";

/** Two actions a step may call: the same key is called with another input, or as the other one. */
const First = action("replay.first", {
  description: "does nothing",
  input: z.object({ text: z.string() }),
  output: z.object({}),
  recovery: "repeat",
  effect: "write",
  run: async () => ({}),
});
const Second = action("replay.second", {
  description: "does nothing",
  input: z.object({ text: z.string() }),
  output: z.object({}),
  recovery: "repeat",
  effect: "write",
  run: async () => ({}),
});

/** Run a handler twice (the owner retries after the first run fails); return the last state. */
async function lastStateAfterRetry(
  handler: (run: number) => Handler<{}>,
): Promise<{ state: string; reason?: string; seen: StoredRecord[] }> {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  let runs = 0;
  niwa.use(
    plugin("replay", (api) => {
      api.declare(Start, Note);
      api.action(First);
      api.action(Second);
      api.on(Start, async (data, step, rec) => {
        runs += 1;
        await handler(runs)(data, step, rec);
      });
    }),
  );
  await niwa.serve();
  const seen: StoredRecord[] = [];
  const watching = (async () => {
    for await (const rec of niwa.records.since()) seen.push(rec);
  })();
  const states = () =>
    seen
      .filter((rec) => rec.type === STATE_TYPE)
      .map((rec) => rec.data as { invocation: string; state: string; reason?: string });
  try {
    await niwa.emit(Start, {});
    await eventually(() => states().at(-1)?.state === "paused", 10_000, "the first run pauses");
    const invocation = states().at(-1)?.invocation ?? "";
    await niwa.call("niwa.invocation.resolve" as never, { invocation, choice: "retry" } as never);
    await eventually(
      () => states().filter((s) => s.state === "paused").length === 2,
      10_000,
      "the second run pauses",
    );
    return { state: states().at(-1)?.state ?? "", reason: states().at(-1)?.reason, seen };
  } finally {
    await niwa.close();
    await watching.catch(() => {});
    await home.cleanup();
  }
}

test("a clock key read by a random call pauses the invocation", async () => {
  const result = await lastStateAfterRetry((run) => async (_data, step) => {
    if (run === 1) {
      await step.now({ key: "k" });
      throw new Error("first run stops here");
    }
    await step.random({ key: "k" });
  });
  expect(result.reason).toBe("replay mismatch at step k");
});

test("an emit key written again with other content pauses the invocation", async () => {
  const result = await lastStateAfterRetry((run) => async (_data, step) => {
    if (run === 1) {
      await step.emit(Note, { n: 1 }, { key: "k" });
      throw new Error("first run stops here");
    }
    await step.emit(Note, { n: 2 }, { key: "k" });
  });
  expect(result.reason).toBe("replay mismatch at emit k");
  const notes = result.seen.filter((rec) => rec.type === Note.name);
  expect(notes.map((rec) => rec.data)).toEqual([{ n: 1 }]);
});

test("a step called with another input says which call it was and that the input changed", async () => {
  const result = await lastStateAfterRetry((run) => async (_data, step) => {
    if (run === 1) {
      await step(First, { text: "the old prompt" }, { key: "k" });
      throw new Error("first run stops here");
    }
    await step(First, { text: "the new prompt" }, { key: "k" });
  });
  expect(result.state).toBe("paused");
  expect(result.reason).toBe(
    "replay mismatch at step k: the call to replay.first was recorded with another input than the code gives it now",
  );
});

test("a step that is another action under the same key says what was recorded and what is called now", async () => {
  const result = await lastStateAfterRetry((run) => async (_data, step) => {
    if (run === 1) {
      await step(First, { text: "same" }, { key: "k" });
      throw new Error("first run stops here");
    }
    await step(Second, { text: "same" }, { key: "k" });
  });
  expect(result.state).toBe("paused");
  expect(result.reason).toBe(
    "replay mismatch at step k: it was recorded as a call to replay.first, and the code now calls replay.second",
  );
});
