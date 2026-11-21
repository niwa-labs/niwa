// A client that asks again after a broken connection names the call with an operation id: the same
// id with the same body answers what the first call answered, another body under it is a conflict,
// and a call that may have done something is not made a second time.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { CORE_TYPES, action, actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { InputNotSent, harnessId } from "@niwa-labs/harness";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { plugin, tempHome } from "@niwa-labs/testing";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const COUNT = actionName("counter.add");
const FAIL = actionName("counter.fail");
const SLOW = actionName("counter.slow");
const TRY = actionName("counter.try");

function counter() {
  const seen = { added: 0, failed: 0, slow: 0, tried: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const made = plugin("counter", (api) => {
    api.action(action(COUNT, {
      description: "Adds to a counter outside niwa.",
      input: z.object({ by: z.number() }),
      output: z.object({ total: z.number(), operation: z.string() }),
      recovery: "do-not-repeat",
      effect: "write",
      world: "external",
      run: (input, ctx) => {
        seen.added += input.by;
        return { total: seen.added, operation: ctx.operationId };
      },
    }));
    api.action(action(FAIL, {
      description: "Fails after it may have done something.",
      input: z.object({}),
      output: z.null(),
      recovery: "do-not-repeat",
      effect: "write",
      world: "external",
      run: () => {
        seen.failed += 1;
        throw new Error("the line dropped after the write");
      },
    }));
    api.action(action(TRY, {
      description: "Fails the first time and says it did nothing.",
      input: z.object({}),
      output: z.literal("done"),
      recovery: "do-not-repeat",
      effect: "write",
      world: "external",
      run: () => {
        seen.tried += 1;
        if (seen.tried === 1) throw new InputNotSent(harnessId("fake"), "send", "the process was not running");
        return "done" as const;
      },
    }));
    api.action(action(SLOW, {
      description: "Waits to be released.",
      input: z.object({}),
      output: z.number(),
      recovery: "do-not-repeat",
      effect: "write",
      world: "external",
      run: async () => {
        seen.slow += 1;
        await gate;
        return seen.slow;
      },
    }));
  });
  return { made, seen, release: () => release() };
}

async function as(host: Host, home: string, who: string): Promise<NiwaApi> {
  const token = host.issueToken(principalOf("session", who), { grant: grant(["counter.*"]) });
  const client = await connect({ home, id: `session:${who}`, token });
  clients.push(client);
  return client;
}

async function served(made: ReturnType<typeof counter>["made"]) {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(made);
  await host.serve();
  hosts.push(host);
  const client = await as(host, home.path, "cli");
  return { host, client, home: home.path };
}

test("the same operation with the same body answers the first call and runs it once", async () => {
  const { made, seen } = counter();
  const { host, client } = await served(made);
  const first = await client.call(COUNT, { by: 2 }, { operation: "op-1" });
  const again = await client.call(COUNT, { by: 2 }, { operation: "op-1" });
  expect(again).toEqual(first);
  expect(seen.added).toBe(2);
  // The answer is kept whole in the journal.
  const settled = (await host.records.read()).filter((row) => row.type === CORE_TYPES.callSettled);
  expect(settled).toHaveLength(1);
  expect(settled[0]?.data).toMatchObject({ action: "counter.add", outcome: { status: "completed", value: first } });
  // Without an operation every call is its own.
  await client.call(COUNT, { by: 2 });
  expect(seen.added).toBe(4);
});

test("another body under an operation already used is a conflict", async () => {
  const { made, seen } = counter();
  const { client } = await served(made);
  await client.call(COUNT, { by: 1 }, { operation: "op-1" });
  await expect(client.call(COUNT, { by: 5 }, { operation: "op-1" })).rejects.toMatchObject({ code: "operation-conflict" });
  expect(seen.added).toBe(1);
});

test("an operation is the caller's own: another client under the same id is another call", async () => {
  const { made, seen } = counter();
  const { host, client, home } = await served(made);
  const other = await as(host, home, "other");
  const mine = (await client.call(COUNT, { by: 1 }, { operation: "op-1" })) as { operation: string };
  const theirs = (await other.call(COUNT, { by: 1 }, { operation: "op-1" })) as { operation: string };
  expect(seen.added).toBe(2);
  expect(theirs.operation).not.toBe(mine.operation);
});

test("a retry while the first call still runs waits for it instead of running again", async () => {
  const { made, seen, release } = counter();
  const { client } = await served(made);
  const first = client.call(SLOW, {}, { operation: "op-1" });
  for (let waited = 0; seen.slow === 0 && waited < 5_000; waited += 10) await Bun.sleep(10);
  const second = client.call(SLOW, {}, { operation: "op-1" });
  release();
  expect(await Promise.all([first, second])).toEqual([1, 1]);
  expect(seen.slow).toBe(1);
});

test("a failure that may have done something is answered again; one that did nothing runs again", async () => {
  const { made, seen } = counter();
  const { client } = await served(made);
  await expect(client.call(FAIL, {}, { operation: "op-f" })).rejects.toThrow("the line dropped");
  await expect(client.call(FAIL, {}, { operation: "op-f" })).rejects.toThrow("the line dropped");
  expect(seen.failed).toBe(1);

  await expect(client.call(TRY, {}, { operation: "op-t" })).rejects.toMatchObject({ code: "InputNotSent" });
  expect(await client.call(TRY, {}, { operation: "op-t" })).toBe("done");
  expect(seen.tried).toBe(2);
});

test("a call that was cut off before it ended is not made again under its operation", async () => {
  const { made, seen } = counter();
  const { host, client, home } = await served(made);
  void client.call(SLOW, {}, { operation: "op-1" }).catch(() => undefined);
  for (let waited = 0; seen.slow === 0 && waited < 5_000; waited += 10) await Bun.sleep(10);
  await client.close();
  await host.close();

  const next = counter();
  const again = createNiwa({ home });
  again.use(next.made);
  await again.serve();
  hosts.push(again);
  const retry = await as(again, home, "cli");
  await expect(retry.call(SLOW, {}, { operation: "op-1" })).rejects.toMatchObject({ code: "operation-unknown" });
  expect(next.seen.slow).toBe(0);
});
