// What a script may do with no setup of the composition and nothing in `uses`: emit its own
// `wf.*` records, and ask the owner, who is told that the run asks.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf, seq, owner } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { connect, createNiwa, requests, eventually, tempHome } from "@niwa-labs/testing";
import type { Host, NiwaApi } from "@niwa-labs/testing";
import { workflow } from "../src/index.ts";

const START = actionName("workflow.start");

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A host whose every caller speaks as the owner, a workflow with no `emits`, and a caller that may only start runs. */
async function served(): Promise<{ host: Host; caller: NiwaApi; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  const bind = () => owner;
  host.use(requests({ bind }), workflow());
  await host.serve();
  hosts.push(host);
  const secret = host.issueToken(principalOf("session", "starter"), { grant: grant(["workflow.start", "workflow.check"]) });
  const caller = await connect({ home: home.path, id: "session:starter", token: secret });
  clients.push(caller);
  return { host, caller, home: home.path };
}

async function scriptIn(home: string, lines: readonly string[]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, "script.js");
  await writeFile(file, lines.join("\n"));
  return file;
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> =>
  (await host.records.read()).filter((row) => row.type === type);

test("a script emits the wf.* records it declares and asks the owner with nothing in uses and no emits in the composition", async () => {
  const { host, caller, home } = await served();
  const file = await scriptIn(home, [
    'const Note = record("note", z.object({ text: z.string() }));',
    'export default workflow({ name: "free", emits: [Note], output: z.json() }, async () => {',
    '  await emit(Note, { text: "hi" });',
    '  return await ask.confirm("go on?");',
    '});',
  ]);
  const { run } = (await caller.call(START, { file })) as { run: string };

  await eventually(async () => (await ofType(host, "request.created")).length === 1, 10_000, "the run should ask");
  const note = (await ofType(host, "wf.free.note"))[0];
  expect(note?.data).toEqual({ text: "hi" });
  // The question says who asks: the run, not whoever the host binds its callers to.
  const asked = (await ofType(host, "request.created"))[0]?.data as { from?: unknown; to: unknown };
  expect(asked.from).toEqual({ kind: "client", id: `run:${run}` });
  expect(asked.to).toEqual({ kind: "owner" });
}, 30_000);

test("a script emits only the records it lists in emits (one the check cannot see is refused when it runs), with data its schema holds", async () => {
  const { host, caller, home } = await served();
  const paused = async (lines: readonly string[]): Promise<string> => {
    const file = await scriptIn(home, lines);
    const { run } = (await caller.call(START, { file })) as { run: string };
    await eventually(async () => (await ofType(host, "workflow.run.paused")).some((row) => (row.data as { run: string }).run === run), 10_000, "the run should pause");
    return (await ofType(host, "workflow.run.paused")).map((row) => row.data as { run: string; reason: string }).find((data) => data.run === run)?.reason ?? "";
  };
  // The name is bound to another record after the declaration was read: the text matches, the record does not.
  expect(
    await paused([
      'let Done = record("done", z.object({ run: z.string() }));',
      'export default workflow({ name: "mine", emits: [Done] }, async () => {',
      '  Done = record("spoof", z.object({ run: z.string() }));',
      '  await emit(Done, { run: "x" });',
      "});",
    ]),
  ).toContain("lists in workflow({ emits })");
  // A plain JS script is not type-checked: the data the schema refuses is refused when it runs.
  expect(
    await paused([
      'const Done = record("done", z.object({ run: z.string() }));',
      'export default workflow({ name: "mine", emits: [Done] }, async () => {',
      "  await emit(Done, { run: 3 });",
      "});",
    ]),
  ).toContain("expected string");
  expect((await ofType(host, "wf.mine.done")).length + (await ofType(host, "wf.mine.spoof")).length).toBe(0);
}, 30_000);

test("workflow.check reports an emit of a record the script does not list, and emits in a script with no name", async () => {
  const { caller, home } = await served();
  const check = async (lines: readonly string[]) =>
    (await caller.call(actionName("workflow.check"), { file: await scriptIn(home, lines) })) as { ok: boolean; errors: Array<{ code: string; line: number; message: string }> };
  const unlisted = await check([
    'const Ok = record("ok", z.object({}));',
    'const Spoof = record("spoof", z.object({}));',
    'export default workflow({ name: "mine", emits: [Ok] }, async () => {',
    "  await emit(Ok, {});",
    "  await emit(Spoof, {});",
    "});",
  ]);
  expect(unlisted.ok).toBe(false);
  expect(unlisted.errors).toHaveLength(1);
  expect(unlisted.errors[0]).toMatchObject({ code: "emit", line: 5 });
  expect(unlisted.errors[0]?.message).toContain("lists in workflow({ emits })");
  const nameless = await check(['const Ok = record("ok", z.object({}));', "export default workflow({ emits: [Ok] }, async () => {", "  await emit(Ok, {});", "});"]);
  expect(nameless.errors).toMatchObject([{ code: "emit", line: 2, message: expect.stringContaining("declares a name") }]);
}, 30_000);
