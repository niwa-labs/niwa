// A step whose value is too large for a record: the host keeps the value as an artifact, the
// record holds its reference, and a run that goes on after a wait reads the value back.

import { expect, test } from "bun:test";

import { ARTIFACT_THRESHOLD, CORE_TYPES, action, record } from "@niwa-labs/core";
import type { ArtifactRef } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Start = record("large.start", z.object({}));
const Go = record("large.go", z.object({}));
const Seen = record("large.seen", z.object({ length: z.number() }));

test("a large step value is an artifact of the host, and the step that is replayed after a wait gets it whole", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const text = "z".repeat(ARTIFACT_THRESHOLD * 2);
  let calls = 0;
  const Big = action("large.big", {
    description: "Answers with a long text.",
    input: z.object({}),
    output: z.object({ text: z.string() }),
    recovery: "do-not-repeat",
    effect: "read",
    run: async () => {
      calls += 1;
      return { text };
    },
  });
  niwa.use(
    plugin("large", (api) => {
      api.declare(Start, Go, Seen);
      api.action(Big);
      api.on(Start, async (_data, step) => {
        const got = await step(Big, {}, { key: "big" });
        await step.wait(Go);
        await step.emit(Seen, { length: got.text.length }, { key: "seen" });
      });
    }),
  );
  await niwa.serve();
  try {
    await niwa.emit(Start, {});
    await eventually(async () => (await niwa.records.read()).some((row) => row.type === CORE_TYPES.stepOutcome), 5_000, "the step should end");
    await niwa.emit(Go, {});
    await eventually(async () => (await niwa.records.read()).some((row) => row.type === Seen.name), 5_000, "the run should go on");
    const rows = await niwa.records.read();
    const outcome = (rows.find((row) => row.type === CORE_TYPES.stepOutcome)?.data as { outcome: { artifact?: ArtifactRef; value?: unknown } }).outcome;
    expect(outcome.value).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(niwa.artifacts.read(outcome.artifact!)))).toEqual({ text });
    expect(rows.find((row) => row.type === Seen.name)?.data).toEqual({ length: text.length });
    expect(calls).toBe(1);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
