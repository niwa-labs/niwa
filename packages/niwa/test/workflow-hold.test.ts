// A hold: `workflow.pause { effects: "deny" }`.
//
//   1. while an operation the run began is still going the hold is `holding` and the status lists
//      it; once it ends the hold is `held`
//   2. under the hold a new write is refused and a read or a record of niwa's own is let through,
//      so the run can still say where it stands; `workflow.continue` releases the hold
//   3. with `tree`, a run the held run starts is held as well

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { action } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { connectAsOwner, eventually, plugin, tempHome } from "@niwa-labs/testing";
import { workflow, workflowContinue, workflowPause, workflowStart, workflowWait } from "@niwa-labs/workflow";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A gate the test opens: an action that waits on it is an operation in flight until then. */
function gate(): { wait: Promise<void>; open(): void; entered: boolean } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open(), entered: false };
}

let writeGate = gate();
let readGate = gate();
const written: number[] = [];

const slow = plugin("slow", (api) => {
  api.action(action("slow.write", {
    description: "Writes a number outside, once its gate opens.",
    input: z.object({ n: z.number(), gated: z.boolean().optional() }),
    output: z.object({ n: z.number() }),
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    run: async ({ n, gated }) => {
      if (gated === true) {
        writeGate.entered = true;
        await writeGate.wait;
      }
      written.push(n);
      return { n };
    },
  }));
  api.action(action("slow.read", {
    description: "Reads, once its gate opens.",
    input: z.object({ gated: z.boolean().optional() }),
    output: z.object({ read: z.boolean() }),
    recovery: "repeat",
    effect: "read",
    world: "external",
    run: async ({ gated }) => {
      if (gated === true) {
        readGate.entered = true;
        await readGate.wait;
      }
      return { read: true };
    },
  }));
});

async function served(): Promise<{ host: Host; home: string; owner: NiwaApi }> {
  writeGate = gate();
  readGate = gate();
  written.length = 0;
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(slow, workflow());
  await host.serve();
  hosts.push(host);
  const owner = await connectAsOwner(home.path);
  clients.push(owner);
  return { host, home: home.path, owner };
}

const tryWrite = (n: number): string =>
  `(async () => { try { await niwa.slow.write({ n: ${String(n)} }); return "written"; } catch (error) { return error.message; } })()`;

test("a hold is holding while a write is in flight and held after it; a new write is refused, a read passes", async () => {
  const { home, owner } = await served();
  const file = join(home, "hold.js");
  await writeFile(file, [
    'export default workflow({ uses: ["slow.*"], output: z.json() }, async () => {',
    "  await niwa.slow.write({ n: 1, gated: true }, { label: \"first\" });",
    "  const read = await niwa.slow.read({});",
    `  const second = await ${tryWrite(2)};`,
    "  return { read, second };",
    "});",
  ].join("\n"));
  const { run } = await owner.call(workflowStart, { file });
  await eventually(async () => writeGate.entered, 20_000, "the first write should be in flight");

  const holding = await owner.call(workflowPause, { run, effects: "deny" });
  expect(holding.state).toBe("running");
  expect(holding.hold).toMatchObject({ state: "holding", tree: false, inFlight: [{ run, action: "slow.write", effect: "write" }] });
  const hold = holding.hold?.id ?? "";
  // Asked again while it stands, the hold answers the same one.
  expect((await owner.call(workflowPause, { run, effects: "deny" })).hold?.id).toBe(hold);

  writeGate.open();
  const done = await owner.call(workflowWait, { run, timeoutMs: 20_000 });
  expect(done.state).toBe("finished");
  expect(done.outcome).toMatchObject({ status: "done", result: { read: { read: true } } });
  expect(String((done.outcome as unknown as { result: { second: string } }).result.second)).toContain("on hold");
  expect(written).toEqual([1]);
  expect(done.hold).toMatchObject({ id: hold, state: "held", inFlight: [] });

  const released = await owner.call(workflowContinue, { run, pause: hold });
  expect(released.hold).toBeUndefined();
}, 60_000);

test("a hold of the tree holds a run the held run starts", async () => {
  const { home, owner } = await served();
  const child = join(home, "child.js");
  await writeFile(child, `export default workflow({ uses: ["slow.*"], output: z.json() }, async () => ${tryWrite(3)});`);
  const parent = join(home, "parent.js");
  await writeFile(parent, [
    'export default workflow({ uses: ["slow.*", "workflow.start"], output: z.json() }, async () => {',
    "  await niwa.slow.read({ gated: true });",
    `  const started = await niwa.workflow.start({ file: ${JSON.stringify(child)}, wait: true, timeoutMs: 20000 });`,
    "  return started.outcome;",
    "});",
  ].join("\n"));
  const { run } = await owner.call(workflowStart, { file: parent });
  await eventually(async () => readGate.entered, 20_000, "the read should be in flight");
  const held = await owner.call(workflowPause, { run, tree: true, effects: "deny" });
  // A read in flight is not an operation a hold waits for.
  expect(held.hold).toMatchObject({ state: "held", tree: true, inFlight: [] });
  readGate.open();
  const done = await owner.call(workflowWait, { run, timeoutMs: 30_000 });
  expect(done.outcome).toMatchObject({ status: "done" });
  expect(String((done.outcome as unknown as { result: { result: string } }).result.result)).toContain("on hold");
  expect(written).toEqual([]);
}, 60_000);

