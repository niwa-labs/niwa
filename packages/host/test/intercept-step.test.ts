// The intercept that needs a call to the outside.
//
// An intercept that itself needs a call to the outside (asking a model which lessons apply)
// makes it as a step of the invocation that is calling the action. No transaction is held
// while it waits.
//
// The scenario runs against a real host process (fixtures/intercept-step-host.ts):
//
//   1. the guard of the action "send" calls the action "look" through `ctx.step`
//   2. the call to the outside is recorded as a step of the invocation, under a key of its own
//   3. the host is killed with SIGKILL, in the middle of the call to "send"
//   4. the host comes back: the invocation runs again, the guard is asked again, and the
//      recorded step answers — the stub "look" is not called a second time
//   5. outside an invocation there is no step: `ctx.step` is absent
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { seq } from "@niwa-labs/core";
import { counter, eventually, gate, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { GUARD_LOG, Start, actionsOf } from "./fixtures/intercept-step-host.ts";

const HOST_SCRIPT = new URL("./fixtures/intercept-step-host.ts", import.meta.url).pathname;

/** The lines of a file the host wrote, or nothing when it wrote none. */
async function linesOf(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split("\n").filter((line) => line.trim() !== "");
}

test("an intercept that needs a call to the outside makes it a step: after a crash the stub is called once", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const hosts: Array<ReturnType<typeof spawnHost>> = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    const first = spawnHost(HOST_SCRIPT, homePath);
    hosts.push(first);
    await first.ready();

    client = await connectAsOwner(homePath);
    await client.emit(Start, {});

    // The guard ran inside the invocation, so it had a step: the call to the outside was made.
    await eventually(
      () => counter(homePath, "look").count() >= 1,
      10_000,
      "the guard should have called the outside once",
    );
    expect((await linesOf(`${homePath}/${GUARD_LOG}`))[0]).toBe("inside");

    // The call to "send" is blocked on the gate: the host can be killed in the middle of it.
    await eventually(
      () => counter(homePath, "send").count() >= 1,
      10_000,
      "the action should have been called",
    );

    // A real crash: SIGKILL, no clean shutdown.
    await first.kill();
    await client.close().catch(() => {});
    client = undefined;

    // The host comes back on the same home, and the gate is opened right away.
    const second = spawnHost(HOST_SCRIPT, homePath);
    hosts.push(second);
    gate(homePath, "g1").open();
    await second.ready();

    // The invocation runs again: the guard is asked again, and its step is answered by the
    // record — the stub is not called a second time.
    await eventually(
      () => counter(homePath, "send").count() >= 2,
      15_000,
      "the action should have been called again after the restart",
    );
    await eventually(
      async () => (await linesOf(`${homePath}/${GUARD_LOG}`)).filter((line) => line === "inside").length >= 2,
      15_000,
      "the guard should have been asked again after the restart",
    );
    // Give the replay a moment to make a second call, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(counter(homePath, "look").count()).toBe(1);

    // The call to the outside was recorded as a step of the invocation, under a key of its own.
    const watcher = await connectAsOwner(homePath);
    const intents: string[] = [];
    try {
      const records = await watcher.records.read(seq(0), { type: "niwa.step.intent" as never });
      for (const record of records) {
        const data = record.data as { key?: string; action?: string };
        if (data.action === "look" && typeof data.key === "string") intents.push(data.key);
      }
    } finally {
      await watcher.close().catch(() => {});
    }
    expect(intents.length).toBeGreaterThan(0);
    // The key is namespaced under the intercepted step: it is not the step of the handler.
    expect(intents.every((key) => key.startsWith("k~guard~"))).toBe(true);
  } finally {
    await client?.close().catch(() => {});
    for (const host of hosts) await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("outside an invocation there is no step to make a call as", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const { send } = actionsOf(homePath);

  // The action waits on the gate; it is opened, so the call ends.
  gate(homePath, "g1").open();

  // The same guard, run by a host: a call from outside an invocation has no step.
  const host = createNiwa({ home: homePath });
  let sawStep: unknown = "unset";
  host.use(
    plugin("outside", (api) => {
      api.action(send);
      api.guard(send, async (_input, ctx) => {
        sawStep = ctx.step;
      });
    }),
  );
  await host.serve();
  try {
    await host.call(send, { text: "hello" });
    expect(sawStep).toBeUndefined();
  } finally {
    await host.close();
    await home.cleanup();
  }
}, 30_000);
