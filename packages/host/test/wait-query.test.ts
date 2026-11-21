// A wait takes the same query as a read: a type, equality on paths of the data, and a position to
// look after. It answers with the record's data and its position, so the next wait goes on from
// there and misses nothing in between.

import { expect, test } from "bun:test";

import { record, seq } from "@niwa-labs/core";
import type { Seq, StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Start = record("waitq.start", z.object({ n: z.number() }));
const Answer = record("waitq.answer", z.object({ to: z.object({ n: z.number() }), text: z.string() }));
const AnswerV2 = record("waitq.answer", z.object({ to: z.object({ n: z.number() }), text: z.string() }), { version: 2 });

test("a wait answers with the data and the position, and the next wait from that position misses nothing", async () => {
  const home = await tempHome();
  const got: Array<{ text: string; at: Seq }> = [];
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("waitq", (api) => {
      api.declare(Start, Answer);
      api.on(Start, async (data, step) => {
        const first = await step.wait(Answer, { filter: { "to.n": data.n } });
        const second = await step.wait(Answer, { filter: { "to.n": data.n }, from: first.at });
        for (const one of [first, second]) if (!got.some((seen) => seen.at === one.at)) got.push({ text: one.data.text, at: one.at });
      });
    }),
  );
  try {
    await niwa.serve();
    await niwa.emit(Start, { n: 1 });
    await eventually(async () => (await niwa.records.read(seq(0))).some((row) => row.type === "niwa.invocation.state" && (row.data as { state: string }).state === "waiting"));
    // Two answers in a row, and one for another start between them: the second wait finds the
    // second answer, which was committed before it began.
    const a = await niwa.emit(Answer, { to: { n: 1 }, text: "a" });
    await niwa.emit(Answer, { to: { n: 2 }, text: "other" });
    const b = await niwa.emit(Answer, { to: { n: 1 }, text: "b" });
    await eventually(() => got.length === 2);
    expect(got).toEqual([
      { text: "a", at: a.seq },
      { text: "b", at: b.seq },
    ]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a wait from a position is answered by a record committed after it and before the wait began", async () => {
  const home = await tempHome();
  const answers: string[] = [];
  let mark: StoredRecord | undefined;
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("waitq", (api) => {
      api.declare(Start, Answer);
      api.on(Start, async (data, step) => {
        const found = await step.wait(Answer, { filter: { "to.n": data.n }, from: mark?.seq ?? seq(0) });
        answers.push(found.data.text);
      });
    }),
  );
  try {
    await niwa.serve();
    mark = await niwa.emit(Answer, { to: { n: 9 }, text: "before the mark" });
    await niwa.emit(Answer, { to: { n: 1 }, text: "early" });
    await niwa.emit(Start, { n: 1 });
    await eventually(() => answers.length === 1);
    expect(answers).toEqual(["early"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a record of another schema version does not answer a wait, and the answer survives a restart with its position", async () => {
  const home = await tempHome();
  const seen: Array<{ text: string; at: number }> = [];
  const waiter = (types: { answer: typeof Answer | typeof AnswerV2; declare: boolean }) =>
    plugin("waitq", (api) => {
      api.declare(Start, ...(types.declare ? [types.answer] : []));
      api.on(Start, async (data, step) => {
        const found = await step.wait(Answer, { filter: { "to.n": data.n } });
        seen.push({ text: found.data.text, at: found.at });
      });
    });
  try {
    const first = createNiwa({ home: home.path });
    first.use(waiter({ answer: Answer, declare: true }));
    await first.serve();
    await first.emit(Start, { n: 1 });
    await eventually(async () => (await first.records.read(seq(0))).some((row) => row.type === "niwa.invocation.state" && (row.data as { state: string }).state === "waiting"));
    await first.close();

    const newer = createNiwa({ home: home.path });
    // The same plugin, with the type at its next version: the waiting invocation goes on on it.
    newer.use(waiter({ answer: AnswerV2, declare: true }));
    await newer.serve();
    await newer.emit(AnswerV2, { to: { n: 1 }, text: "version two" });
    await Bun.sleep(150);
    expect(seen).toEqual([]);
    await newer.close();

    const again = createNiwa({ home: home.path });
    again.use(waiter({ answer: Answer, declare: true }));
    await again.serve();
    const answer = await again.emit(Answer, { to: { n: 1 }, text: "version one" });
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([{ text: "version one", at: answer.seq }]);
    await again.close();
  } finally {
    await home.cleanup();
  }
});
