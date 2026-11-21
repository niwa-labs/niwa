// The owner cancels the steps of an invocation under some keys: the call that is in flight is
// aborted, a waiting invocation runs again so its wait ends, and the rest of the handler goes on.

import { expect, test } from "bun:test";

import { z } from "zod";

import { CANCEL_STEPS_ACTION, StepCancelled, action, record } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";

const Start = record("cancel.start", z.object({}));
const Never = record("cancel.never", z.object({ id: z.string() }));

test("cancelled steps end as cancelled: the call in flight is aborted and the wait of a waiting invocation ends", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const ended: string[] = [];
  let aborted = false;
  niwa.use(
    plugin("cancel", (api) => {
      api.declare(Start, Never);
      api.action(
        action("cancel.long", {
          description: "runs until it is aborted",
          input: z.object({}),
          output: z.object({}),
          recovery: "do-not-repeat",
          run: (_input, ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        }),
      );
      api.on(Start, async (_data, step) => {
        const branch = async (name: string, body: () => Promise<unknown>): Promise<void> => {
          try {
            await body();
            ended.push(`${name}: done`);
          } catch (error) {
            if (!(error instanceof StepCancelled)) throw error;
            ended.push(`${name}: ${error.reason}`);
          }
        };
        await Promise.all([
          branch("long", () => step("cancel.long" as ActionName, {}, { key: "a.call-1" })),
          branch("wait", () => step.wait(Never, { key: "b.wait", filter: { id: "x" } })),
        ]);
        await step.emit(Never, { id: "after" }, { key: "after" });
      });
    }),
  );
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const stored of niwa.records.since()) records.push(stored);
  })();
  try {
    await niwa.emit(Start, {});
    const invocation = () =>
      (records.find((row) => row.type === "niwa.invocation.admitted" && (row.data as { handler: string }).handler.startsWith("cancel/"))?.data as
        | { invocation: string }
        | undefined)?.invocation;
    const states = () =>
      records.filter((row) => row.type === "niwa.invocation.state").map((row) => (row.data as { state: string }).state);
    await eventually(() => states().includes("waiting"), 10_000, "the invocation should wait");
    const id = invocation();
    expect(id).toBeDefined();

    await niwa.call(CANCEL_STEPS_ACTION, { invocation: id, prefixes: ["a", "b"], reason: "stopped by the owner" } as never);
    await eventually(() => states().at(-1) === "done", 10_000, "the invocation should end");
    expect(aborted).toBe(true);
    expect([...new Set(ended)].sort()).toEqual(["long: stopped by the owner", "wait: stopped by the owner"]);
    expect(records.some((row) => row.type === "cancel.never" && (row.data as { id: string }).id === "after")).toBe(true);
    const outcomes = records
      .filter((row) => row.type === "niwa.step.outcome")
      .map((row) => row.data as { key: string; outcome: { status: string } })
      .filter((row) => row.key === "a.call-1" || row.key === "b.wait")
      .map((row) => row.outcome.status);
    expect(outcomes).toEqual(["cancelled", "cancelled"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);

test("an invocation whose steps are cancelled while it runs runs again when it ends waiting on one of them", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ends: string[] = [];
  niwa.use(
    plugin("cancel", (api) => {
      api.declare(Start, Never);
      api.action(
        action("cancel.slow", {
          description: "answers when the test releases it",
          input: z.object({}),
          output: z.object({}),
          recovery: "repeat",
          run: async () => {
            await released;
            return {};
          },
        }),
      );
      api.on(Start, async (_data, step) => {
        // The wait suspends at once, and the handler goes on with its slow step before it gives the suspend back.
        const waited = step.wait(Never, { key: "b.wait", filter: { id: "x" } }).then(
          () => "answered",
          (error: unknown) => error,
        );
        await step("cancel.slow" as ActionName, {}, { key: "slow" });
        const outcome = await waited;
        if (outcome instanceof StepCancelled) {
          ends.push(outcome.reason);
          return;
        }
        throw outcome;
      });
    }),
  );
  await niwa.serve();
  const records: StoredRecord[] = [];
  void (async () => {
    for await (const stored of niwa.records.since()) records.push(stored);
  })();
  try {
    await niwa.emit(Start, {});
    await eventually(() => records.some((row) => row.type === "niwa.step.intent" && (row.data as { key: string }).key === "b.wait"), 10_000, "the wait should begin");
    const invocation = (records.find((row) => row.type === "niwa.invocation.admitted")?.data as { invocation: string }).invocation;
    await niwa.call(CANCEL_STEPS_ACTION, { invocation, prefixes: ["b"], reason: "given up" } as never);
    release();
    await eventually(() => ends.length > 0, 10_000, "the invocation should run again and meet the cancel");
    expect(ends).toEqual(["given up"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}, 30_000);
