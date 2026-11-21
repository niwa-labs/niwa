// What the host says about itself, and the short ids, are for the owner or for whoever the thing is
// the caller's own: a client of another principal does not stop the host, read its status, read the
// pending sleeps, or learn of another's requests and runs from an ambiguous short id.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import type { NiwaApi } from "@niwa-labs/client";
import { requests } from "@niwa-labs/requests";
import { timers } from "@niwa-labs/timer";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; owner: NiwaApi; home: string; limited: (name: string) => Promise<NiwaApi> }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  const owner = await connectAsOwner(home.path);
  clients.push(owner);
  const limited = async (name: string): Promise<NiwaApi> => {
    const secret = host.issueToken(principalOf("session", name), {
      grant: grant(["niwa.*", "timer.list", "timer.get", "request.answer", "request.cancel", "workflow.start", "workflow.wait", "workflow.resume"]),
    });
    const client = await connect({ home: home.path, id: `session:${name}`, token: secret });
    clients.push(client);
    return client;
  };
  return { host, owner, home: home.path, limited };
}

async function scriptIn(home: string, name: string, text: string): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, name);
  await writeFile(file, text);
  return file;
}

test("a client that is not the owner does not stop the host or read its status or its sleeps, whatever its grant", async () => {
  const { owner, limited } = await served();
  const other = await limited("other");
  await expect(other.call(actionName("niwa.host.stop"), {})).rejects.toThrow("only the owner");
  await expect(other.call(actionName("niwa.host.status"), {})).rejects.toThrow("only the owner");
  await expect(other.call(actionName("timer.list"), {})).rejects.toThrow("only the owner");
  await expect(other.call(actionName("timer.get"), { name: "nobody" })).rejects.toThrow("only the owner");
  await expect(owner.call(actionName("timer.get"), { name: "nobody" })).rejects.toThrow('no timer "nobody"');
  expect(await owner.call(actionName("timer.list"), {})).toEqual({ sleeps: [], timers: [] });
  expect(await owner.call(actionName("niwa.host.status"), {})).toMatchObject({ plugins: expect.any(Array) });
}, 30_000);

test("a short id never names, or lists in a refusal, a run or a request of another principal", async () => {
  const { owner, home, limited } = await served();
  const mine = await limited("mine");
  const theirs = await limited("theirs");
  const START = actionName("workflow.start");
  const WAIT = actionName("workflow.wait");
  const quick = await scriptIn(home, "quick.js", "export default workflow({ output: z.number() }, async () => { return 1; });");
  const runSame1 = ((await mine.call(START, { file: quick, wait: true, timeoutMs: 20_000 })) as { run: string }).run;
  const runSame2 = ((await owner.call(START, { file: quick, wait: true, timeoutMs: 20_000 })) as { run: string }).run;

  // The owner sees both, so the start is ambiguous for it; the one who started one run sees only its own.
  await expect(owner.call(WAIT, { run: "run-" })).rejects.toThrow(/names 2 runs/);
  expect(await mine.call(WAIT, { run: "run-" })).toMatchObject({ run: runSame1, state: "finished" });
  // A client that started none does not learn that the runs exist.
  const refusal = await theirs.call(WAIT, { run: "run-" }).then(() => "", (error: Error) => error.message);
  expect(refusal).toContain('no run "run-"');
  expect(refusal).not.toContain(runSame1);
  expect(refusal).not.toContain(runSame2);

  const asks = (label: string): string => `export default workflow({ output: z.json() }, async () => { return await ask.confirm("go?", { label: "${label}" }); });`;
  const asking: string[] = [];
  for (const name of ["x", "y"]) asking.push(((await owner.call(START, { file: await scriptIn(home, `${name}.js`, asks("ship")) })) as { run: string }).run);
  const [runX = ""] = asking;
  await eventually(async () => {
    const open = (await owner.call(actionName("request.open"), {})) as { requests: unknown[] };
    return open.requests.length === 2;
  }, 20_000, "both runs should ask");
  // Every request id starts with the prefix of its kind, so it fits both.
  await expect(owner.call(actionName("request.answer"), { id: "req-", answer: { ids: ["yes"] } })).rejects.toThrow(/names 2 requests/);
  const hidden = await theirs.call(actionName("request.answer"), { id: "req-", answer: { ids: ["yes"] } }).then(() => "", (error: Error) => error.message);
  expect(hidden).not.toContain(runX);
  expect(hidden).not.toContain("names 2");
  const none = await theirs.call(actionName("request.answer"), { run: runX, answer: { ids: ["yes"] } }).then(() => "", (error: Error) => error.message);
  expect(none).toContain("has no open ask");
}, 30_000);

test("a client that is not the owner names an invocation by its whole id only", async () => {
  const { owner, home, limited } = await served();
  const other = await limited("other");
  const boom = await scriptIn(home, "boom.js", 'export default workflow({}, async () => { throw new Error("boom"); });');
  const runBoom = ((await owner.call(actionName("workflow.start"), { file: boom })) as { run: string }).run;
  await owner.call(actionName("workflow.wait"), { timeoutMs: 20_000, run: runBoom });
  const resolve = actionName("niwa.invocation.resolve");
  await expect(other.call(resolve, { run: runBoom, choice: "cancel" })).rejects.toThrow("only the owner");
  await expect(other.call(resolve, { invocation: "boom", choice: "cancel" })).rejects.toThrow("only the owner");
  await expect(other.call(actionName("workflow.resume"), { run: runBoom, choice: "cancel" })).rejects.toThrow("only the owner or whoever made it");
}, 30_000);
