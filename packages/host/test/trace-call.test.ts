// The chain of a call made outside an invocation.
//
// A call outside an invocation starts a chain of its own: the first record it writes has no
// cause and is the root of the chain. Every record after it belongs to that chain, so the
// record before it is its cause and the trace down from the first record reaches all of them.
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. an action called directly writes three records
//   2. the first record has no cause and is the root of the chain
//   3. the second record has the first as its cause, the third has the second
//   4. the trace down from the first record lists all three, in order
//   5. the causes of the third record walk back to the first one

import { expect, test } from "bun:test";

import { action, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Fact = record("trace-call.fact", z.object({ n: z.number() }));

const three = action("trace-call.three", {
  description: "Writes three records in one call.",
  input: z.object({}),
  output: z.object({ ids: z.array(z.string()) }),
  recovery: "repeat",
  effect: "write",
  run: async (_input, ctx) => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const written = await ctx.emit(Fact, { n });
      ids.push(written.id);
    }
    return { ids };
  },
});

const facts = plugin("trace-call", (api) => {
  api.declare(Fact);
  api.action(three);
});

test("a call outside an invocation: every record it writes hangs on the record before it", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(facts);
  await niwa.serve();

  try {
    // 1. The call is made directly: outside any invocation.
    const written = await niwa.call(three, {});
    const records = await niwa.records.read({ types: [Fact] });
    expect(records.map((record) => record.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const first = records[0];
    const second = records[1];
    const third = records[2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    // The ids the call returned are the ids the journal holds.
    expect(written.ids).toEqual([first!.id, second!.id, third!.id]);

    // 2. The first record starts the chain: no cause, and it is its own root.
    expect(first!.cause).toBeNull();
    expect(first!.root).toBe(first!.id);

    // 3. Every record after it has the record before it as its cause, and the root
    //    of the chain stays the first record.
    expect(second!.cause).toBe(first!.id);
    expect(second!.root).toBe(first!.id);
    expect(third!.cause).toBe(second!.id);
    expect(third!.root).toBe(first!.id);

    // 4. The trace down from the first record lists all three, in order, each once.
    const traced = await niwa.trace(first!.id);
    expect(traced.map((record) => record.id)).toEqual([first!.id, second!.id, third!.id]);
    expect(traced.map((record) => record.depth)).toEqual([0, 1, 2]);

    // 5. The causes of the third record walk back to the first one.
    const up = await niwa.causes(third!.id);
    expect(up.map((record) => record.id)).toEqual([second!.id, first!.id]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("two calls outside an invocation are two chains: the second call starts its own", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(facts);
  await niwa.serve();

  try {
    await niwa.call(three, {});
    await niwa.call(three, {});

    const records = await niwa.records.read({ types: [Fact] });
    expect(records).toHaveLength(6);

    // Each call has its own root, and the trace down from one root does not reach the
    // records of the other call.
    const firstRoot = records[0]!;
    const secondRoot = records[3]!;
    expect(firstRoot.cause).toBeNull();
    expect(secondRoot.cause).toBeNull();
    expect(secondRoot.root).toBe(secondRoot.id);
    expect(secondRoot.root).not.toBe(firstRoot.root);

    const traced = await niwa.trace(firstRoot.id);
    expect(traced.map((record) => record.id)).toEqual([
      firstRoot.id,
      records[1]!.id,
      records[2]!.id,
    ]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
