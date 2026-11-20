// The rules of the host that no scenario check covers directly: who may write what, who a client
// is, that a waiting invocation holds nobody back, and that only a paused one can be answered.

import { expect, test } from "bun:test";

import { action, principalOf, record, seq, UnknownType } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Caller, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Job = record("host.job", z.object({ n: z.number(), wait: z.boolean() }));
const Gate = record("host.gate", z.object({}));
const Seen = record("host.seen", z.object({ n: z.number() }));

const whoami = action("host.whoami", {
  description: "Returns the caller the host bound to this call.",
  input: z.object({}),
  output: z.object({ caller: z.string() }),
  recovery: "repeat",
  run: async (_input, ctx) => ({ caller: callerName(ctx.caller) }),
});

function callerName(caller: Caller): string {
  return caller.kind === "client" ? caller.id : caller.kind;
}

const jobs = plugin("host-rules", (api) => {
  api.declare(Job, Gate, Seen);
  api.action(whoami);
  api.on(Job, async (job, step) => {
    if (job.wait) await step.wait(Gate, () => true);
    await step.emit(Seen, { n: job.n });
  });
});

async function withHost(run: (host: Host, home: string) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(jobs);
  await host.serve();
  try {
    await run(host, home.path);
  } finally {
    await host.close();
    await home.cleanup();
  }
}

async function collect(host: Host, kind: string, count: number): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  for await (const rec of host.records.since(seq(0))) {
    if (rec.type === kind) found.push(rec);
    if (found.length === count) break;
  }
  return found;
}

test("the host refuses to write a type of the core: only the core writes those", async () => {
  await withHost(async (host) => {
    const forged = record("niwa.invocation.state", z.unknown());
    await expect(host.emit(forged, { invocation: "x", state: "done" })).rejects.toBeInstanceOf(
      UnknownType,
    );
  });
});

test("a client is named by the host: two clients with one label are two callers", async () => {
  await withHost(async (host, home) => {
    // A client the host issued a token with no grant: nothing limits it, and its label is only a name.
    const plain = host.issueToken(principalOf("client", "same"));
    const a = await connect({ home, id: "same", token: plain });
    const b = await connect({ home, id: "same", token: plain });
    const first = await a.call(whoami, {});
    const second = await b.call(whoami, {});
    expect(first.caller).toStartWith("same#");
    expect(second.caller).toStartWith("same#");
    expect(second.caller).not.toBe(first.caller);
    await a.close();
    await b.close();
  });
});

test("a waiting invocation holds nobody back, and its answer wakes it", async () => {
  await withHost(async (host) => {
    await host.emit(Job, { n: 1, wait: true });
    await host.emit(Job, { n: 2, wait: false });
    const early = await collect(host, "host.seen", 1);
    expect(early.map((rec) => rec.data)).toEqual([{ n: 2 }]);
    await host.emit(Gate, {});
    const all = await collect(host, "host.seen", 2);
    expect(all.map((rec) => rec.data)).toEqual([{ n: 2 }, { n: 1 }]);
  });
});

test("only a paused invocation can be answered", async () => {
  await withHost(async (host) => {
    const job = await host.emit(Job, { n: 1, wait: false });
    await eventually(async () => (await collect(host, "host.seen", 1)).length === 1, 5000, "done");
    const admitted = (await host.trace(job.id)).find((rec) => rec.type === "niwa.invocation.admitted");
    expect(admitted).toBeDefined();
    await expect(
      host.call("niwa.invocation.resolve" as never, {
        invocation: admitted?.id,
        choice: "cancel",
      } as never),
    ).rejects.toThrow("is not paused");
  });
});
