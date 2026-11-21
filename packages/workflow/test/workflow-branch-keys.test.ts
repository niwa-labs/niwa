// The key of an unlabeled call says which branch it is in.
//
// A workflow cache is never keyed by call position alone: the calls of a script
// that carry no label are keyed by the branch they are in, so the branch that answers first
// does not take the place of the branch that answers later.
//
// The scenario runs against a real host process (test/fixtures/branches-host.ts):
//
//   1. the script runs two branches in parallel, each making two unlabeled calls
//   2. the second branch answers before the first: the host is killed with the first branch
//      still in flight
//   3. the host comes back and the run goes on: the calls that finished are answered from the
//      journal, and the branch that was waiting runs again
//   4. every branch keeps its own answer, and no call is made twice
//
// Only the public API is used: the entries of the packages, and of testing.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/branches-host.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/branches-script.js", import.meta.url));

/** What the workflow actions answer. */
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

/** The result the script returns: the reports of the two branches. */
const ScriptResult = z.array(z.array(z.object({ answer: z.string() })));

/** The records of one type, as the observer saw them. */
function ofType(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

/** The key of a step, as the journal holds it. */
function stepKeyOf(record: StoredRecord): string {
  return (record.data as { key?: string }).key ?? "";
}

test("the key of an unlabeled call says its branch, and a run goes on cleanly", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let first: ReturnType<typeof spawnHost> | undefined;
  let second: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    // 1. The host, and the script that runs two branches in parallel.
    first = spawnHost(HOST_SCRIPT, homePath);
    await first.ready();
    const client = await connectAsOwner(homePath);
    observer = await watch(homePath);
    const records = observer.seen;

    const started = RunOutput.parse(
      await client.call("workflow.start" as ActionName, { file: SCRIPT } as never),
    );

    await eventually(
      () => counter(homePath, "branches.agent").count() === 2,
      20_000,
      "the first call of each branch should have been made",
    );

    // 2. The second branch answers before the first: c1 and c2 are done, b1 is not.
    gate(homePath, "branches.gate.c1").open();
    gate(homePath, "branches.gate.c2").open();
    await eventually(
      () => counter(homePath, "branches.agent").count() === 3,
      20_000,
      "the second branch should have made its second call",
    );

    // The keys of the calls say which branch they are in: the two branches have their own keys.
    // The observer feed can lag behind the side-effect counter: wait for the records themselves.
    // The hold of the grant on each call is a step of its own, under `<key>~auth`: it is not a call.
    const callKeys = (): string[] =>
      ofType(records, "niwa.step.intent").map(stepKeyOf).filter((key) => !key.endsWith("~auth"));
    await eventually(() => callKeys().length >= 3, 20_000, "the observer should have seen the three step intents");
    const keys = callKeys();
    expect(keys).toHaveLength(3);
    // The two branches have keys of their own: no key belongs to both.
    expect(new Set(keys).size).toBe(3);
    expect(keys.filter((key) => key.startsWith("p1.0."))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith("p1.1."))).toHaveLength(2);

    // The host is killed in the middle: the first branch is still in flight.
    await first.kill();
    first = undefined;
    await client.close().catch(() => {});

    // 3. The host comes back and the first branch goes on: the calls that finished are answered
    //    from the journal, and the branch that was waiting runs again.
    second = spawnHost(HOST_SCRIPT, homePath);
    await second.ready();
    gate(homePath, "branches.gate.b1").open();
    gate(homePath, "branches.gate.b2").open();

    await eventually(
      () => ofType(records, "workflow.run.finished").length > 0,
      30_000,
      "the run should have finished",
    );

    // 4. Every branch kept its own answer: the second branch did not take the place of the first.
    const finished = ofType(records, "workflow.run.finished")[0];
    const result = ScriptResult.parse((finished?.data as { outcome?: { result?: unknown } }).outcome?.result);
    expect(result[0]).toEqual([
      { answer: "answered: b1" },
      { answer: "answered: b2" },
    ]);
    expect(result[1]).toEqual([
      { answer: "answered: c1" },
      { answer: "answered: c2" },
    ]);

    // The calls that finished were not repeated: c1, c2 and b2 were each made once. b1 was in
    // flight when the host was killed, so it was made again: five calls for four of them.
    expect(counter(homePath, "branches.agent").count()).toBe(5);

    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
    await home.cleanup();
  }
}, 90_000);
