// The subscriptions of the workflow module: `workflow.install` with `on` makes the profile `wf:<sub-id>` and niwa starts
// one run per matching record under it; the author of the record gets no rights from it; narrowing the
// installer narrows the runs born after it and closing it stops the installation from starting any, while
// the runs that live keep the grant they were born with; a record is handled once over a restart of the host.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionRef, grant, principalOf, principalSchema, seq, owner } from "@niwa-labs/core";
import type { RuleSpec, StoredRecord } from "@niwa-labs/core";
import type { CallerBinding } from "@niwa-labs/plugin";
import { scriptOn } from "@niwa-labs/script";
import { connect, createNiwa, messages, requests, tasks, TaskDone, timers, counter, eventually, tempHome, connectAsOwner, StubFinished, WfNote, stub } from "@niwa-labs/testing";
import type { Host, NiwaApi } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowInstall, workflowInstallationList, workflowUninstall } from "@niwa-labs/workflow";
import { z } from "zod";

import { holds } from "@niwa-labs/core";

const stubFinish = actionRef("stub.finish", {
  description: "Finish a thing: writes the record a script waits for.",
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string() }),
});
const profileGet = actionRef("access.profile.get", {
  description: "A named grant and whether the owner set it.",
  input: z.object({ name: z.string().min(1).optional() }),
  output: z.object({ names: z.array(z.string()), name: z.string().optional(), rules: z.array(z.unknown()).optional() }),
});
const grantChange = actionRef("access.grant.change", {
  description: "Gives a principal another grant.",
  input: z.object({ principal: principalSchema, rules: z.array(z.string()) }),
  output: z.object({ grant: z.string() }),
});
const grantClose = actionRef("access.grant.close", {
  description: "Closes the grant of a principal.",
  input: z.object({ principal: principalSchema, reason: z.string().optional() }),
  output: z.object({ closed: z.array(principalSchema) }),
});

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A host with the stub actions, the workflow module and the record `stub.finished` as a trigger. */
async function served(path?: string): Promise<{ host: Host; home: string }> {
  const home = path ?? (await newHome());
  const host = createNiwa({ home });
  host.use(requests(), timers([]), stub(home));
  host.use(workflow({ triggers: [StubFinished], emits: [WfNote] }));
  await host.serve();
  hosts.push(host);
  return { host, home };
}

async function newHome(): Promise<string> {
  const home = await tempHome();
  homes.push(home);
  return home.path;
}

/** A client that holds exactly this grant: a subject of its own, as a session is. */
async function holding(host: Host, home: string, name: string, rules: readonly RuleSpec[]): Promise<NiwaApi> {
  const secret = host.issueToken(principalOf("session", name), { grant: grant(rules) });
  const client = await connect({ home, id: `session:${name}`, token: secret });
  clients.push(client);
  return client;
}

async function ownerOf(home: string): Promise<NiwaApi> {
  const client = await connectAsOwner(home);
  clients.push(client);
  return client;
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  const file = join(home, name);
  await mkdir(home, { recursive: true });
  await writeFile(file, lines.join("\n"));
  return file;
}

const ofType = (records: readonly StoredRecord[], type: string): StoredRecord[] => records.filter((row) => row.type === type);
const recordsOf = (host: Host): Promise<StoredRecord[]> => host.records.read();
const requested = async (host: Host): Promise<number> => ofType(await recordsOf(host), "workflow.run.requested").length;
const finished = async (host: Host): Promise<StoredRecord[]> => ofType(await recordsOf(host), "workflow.run.finished");

/** The grants given to runs, in order. */
async function runGrants(host: Host): Promise<Array<{ principal: { kind: string; id: string }; rules: string[]; parent?: { principal: { kind: string; id: string } } }>> {
  return ofType(await recordsOf(host), "niwa.access.granted")
    .map((row) => row.data as { principal: { kind: string; id: string }; rules: string[]; parent?: { principal: { kind: string; id: string } } })
    .filter((data) => data.principal.kind === "run");
}

/** Is a run that a subscription started waiting? */
const waitingRuns = async (host: Host): Promise<boolean> =>
  ofType(await recordsOf(host), "niwa.invocation.state").some((row) => {
    const state = row.data as { invocation: string; state: string };
    return state.state === "waiting" && state.invocation.startsWith("inv:workflow/workflow.run.requested");
  });

const profileRules = async (client: NiwaApi, name: string): Promise<string[]> =>
  ((await client.call(profileGet, { name })).rules ?? []).map(String).sort();

/** Every script of these tests starts on a finished stub thing; the filter names the id. */
const onId = (id: string): string => `on: [{ type: "stub.finished", filter: { id: "${id}" } }],`;

test("W3a: a matching record starts a run under wf:<sub-id>; records before the install and records that do not match start nothing; the author gets no rights", async () => {
  const { host, home } = await served();
  const installer = await holding(host, home, "installer", ["workflow.install", "workflow.installation.list", "stub.create"]);
  const author = await holding(host, home, "author", ["stub.finish"]);
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "made.js", [
    "export default workflow({",
    `  ${onId("a")}`,
    '  uses: ["stub.create"],',
    "  output: z.json(),",
    "}, async (trigger) => {",
    '  const made = await niwa.stub.create({ name: trigger.data.id }, { label: "create" });',
    "  let borrowed;",
    '  try { await call("stub.finish", { id: "stolen" }, { label: "borrowed" }); borrowed = "called"; } catch (error) { borrowed = error.message; }',
    "  return { made, borrowed, trigger };",
    "});",
  ]);

  // A record from before the installation: it starts nothing, now or later.
  const early = await author.call(stubFinish, { id: "a" });
  expect(early.id).toBe("a");

  const installed = await installer.call(workflowInstall, { file, description: "made" });
  expect(installed.id).toMatch(/^sub-[0-9a-f]{6,8}$/);
  expect(installed.profile).toBe(`wf:${installed.id}`);
  expect(await profileRules(owner, installed.profile)).toEqual(["call:stub.create", "emit:wf.*"]);
  expect((await installer.call(workflowInstallationList, {})).items).toMatchObject([{ id: installed.id, description: "made", file, on: [{ type: "stub.finished", filter: { id: "a" } }] }]);

  await author.call(stubFinish, { id: "b" });
  await author.call(stubFinish, { id: "a" });
  await eventually(async () => (await finished(host)).length === 1, 20_000, "the matching record should start a run");
  expect(await requested(host)).toBe(1);

  const result = (await finished(host))[0]?.data as { outcome: { result: { made: { id: string }; borrowed: string; trigger: { type: string; data: unknown } } } };
  expect(result.outcome.result.made).toEqual({ id: "t-a" });
  // The record's author holds `stub.finish`; the run does not get it from the record.
  expect(result.outcome.result.borrowed).toContain("not in the grant");
  expect(result.outcome.result.trigger).toMatchObject({ type: "stub.finished", data: { id: "a" } });
  expect(ofType(await recordsOf(host), "stub.finished").map((row) => (row.data as { id: string }).id)).toEqual(["a", "b", "a"]);

  const grants = await runGrants(host);
  expect(grants).toHaveLength(1);
  expect(grants[0]?.principal.id).toMatch(/^run-[0-9a-f]{6,8}$/);
  expect(grants[0]?.rules).toEqual(["call:stub.create", "emit:wf.*"]);
  expect(grants[0]?.parent).toMatchObject({ principal: { kind: "session", id: "installer" } });
  const started = ofType(await recordsOf(host), "workflow.run.started")[0]?.data as { installation?: string; label?: string };
  expect(started).toMatchObject({ installation: installed.id });
  expect(started.label).toBeUndefined();
}, 30_000);

test("a script without on, an unserved type and uses wider than the installer are refused and install nothing; the same script installs twice under two ids", async () => {
  const { host, home } = await served();
  const installer = await holding(host, home, "narrow", ["workflow.install", "workflow.check", "stub.create"]);
  const bare = await scriptIn(home, "bare.js", [`export default workflow({ uses: ["stub.create"], output: z.number() }, async () => { return 1; });`]);
  await expect(installer.call(workflowInstall, { file: bare, description: "bare" })).rejects.toThrow("no `on`");

  const unserved = await scriptIn(home, "unserved.js", [`export default workflow({ on: ["no.such.record"], output: z.number() }, async () => { return 1; });`]);
  await expect(installer.call(workflowInstall, { file: unserved, description: "unserved" })).rejects.toThrow("does not start scripts on this record type");

  const wide = await scriptIn(home, "wide.js", [`export default workflow({ ${onId("a")} uses: ["stub.*"], output: z.number() }, async () => { return 1; });`]);
  await expect(installer.call(workflowInstall, { file: wide, description: "wide" })).rejects.toThrow("wider than the caller's rights");

  const fine = await scriptIn(home, "fine.js", [`export default workflow({ ${onId("a")} uses: ["stub.create"], output: z.number() }, async () => { return 1; });`]);
  const first = await installer.call(workflowInstall, { file: fine, description: "fine" });
  const second = await installer.call(workflowInstall, { file: fine, description: "fine" });
  expect(second.id).not.toBe(first.id);
  expect(await runGrants(host)).toHaveLength(0);
  expect((await ownerOf(home).then((owner) => owner.call(profileGet, {}))).names.filter((name) => name.startsWith("wf:")).sort()).toEqual([first.profile, second.profile].sort());
}, 30_000);

test("uninstall ends it: nothing starts any more and the profile is empty", async () => {
  const { host, home } = await served();
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "gone.js", [`export default workflow({ ${onId("a")} uses: [], output: z.number() }, async () => { return 1; });`]);
  const gone = await owner.call(workflowInstall, { file, description: "gone" });
  await owner.call(stubFinish, { id: "a" });
  await eventually(async () => (await finished(host)).length === 1, 20_000);

  expect(await owner.call(workflowUninstall, { id: gone.id.slice(-4) })).toEqual({ id: gone.id });
  expect((await owner.call(workflowInstallationList, {})).items).toEqual([]);
  expect(await profileRules(owner, gone.profile)).toEqual([]);
  await owner.call(stubFinish, { id: "a" });
  await expect(owner.call(workflowUninstall, { id: gone.id })).rejects.toThrow("no subscription");
  // The installation's subscription ended with it: the record is not even admitted.
  await Bun.sleep(300);
  expect(ofType(await recordsOf(host), "niwa.invocation.admitted").filter((row) => String((row.data as { handler: string }).handler).includes("workflow.on:"))).toHaveLength(1);
  expect(await requested(host)).toBe(1);
}, 30_000);

/** The runs of the subscriptions that wait for a record now. */
const waitingCount = async (host: Host): Promise<number> => {
  const latest = new Map<string, string>();
  for (const row of ofType(await recordsOf(host), "niwa.invocation.state")) {
    const data = row.data as { invocation: string; state: string };
    if (data.invocation.startsWith("inv:workflow/workflow.run.requested")) latest.set(data.invocation, data.state);
  }
  return [...latest.values()].filter((state) => state === "waiting").length;
};

/** The runs whose grant was closed. */
const closedRuns = async (host: Host): Promise<string[]> =>
  ofType(await recordsOf(host), "niwa.access.closed")
    .map((row) => (row.data as { principal: { kind: string; id: string } }).principal)
    .filter((principal) => principal.kind === "run")
    .map((principal) => principal.id);

/** A script that waits to be let go and then calls `stub.create`, which the installer may hold or not. */
const creating = [
  'export default workflow({ on: [{ type: "stub.finished", filter: { id: "first" } }, { type: "stub.finished", filter: { id: "second" } }], uses: ["stub.create", "niwa.records.read"], output: z.json() }, async () => {',
  "  try {",
  '    await wait("stub.finished", { filter: { id: "release" } });',
  '    return await niwa.stub.create({ name: "x" });',
  "  } catch (error) {",
  "    return error.message;",
  "  }",
  '});',
];

test("W3b: narrowing the installer leaves the run that lives as it was; the next run is born with the narrowed profile", async () => {
  const { host, home } = await served();
  const installer = await holding(host, home, "keeper", ["workflow.install", "stub.create", "niwa.records.read"]);
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "creating.js", creating);
  const { profile } = await installer.call(workflowInstall, { file, description: "creating" });
  expect(await profileRules(owner, profile)).toEqual(["call:niwa.records.read", "call:stub.create", "emit:wf.*"]);

  await owner.call(stubFinish, { id: "first" });
  await eventually(async () => (await waitingCount(host)) === 1, 20_000);

  // The installer loses `stub.create`.
  await owner.call(grantChange, { principal: principalOf("session", "keeper"), rules: ["workflow.install", "niwa.records.read"] });
  expect(await closedRuns(host)).toEqual([]);

  await owner.call(stubFinish, { id: "second" });
  await eventually(async () => (await waitingCount(host)) === 2, 20_000);
  const [lived, next] = await runGrants(host);
  expect(lived?.rules.slice().sort()).toEqual(["call:niwa.records.read", "call:stub.create", "emit:wf.*"]);
  expect(next?.rules.slice().sort()).toEqual(["call:niwa.records.read", "emit:wf.*"]);

  // Both are let go: the run that lived still holds `stub.create`, the next one does not.
  await owner.call(stubFinish, { id: "release" });
  await eventually(async () => (await finished(host)).length === 2, 20_000);
  const results = new Map(
    (await finished(host)).map((row) => {
      const data = row.data as { run: string; outcome: { result: unknown } };
      return [data.run, data.outcome.result] as const;
    }),
  );
  expect(results.get(lived?.principal.id ?? "")).toEqual({ id: "t-x" });
  expect(String(results.get(next?.principal.id ?? ""))).toContain("stub.create");
}, 30_000);

test("W3b: closing the installer stops the installation from starting runs; the run that lives ends as it was born", async () => {
  const { host, home } = await served();
  const installer = await holding(host, home, "doomed", ["workflow.install", "stub.create", "niwa.records.read"]);
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "creating.js", creating);
  await installer.call(workflowInstall, { file, description: "creating" });
  await owner.call(stubFinish, { id: "first" });
  await eventually(async () => (await waitingCount(host)) === 1, 20_000);

  await owner.call(grantClose, { principal: principalOf("session", "doomed") });
  expect(await closedRuns(host)).toEqual([]);

  await owner.call(stubFinish, { id: "second" });
  await eventually(
    async () => ofType(await recordsOf(host), "niwa.invocation.admitted").filter((row) => String((row.data as { handler: string }).handler).includes("workflow.on:")).length === 2,
    20_000,
  );
  expect(await requested(host)).toBe(1);

  await owner.call(stubFinish, { id: "release" });
  await eventually(async () => (await finished(host)).length === 1, 20_000, "the run that lived should end by itself");
  expect((await finished(host))[0]?.data).toMatchObject({ outcome: { result: { id: "t-x" } } });
}, 30_000);

test("a script that is not the bytes that were installed starts nothing and pauses for the owner", async () => {
  const { host, home } = await served();
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "pinned.js", [`export default workflow({ ${onId("a")} uses: [], output: z.number() }, async () => { return 1; });`]);
  await owner.call(workflowInstall, { file, description: "pinned" });
  await writeFile(file, `export default workflow({ ${onId("a")} uses: [], output: z.number() }, async () => { return 2; });\n`);
  await owner.call(stubFinish, { id: "a" });
  await eventually(
    async () => ofType(await recordsOf(host), "niwa.invocation.state").some((row) => (row.data as { state: string }).state === "paused"),
    20_000,
    "the changed script should pause the handler",
  );
  expect(await requested(host)).toBe(0);
  expect(await runGrants(host)).toHaveLength(0);
}, 30_000);

test("exactly once: a restart of the host neither loses nor duplicates the run of a record", async () => {
  const first = await served();
  const { home } = first;
  const owner = await ownerOf(home);
  const file = await scriptIn(home, "holds.js", [
    `export default workflow({ ${onId("go")} uses: ["stub.create", "niwa.records.read"], output: z.json() }, async () => {`,
    '  await wait("stub.finished", { filter: { id: "release" } });',
    '  return await niwa.stub.create({ name: "once" }, { label: "create" });',
    `});`,
  ]);
  // A record from before the installation, then the installation, then the record that matches.
  await owner.call(stubFinish, { id: "go" });
  await owner.call(workflowInstall, { file, description: "holds" });
  await owner.call(stubFinish, { id: "go" });
  await eventually(async () => waitingRuns(first.host), 20_000, "the run should be waiting for its record");
  expect(await requested(first.host)).toBe(1);
  await owner.close();
  clients.length = 0;
  await first.host.close();

  // The run waits in the second host as it did in the first: it is not started again.
  const second = await served(home);
  const again = await ownerOf(home);
  expect(await requested(second.host)).toBe(1);
  expect(counter(home, "w1.create").count()).toBe(0);
  await again.call(stubFinish, { id: "release" });
  await eventually(async () => (await finished(second.host)).length === 1, 20_000, "the run should finish after the restart");
  expect(counter(home, "w1.create").count()).toBe(1);
  expect(await requested(second.host)).toBe(1);
  expect(await runGrants(second.host)).toHaveLength(1);

  // A record after the restart starts a run of its own.
  await again.call(stubFinish, { id: "go" });
  await eventually(async () => (await requested(second.host)) === 2, 20_000);
}, 60_000);

test("on is read from the text: types, filters with dotted paths, and the shapes that are refused", async () => {
  const parsed = await scriptOn({
    file: "on.ts",
    text: 'export default workflow({ on: ["a.b", { type: "c.d", filter: { "x.y": 1, z: [true, null], w: { n: -2 } } }] }, async () => {});',
  });
  expect(parsed).toMatchObject({
    subscriptions: [{ type: "a.b" }, { type: "c.d", filter: { "x.y": 1, z: [true, null], w: { n: -2 } } }],
  });
  expect(await scriptOn({ file: "none.ts", text: "export default workflow({}, async () => {});" })).toBeUndefined();
  for (const text of [
    'export default workflow({ on: "a.b" }, async () => {});',
    "export default workflow({ on: [1] }, async () => {});",
    'export default workflow({ on: [{ type: "a", filter: { x: somewhere } }] }, async () => {});',
    'export default workflow({ on: [{ type: "a", extra: 1 }] }, async () => {});',
    "export default workflow({ on: [{ filter: {} }] }, async () => {});",
  ]) {
    expect(await scriptOn({ file: "bad.ts", text })).toHaveProperty("bad");
  }
}, 30_000);

test("the filter of a subscription is the filter of a wait: equality on fields, a dotted path goes into nested data", () => {
  const data = { task: { id: "t1", tags: ["a"] }, "flat.key": 1, ok: true };
  expect(holds(data, undefined)).toBe(true);
  expect(holds(data, { "task.id": "t1", ok: true })).toBe(true);
  expect(holds(data, { "task.id": "t2" })).toBe(false);
  expect(holds(data, { "task.tags": ["a"] })).toBe(true);
  expect(holds(data, { "flat.key": 1 })).toBe(true);
  expect(holds(data, { "task.missing.deeper": 1 })).toBe(false);
  expect(holds(null, {})).toBe(true);
  expect(holds("text", { a: 1 })).toBe(false);
}, 30_000);

test("the default export is typed by the generated declarations: the data of the record the script starts on", async () => {
  const { host, home } = await served();
  const owner = await ownerOf(home);
  const good = await scriptIn(home, "typed.ts", [
    `export default workflow({ ${onId("a")} uses: [], output: z.json() }, async (trigger: NiwaTrigger) => {`,
    "  return trigger.data.id.length;",
    `});`,
  ]);
  expect((await owner.call(workflowCheck, { file: good })).ok).toBe(true);
  const bad = await scriptIn(home, "untyped.ts", [
    `export default workflow({ ${onId("a")} uses: [], output: z.json() }, async (trigger: NiwaTrigger) => {`,
    "  return trigger.data.nope;",
    `});`,
  ]);
  const report = await owner.call(workflowCheck, { file: bad });
  expect(report.ok).toBe(false);
  expect(report.errors).toEqual([expect.objectContaining({ code: "TS2339" })]);
  expect(await requested(host)).toBe(0);
}, 30_000);

// --- the example ------------------------------------------------------------------------------------------------

const bind: CallerBinding = (caller) => {
  // A script speaks as its run, never as the owner.
  if (caller.kind === "client" && caller.principal?.kind === "run") return { kind: "client", id: caller.id };
  if (caller.kind === "client" && caller.id.startsWith("builder")) return { kind: "agent", id: "builder" };
  return undefined;
};

const EXAMPLE = new URL("../examples/14-workflow-subscription.ts", import.meta.url).pathname;

test("examples/14-workflow-subscription.ts: a failed task tells the owner; a task that succeeded does not", async () => {
  const home = await newHome();
  const host = createNiwa({ home });
  host.use(requests(), timers([]), messages({ bind }), tasks({ messages: { bind } }));
  host.use(workflow({ root: process.cwd(), triggers: [TaskDone] }));
  await host.serve();
  hosts.push(host);
  const ownerClient = await ownerOf(home);
  const builder = await connectAsOwner(home, "builder");
  clients.push(builder);

  const check = await ownerClient.call(workflowCheck, { file: EXAMPLE });
  expect(check.errors).toEqual([]);
  const { profile } = await ownerClient.call(workflowInstall, { file: EXAMPLE, description: "notify-failed" });
  expect(await profileRules(ownerClient, profile)).toEqual(["call:message.send", "emit:wf.*"]);

  const make = (text: string) =>
    host.call(
      actionRef("task.create", {
        description: "Make a task.",
        input: z.object({ kind: z.string(), description: z.string(), text: z.string(), askedBy: z.unknown(), responsible: z.unknown(), reportTo: z.unknown() }),
        output: z.object({ id: z.string() }),
      }),
      { kind: "build", description: `Build ${text}`, text, askedBy: { kind: "owner" }, responsible: { kind: "agent", id: "builder" }, reportTo: { kind: "owner" } },
    );
  const finish = actionRef("task.finish", {
    description: "Finish a task.",
    input: z.object({ task: z.string(), result: z.unknown() }),
    output: z.unknown(),
  });
  const fail = actionRef("task.fail", {
    description: "End a task as failed.",
    input: z.object({ task: z.string(), reason: z.string() }),
    output: z.unknown(),
  });
  const fine = await make("fine");
  const broken = await make("broken");
  await builder.call(finish, { task: fine.id, result: "ok" });
  await builder.call(fail, { task: broken.id, reason: "the lockfile is stale" });

  await eventually(async () => (await finished(host)).length === 1, 20_000, "the failed task should start a run");
  expect((await finished(host))[0]?.data).toMatchObject({ outcome: { result: broken.id } });
  const sent = ofType(await recordsOf(host), "message.sent").filter((row) => JSON.stringify(row.data).includes(`Task ${broken.id} failed: the lockfile is stale`));
  expect(sent).toHaveLength(1);
  expect(await requested(host)).toBe(1);
}, 30_000);
