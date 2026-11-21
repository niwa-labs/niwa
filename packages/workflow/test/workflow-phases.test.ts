// The phases of a script: `workflow({ phases })` declares the plan, `phase(title)` enters one (the script itself, or
// only the branch of `parallel`/`pipeline` it is called in), the typing holds the title to the declared ones, the
// child refuses an undeclared one where it is named, and a run's progress (done | current | ahead, several current
// while branches are in different phases) is derived from the records its branches wrote.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { record, seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, requests, timers, counter, eventually, gate, spawnHost, tempHome, connectAsOwner, watch } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowCheck, workflowGet, workflowInspect, workflowList, workflowRegister, workflowRuns, workflowStart, workflowWait } from "../src/index.ts";
import type { RunStatus } from "../src/status.ts";

import { PhaseEntered, PhaseLeft, StepPhase } from "../src/records.ts";
import { scriptTyping } from "../src/script-types.ts";
import { z } from "zod";

/** A record a branch of a test waits for. */
const Go = record("test.go", z.object({}));

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served(): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), plugin("go", (api) => api.declare(Go)), workflow());
  await host.serve();
  hosts.push(host);
  return { host, home: home.path };
}

async function scriptIn(home: string, name: string, lines: readonly string[]): Promise<string> {
  const file = join(home, name);
  await mkdir(home, { recursive: true });
  await writeFile(file, lines.join("\n"));
  return file;
}

const PHASES = 'phases: [{ title: "Ревью" }, { title: "Фикс", detail: "чиним подтверждённое" }]';

test("the typing gives phase() the union of the declared titles, never with none declared, and no step takes a phase", () => {
  const declared = scriptTyping([], [], [], [], new Map(), ["Ревью", "Фикс"]).declarations;
  expect(declared).toContain('type NiwaPhase = ("Ревью") | ("Фикс");');
  expect(declared).toContain("declare function phase(title: NiwaPhase): void;");
  expect(declared).toContain("type NiwaCallOptions = { label?: string; reason?: string };");
  expect(declared).not.toMatch(/phase\?:/);
  expect(scriptTyping([], []).declarations).toContain("type NiwaPhase = never;");
});

test("check: a declared phase passes at the top and in a branch; an undeclared one, phase() with no phases and a step's phase option are type errors", async () => {
  const { host, home } = await served();
  const good = await scriptIn(home, "good.ts", [
    `export default workflow({ ${PHASES} }, async () => {`,
    '  phase("Ревью");',
    "  await now();",
    '  await parallel([async () => { phase("Фикс"); await now(); }, async () => { await now(); }]);',
    "});",
  ]);
  const report = await host.call(workflowCheck, { file: good });
  expect(report.errors).toEqual([]);
  expect(report.phases).toEqual([{ title: "Ревью" }, { title: "Фикс", detail: "чиним подтверждённое" }]);

  const undeclared = await scriptIn(home, "undeclared.ts", [`export default workflow({ ${PHASES} }, async () => {`, '  phase("Деплой");', "});"]);
  expect((await host.call(workflowCheck, { file: undeclared })).errors).toMatchObject([{ line: 2, code: "TS2345" }]);

  const none = await scriptIn(home, "none.ts", ["export default workflow({}, async () => {", '  phase("Ревью");', "});"]);
  expect((await host.call(workflowCheck, { file: none })).errors).toMatchObject([{ line: 2, code: "TS2345" }]);

  const option = await scriptIn(home, "option.ts", [
    `export default workflow({ ${PHASES} }, async () => {`,
    '  await now({ phase: "Ревью" });',
    '  await agent("look", { phase: "Ревью" });',
    "});",
  ]);
  expect((await host.call(workflowCheck, { file: option })).errors).toMatchObject([
    { line: 2, code: expect.stringMatching(/^TS/) },
    { line: 3, code: expect.stringMatching(/^TS/) },
  ]);
}, 30_000);

test("check: phases with a repeated or empty title, or not written as a literal, are an error at the phases", async () => {
  const { host, home } = await served();
  const twice = await scriptIn(home, "twice.ts", ['export default workflow({ phases: [{ title: "A" }, { title: "A" }] }, async () => {});']);
  const twiceReport = await host.call(workflowCheck, { file: twice });
  expect(twiceReport.ok).toBe(false);
  expect(twiceReport.errors).toEqual([{ file: twice, line: 1, column: 35, code: "phases", message: expect.stringContaining('the phase "A" is declared twice') }]);

  const empty = await scriptIn(home, "empty.ts", ['export default workflow({ phases: [{ title: " " }] }, async () => {});']);
  expect((await host.call(workflowCheck, { file: empty })).errors).toMatchObject([{ code: "phases", message: expect.stringContaining("a phase has a title") }]);

  const computed = await scriptIn(home, "computed.ts", ['const titles = [{ title: "A" }];', "export default workflow({ phases: titles }, async () => {});"]);
  expect((await host.call(workflowCheck, { file: computed })).errors).toMatchObject([{ line: 2, code: "phases", message: expect.stringContaining("written in the declaration") }]);
}, 30_000);

/** The records of a type the host wrote. */
async function recordsOf(host: Host, type: string): Promise<StoredRecord[]> {
  return (await host.records.read()).filter((row) => row.type === type);
}

test("phases at the top go one after another: each entry is a record of its own, and each step is in the phase it began in", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "plan.ts", [
    'export default workflow({ phases: [{ title: "Ревью" }, { title: "Фикс", detail: "чиним" }, { title: "Отчёт" }] }, async () => {',
    '  await now({ label: "start" });',
    '  phase("Ревью");',
    '  await now({ label: "a" });',
    '  phase("Фикс");',
    '  await sleep("2h", { label: "nap" });',
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  await eventually(async () => (await host.call(workflowInspect, { run })).status.currentPhases?.includes("Фикс") === true, 15_000);

  const entered = await recordsOf(host, PhaseEntered.name);
  expect(entered.map((row) => row.data)).toEqual([
    { run, branch: "", phase: "Ревью" },
    { run, branch: "", phase: "Фикс" },
  ]);
  expect(entered.map((row) => String(row.id).split("/emit/").at(-1))).toEqual(["phase-entered:script:1", "phase-entered:script:2"]);
  expect((await recordsOf(host, StepPhase.name)).map((row) => row.data)).toEqual([
    { run, key: "label:a", phase: "Ревью" },
    { run, key: "label:nap", phase: "Фикс" },
  ]);

  const inspected = await host.call(workflowInspect, { run });
  expect(inspected.status.currentPhases).toEqual(["Фикс"]);
  expect(inspected.status.phases).toEqual([
    { title: "Ревью", state: "done" },
    { title: "Фикс", detail: "чиним", state: "current" },
    { title: "Отчёт", state: "ahead" },
  ]);
  expect(inspected.steps.map((step) => step.label)).toEqual(["start"]);
  expect(inspected.phases.map((phase) => [phase.title, phase.state, phase.steps.map((step) => step.label)])).toEqual([
    ["Ревью", "done", ["a"]],
    ["Фикс", "current", ["nap"]],
    ["Отчёт", "ahead", []],
  ]);
  expect(inspected.phases[1]?.steps[0]).toMatchObject({ key: "label:nap", phase: "Фикс" });
  const line = (await host.call(workflowRuns, {})).runs.find((item) => item.includes(run.slice(0, 8)));
  expect(line).toContain("Фикс (2/3)");
}, 30_000);

test("branches of a parallel inherit the phase they were made in and change only their own: the run is in two phases at once", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "branches.ts", [
    'export default workflow({ phases: [{ title: "Ревью" }, { title: "Фикс" }, { title: "Отчёт" }] }, async () => {',
    '  phase("Ревью");',
    "  await parallel([",
    '    async () => { phase("Фикс"); await sleep("2h", { label: "fixing" }); },',
    '    async () => { await sleep("2h", { label: "reviewing" }); },',
    "  ]);",
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  await eventually(async () => (await host.call(workflowInspect, { run })).phases.flatMap((phase) => phase.steps).length === 2, 15_000);

  const inspected = await host.call(workflowInspect, { run });
  expect(inspected.status.currentPhases).toEqual(["Ревью", "Фикс"]);
  expect(inspected.status.phases?.map((phase) => phase.state)).toEqual(["current", "current", "ahead"]);
  expect(inspected.phases.map((phase) => phase.steps.map((step) => step.label))).toEqual([["reviewing"], ["fixing"], []]);
  // The branch that changed its phase wrote it under its own path; the one that did not is in the phase it was made in.
  expect((await recordsOf(host, PhaseEntered.name)).map((row) => [String(row.id).split("/emit/").at(-1), (row.data as { phase: string }).phase])).toEqual(
    expect.arrayContaining([
      ["phase-entered:script:1", "Ревью"],
      ["phase-entered:p1.0:0", "Ревью"],
      ["phase-entered:p1.0:1", "Фикс"],
      ["phase-entered:p1.1:0", "Ревью"],
    ]),
  );
  const line = (await host.call(workflowRuns, {})).runs.find((item) => item.includes(run.slice(0, 8)));
  expect(line).toContain("Ревью (1/3), Фикс (2/3)");
}, 30_000);

test("a phase a branch entered and ended is ahead while another branch has not reached it; after the join the script's phases go on", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "behind.ts", [
    'export default workflow({ phases: [{ title: "Ревью" }, { title: "Фикс" }, { title: "Отчёт" }] }, async () => {',
    '  phase("Ревью");',
    "  let fixed = () => {};",
    "  const ended = new Promise<void>((resolve) => { fixed = resolve; });",
    "  await parallel([",
    '    async () => { phase("Фикс"); await now({ label: "fixed" }); fixed(); },',
    '    async () => { await ended; await now({ label: "reviewed" }); await wait("test.go", { label: "reviewing" }); },',
    "  ]);",
    '  phase("Отчёт");',
    '  await sleep("2h", { label: "report" });',
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  await eventually(async () => (await recordsOf(host, PhaseLeft.name)).length === 1, 15_000);
  let status: RunStatus = (await host.call(workflowInspect, { run })).status;
  expect(status.currentPhases).toEqual(["Ревью"]);
  expect(status.phases?.map((phase) => phase.state)).toEqual(["current", "ahead", "ahead"]);

  await host.emit(Go, {});
  await eventually(async () => (await host.call(workflowInspect, { run })).status.currentPhases?.[0] === "Отчёт", 15_000);
  status = (await host.call(workflowInspect, { run })).status;
  expect(status.currentPhases).toEqual(["Отчёт"]);
  expect(status.phases?.map((phase) => phase.state)).toEqual(["done", "done", "current"]);
  expect((await recordsOf(host, PhaseLeft.name)).map((row) => (row.data as { branch: string }).branch).sort()).toEqual(["p1.0", "p1.1"]);
}, 30_000);

test("a run whose script declares no phases has no plan, and phase() in it is an error of the script", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "plain.ts", ["export default workflow({}, async () => {", "  await now();", "});"]);
  const { run } = await host.call(workflowStart, { file });
  const status = await host.call(workflowWait, { run, timeoutMs: 15_000 });
  expect(status.state).toBe("finished");
  expect(status.phases).toBeUndefined();
  expect(status.currentPhases).toBeUndefined();
  const inspected = await host.call(workflowInspect, { run });
  expect(inspected.phases).toEqual([]);
  expect(inspected.steps).toHaveLength(1);

  const named = await scriptIn(home, "named.js", ["export default workflow({}, async () => {", '  phase("Ревью");', "});"]);
  const paused = await host.call(workflowWait, { run: (await host.call(workflowStart, { file: named })).run, timeoutMs: 15_000 });
  expect(paused.state).toBe("paused");
  expect(paused.reason).toEndWith('phase("Ревью"): the script declares no phases: declare them in workflow({ phases })');
}, 30_000);

test("phase() with an undeclared title fails where it is named, and the run stops in the phase before it", async () => {
  const { host, home } = await served();
  // A JS script without @ts-check is not type-checked: the child is what holds the title to the declared ones.
  const file = await scriptIn(home, "wrong.js", [
    `export default workflow({ ${PHASES} }, async () => {`,
    '  phase("Ревью");',
    '  await now({ label: "first" });',
    '  phase("Деплой");',
    '  await now({ label: "second" });',
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  const status = await host.call(workflowWait, { run, timeoutMs: 15_000 });
  expect(status.state).toBe("paused");
  expect(status.reason).toEndWith('phase("Деплой"): the script does not declare it: it declares "Ревью", "Фикс"');
  expect(status.phases).toEqual([
    { title: "Ревью", state: "current" },
    { title: "Фикс", detail: "чиним подтверждённое", state: "ahead" },
  ]);
  const steps = (await host.call(workflowInspect, { run })).phases.flatMap((phase) => phase.steps);
  expect(steps.map((step) => step.label)).toEqual(["first"]);
}, 30_000);

test("a finished run has done every phase it entered; a phase it never entered stays ahead", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "done.ts", [
    'export default workflow({ phases: [{ title: "A" }, { title: "B" }, { title: "C" }] }, async () => {',
    '  phase("A");',
    '  phase("B");',
    "  await now();",
    "});",
  ]);
  const { run } = await host.call(workflowStart, { file });
  const status = await host.call(workflowWait, { run, timeoutMs: 15_000 });
  expect(status.state).toBe("finished");
  expect(status.currentPhases).toEqual([]);
  expect(status.phases?.map((phase) => phase.state)).toEqual(["done", "done", "ahead"]);
}, 30_000);

test("the declared phases are on the registered version: workflow.get and workflow.list show them", async () => {
  const { host, home } = await served();
  const file = await scriptIn(home, "pr.ts", [
    `export default workflow({ description: "Ревью PR и фикс находок", ${PHASES} }, async () => {`,
    '  phase("Ревью");',
    "  await now();",
    "});",
  ]);
  const { id } = await host.call(workflowRegister, { file });
  const phases = [{ title: "Ревью" }, { title: "Фикс", detail: "чиним подтверждённое" }];
  expect((await host.call(workflowGet, { id })).versions[0]?.phases).toEqual(phases);
  expect((await host.call(workflowList, {})).items.find((item) => item.id === id)?.phases).toEqual(phases);
  // A run of the registered workflow shows the same plan.
  const { run } = await host.call(workflowStart, { id });
  const status = await host.call(workflowWait, { run, timeoutMs: 15_000 });
  expect(status.phases?.map((phase) => [phase.title, phase.state])).toEqual([["Ревью", "done"], ["Фикс", "ahead"]]);
}, 30_000);

test("the phases of branches survive a kill of the host: the replay writes the same records, and the run is in the same phases", async () => {
  const home = await tempHome();
  homes.push(home);
  const file = join(home.path, "replay.js");
  await writeFile(
    file,
    [
      'export default workflow({ phases: [{ title: "Ревью" }, { title: "Фикс" }, { title: "Отчёт" }], uses: ["branches.agent"], output: z.json() }, async () => {',
      '  phase("Ревью");',
      "  const both = await parallel([",
      '    async () => { phase("Фикс"); return agent("b1"); },',
      '    async () => { await agent("c1"); return agent("c2"); },',
      "  ]);",
      '  phase("Отчёт");',
      "  return both;",
      "});",
    ].join("\n"),
  );
  let first: ReturnType<typeof spawnHost> | undefined = spawnHost(fileURLToPath(new URL("./fixtures/branches-host.ts", import.meta.url)), home.path);
  let second: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    await first.ready();
    observer = await watch(home.path);
    const seen = observer.seen;
    const client = await connectAsOwner(home.path);
    const { run } = (await client.call("workflow.start" as ActionName, { file } as never)) as { run: string };
    const statusOf = async (): Promise<RunStatus> => (await client.call("workflow.wait" as ActionName, { run, timeoutMs: 100 } as never)) as RunStatus;
    const calls = counter(home.path, "branches.agent");
    gate(home.path, "branches.gate.c1").open();
    // b1 and c2 are in flight: one branch in Фикс, the other still in Ревью.
    await eventually(() => calls.count() === 3, 20_000);
    await eventually(async () => (await statusOf()).currentPhases?.join() === "Ревью,Фикс", 20_000);
    const invocationOf = (row: StoredRecord): string => (row.actor.kind === "handler" ? String(row.actor.invocation) : "");
    const before = new Set(seen.filter((row) => row.type === PhaseEntered.name).map(invocationOf));

    await first.kill();
    first = undefined;
    await client.close().catch(() => {});
    second = spawnHost(fileURLToPath(new URL("./fixtures/branches-host.ts", import.meta.url)), home.path);
    await second.ready();
    const again = await connectAsOwner(home.path);
    const statusAgain = async (): Promise<RunStatus> => (await again.call("workflow.wait" as ActionName, { run, timeoutMs: 100 } as never)) as RunStatus;
    // The replay ran: b1 and c2 were in flight at the kill, so they are made again; c1 is answered from the journal.
    await eventually(() => calls.count() === 5, 20_000);
    await eventually(async () => (await statusAgain()).currentPhases?.join() === "Ревью,Фикс", 20_000);

    gate(home.path, "branches.gate.b1").open();
    gate(home.path, "branches.gate.c2").open();
    const finished = (await again.call("workflow.wait" as ActionName, { run, timeoutMs: 20_000 } as never)) as RunStatus;
    expect(finished.state).toBe("finished");
    expect(finished.phases?.map((phase) => phase.state)).toEqual(["done", "done", "done"]);
    // The replay wrote no record of a phase twice: each key once, in the invocation the run had before the kill.
    const keysOf = (type: string): string[] => seen.filter((row) => row.type === type).map((row) => String(row.id).split("/emit/").at(-1) ?? "");
    await eventually(() => keysOf(PhaseLeft.name).length === 2, 10_000);
    expect(keysOf(PhaseEntered.name).sort()).toEqual(["phase-entered:p1.0:0", "phase-entered:p1.0:1", "phase-entered:p1.1:0", "phase-entered:script:1", "phase-entered:script:2"]);
    expect(keysOf(PhaseLeft.name).sort()).toEqual(["phase-left:p1.0", "phase-left:p1.1"]);
    expect(new Set(seen.filter((row) => row.type === PhaseEntered.name).map(invocationOf))).toEqual(before);
    await again.close().catch(() => {});
  } finally {
    await observer?.stop();
    await first?.kill().catch(() => {});
    await second?.kill().catch(() => {});
  }
}, 90_000);
