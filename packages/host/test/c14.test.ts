// Check C14 — "Shadow run".
//
// "An unchanged handler over recorded records: everything matched.
// A handler that words a message differently: reported as differed. A handler that makes a new
// call to the outside: that branch is reported as not evaluated. In all three, no effect reached
// the outside."
//
// And the rules of the shadow run, each with its own check below: the journal is
// read as it was at the position; a recorded result is reused only for the same action and the
// same final input; a simulator turns "not evaluated" into "simulated"; the shadow's writes
// (records and plugin state) reach neither the journal nor the host.
//
// Runs against a real host process (fixtures/c14-host.ts); the shadow is asked for through
// the core action "niwa.shadow", the way any client would.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { SHADOW_ACTION } from "@niwa-labs/host";
import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Said, Task } from "./fixtures/c14-host.ts";
import type { Version } from "./fixtures/c14-host.ts";

const Step = z.object({
  invocation: z.string(),
  key: z.string(),
  kind: z.enum(["step", "emit"]),
  status: z.enum(["matched", "differed", "simulated", "not-evaluated"]),
  recorded: z.object({ action: z.string(), input: z.unknown(), outcome: z.unknown() }).optional(),
  attempted: z.object({ action: z.string(), input: z.unknown() }).optional(),
  newOutcome: z.unknown().optional(),
});
const Report = z.object({
  matched: z.array(Step),
  differed: z.array(Step),
  notEvaluated: z.array(Step),
});

const CHANGED_TYPE = "niwa.state.changed";
const PEEK = actionName("peek");

type Client = Awaited<ReturnType<typeof connect>>;

async function shadow(client: Client, version: Version, range: { from?: number; to?: number } = {}) {
  return Report.parse(await client.call(SHADOW_ACTION, { plugin: "c14", version, ...range }));
}

test("C14 shadow run: matched, differed, not evaluated, simulated; as of the position; nothing written", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(new URL("./fixtures/c14-host.ts", import.meta.url).pathname, home.path);
    await host.ready();
    const client = await connectAsOwner(home.path);
    const journal = await watch(home.path);
    const said = () => journal.seen.filter((r) => r.type === Said.name);

    const task = await client.emit(Task, { title: "write the report" });
    await eventually(() => said().length === 1, 15_000, "the handler should have written its message");
    expect((said()[0]?.data as { text: string }).text).toBe("done: write the report");

    const calls = counter(home.path, "say").count();
    expect(calls).toBe(1);
    const sent = ["done: write the report"];
    expect(await client.call(PEEK, {})).toEqual(sent);
    const size = journal.seen.length;

    // An unchanged handler: both the call and the record it writes match, and nothing else.
    const same = await shadow(client, "original");
    expect(same.differed).toEqual([]);
    expect(same.notEvaluated).toEqual([]);
    expect(same.matched.map((s) => [s.kind, s.status])).toEqual([
      ["step", "matched"],
      ["emit", "matched"],
    ]);

    // The same call with a requested input that only differs before the schema is applied: the
    // final input is the recorded one, so the recorded answer is reused.
    const padded = await shadow(client, "padded");
    expect(padded.differed).toEqual([]);
    expect(padded.notEvaluated).toEqual([]);
    expect(padded.matched.length).toBe(2);
    // The final input is the adjusted one, and it is what the recorded intent holds.
    expect(padded.matched[0]?.attempted?.input).toEqual({ text: "write the report!" });
    expect(padded.matched[0]?.recorded?.input).toEqual({ text: "write the report!" });

    // A handler that words the message differently: the call is the recorded one, the record it
    // writes is another one.
    const reworded = await shadow(client, "reworded");
    expect(reworded.notEvaluated).toEqual([]);
    expect(reworded.matched.map((s) => s.kind)).toEqual(["step"]);
    expect(reworded.differed.length).toBe(1);
    const differ = reworded.differed[0];
    expect(differ?.kind).toBe("emit");
    expect(differ?.status).toBe("differed");
    expect((differ?.recorded?.input as { text: string }).text).toBe("done: write the report");
    expect((differ?.attempted?.input as { text: string }).text).toBe("finished: write the report");

    // A new call to the outside has no recorded answer: not evaluated, and the branch stops.
    const extra = await shadow(client, "extra");
    expect(extra.differed).toEqual([]);
    expect(extra.matched.map((s) => s.attempted?.action)).toEqual(["say"]);
    expect(extra.notEvaluated.length).toBe(1);
    expect(extra.notEvaluated[0]?.status).toBe("not-evaluated");
    expect(extra.notEvaluated[0]?.attempted?.action).toBe("notify");
    expect(extra.notEvaluated[0]?.recorded).toBeUndefined();

    // With a simulator the same call is simulated, and the branch goes on to the record it writes.
    const simulated = await shadow(client, "simulated");
    expect(simulated.differed).toEqual([]);
    expect(simulated.notEvaluated.length).toBe(1);
    expect(simulated.notEvaluated[0]?.status).toBe("simulated");
    expect(simulated.notEvaluated[0]?.newOutcome).toEqual({
      status: "completed",
      value: { told: "simulated: write the report" },
    });
    expect(simulated.matched.map((s) => s.kind)).toEqual(["step", "emit"]);

    // The journal as it was at the position: up to the record that woke the handler nothing had
    // been answered yet, so even the unchanged handler has no recorded answer for its call.
    const early = await shadow(client, "original", { to: task.seq });
    expect(early.matched).toEqual([]);
    expect(early.notEvaluated.map((s) => s.attempted?.action)).toEqual(["say"]);
    expect(early.notEvaluated[0]?.recorded).toBeUndefined();

    // A run that starts after the record that woke the handler has nothing to run.
    expect((await shadow(client, "original", { from: task.seq })).matched).toEqual([]);

    // No effect reached the outside, the journal did not grow, and the state is as it was.
    expect(counter(home.path, "say").count()).toBe(calls);
    expect(counter(home.path, "notify").count()).toBe(0);
    await Bun.sleep(300);
    expect(journal.seen.length).toBe(size);
    expect(journal.seen.filter((r) => r.type === CHANGED_TYPE).length).toBe(1);
    expect(await client.call(PEEK, {})).toEqual(sent);

    // Records committed after the position are not seen: a second task does not enter a run that
    // ends before it, and does enter one that does not.
    const mark = journal.seen[journal.seen.length - 1]?.seq ?? task.seq;
    await client.emit(Task, { title: "second" });
    await eventually(() => said().length === 2, 15_000, "the second task should be handled");
    expect((await shadow(client, "original", { to: mark })).matched.length).toBe(2);
    expect((await shadow(client, "original")).matched.length).toBe(4);

    await client.close().catch(() => {});
    await journal.stop();
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);
