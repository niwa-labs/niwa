// A target template in `uses` is filled from the input of the run.
//
//   1. the run is born with the rule the template gives for its input, and calls within it
//   2. an input whose value would widen the rule (a wildcard, an empty segment) or that has no
//      value for a placeholder refuses the start
//   3. a filled rule wider than the starter's grant refuses the start whole
//   4. the check accepts a template, and still refuses one whose shape is wrong

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_TYPES, actionName, grant, principalOf } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { eventually, tempHome } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";

import { OPEN, PrOpened, forge } from "./fixtures/forge-plugin.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const START = actionName("workflow.start");
const CHECK = actionName("workflow.check");
const INSTALL = actionName("workflow.install");

const SCRIPT = [
  "export default workflow({",
  '  uses: ["forge.pr.merge@{repo.host}/{repo.path}/pr/*"],',
  "  input: z.object({ repo: z.object({ host: z.string(), path: z.string() }), pr: z.number() }),",
  "  output: z.json(),",
  "}, async ({ repo, pr }) => {",
  "  return await niwa.forge.pr.merge({ repo: repo.path, pr });",
  "});",
].join("\n");

async function served(): Promise<{ host: Host; home: string; file: string; starter: NiwaApi }> {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(forge, workflow({ triggers: [PrOpened] }));
  await host.serve();
  hosts.push(host);
  const file = join(home.path, "land.js");
  await writeFile(file, SCRIPT);
  const token = host.issueToken(principalOf("session", "starter"), {
    grant: grant(["forge.pr.merge@git.example.com/acme/*", "workflow.start", "workflow.check", "workflow.install", "forge.pr.open"]),
  });
  const starter = await connect({ home: home.path, id: "session:starter", token });
  clients.push(starter);
  return { host, home: home.path, file, starter };
}

const ofType = async (host: Host, type: string): Promise<StoredRecord[]> => (await host.records.read()).filter((row) => row.type === type);

const runRules = async (host: Host, run: string): Promise<string[]> => {
  const rows = (await ofType(host, CORE_TYPES.accessGranted)).filter((row) => (row.data as { principal: { id: string } }).principal.id === run);
  return (rows.at(-1)?.data as { rules: string[] }).rules;
};

test("a run is born with the rule its input fills the template with, and calls within it", async () => {
  const { host, file, starter } = await served();
  const started = (await starter.call(START, {
    file,
    args: { repo: { host: "git.example.com", path: "acme/billing" }, pr: 7 },
    wait: true,
    timeoutMs: 20_000,
  })) as { run: string; state: string; result?: unknown };
  expect(started).toMatchObject({ state: "finished", outcome: { status: "done", result: { ok: true } } });
  expect(await runRules(host, started.run)).toEqual(["call:forge.pr.merge@git.example.com/acme/billing/pr/*", "emit:wf.*"]);
}, 30_000);

test("a value that would widen the rule, or a missing one, refuses the start", async () => {
  const { file, starter } = await served();
  for (const path of ["acme/*", "acme//billing", ""]) {
    await expect(starter.call(START, { file, args: { repo: { host: "git.example.com", path }, pr: 1 } })).rejects.toThrow(
      "{repo.path} is not one or more segments",
    );
  }
}, 30_000);

test("a filled rule wider than the starter's grant refuses the start whole", async () => {
  const { file, starter } = await served();
  await expect(starter.call(START, { file, args: { repo: { host: "git.example.com", path: "other/x" }, pr: 1 } })).rejects.toThrow(
    "forge.pr.merge@git.example.com/other/x/pr/*",
  );
}, 30_000);

test("the check accepts a template and refuses one whose placeholder is not a whole segment", async () => {
  const { home, file, starter } = await served();
  expect(await starter.call(CHECK, { file })).toMatchObject({ ok: true, errors: [] });
  const bad = join(home, "bad.js");
  await writeFile(bad, SCRIPT.replace("{repo.host}/{repo.path}", "{repo.host}x/{repo.path}"));
  const report = (await starter.call(CHECK, { file: bad })) as { ok: boolean; errors: { message: string }[] };
  expect(report.ok).toBe(false);
  expect(report.errors.map((error) => error.message).join("\n")).toContain("is not an action name, a rule or a target template");
}, 30_000);

test("a run started by a record fills the template from the record, and one that would widen the rule starts nothing", async () => {
  const { host, home, starter } = await served();
  const file = join(home, "on-open.js");
  await writeFile(file, [
    "export default workflow({",
    '  on: ["forge.pr.opened"],',
    '  uses: ["forge.pr.merge@{data.repo.host}/{data.repo.path}/pr/*"],',
    "  output: z.json(),",
    "}, async ({ data }) => {",
    "  return await niwa.forge.pr.merge({ repo: data.repo.path, pr: data.pr });",
    "});",
  ].join("\n"));
  await starter.call(INSTALL, { file, description: "merge what opens" });
  await starter.call(OPEN, { repo: { host: "git.example.com", path: "acme/billing" }, pr: 3 });
  await starter.call(OPEN, { repo: { host: "git.example.com", path: "other/x" }, pr: 4 });
  await starter.call(OPEN, { repo: { host: "git.example.com", path: "acme/*" }, pr: 5 });
  await eventually(async () => (await ofType(host, "workflow.run.finished")).length === 1, 20_000, "the record inside the installer's grant should start a run");
  type Birth = { run?: string; refused?: string };
  const births = async (): Promise<Birth[]> =>
    (await ofType(host, CORE_TYPES.stepOutcome))
      .map((row) => row.data as { outcome?: { value?: Birth } })
      .flatMap((data) => (data.outcome?.value === undefined ? [] : [data.outcome.value]));
  await eventually(async () => (await births()).filter((birth) => birth.refused !== undefined).length === 2, 20_000, "the other two should be refused");
  const refused = (await births()).flatMap((birth) => (birth.refused === undefined ? [] : [birth.refused]));
  expect(refused.some((why) => why.includes("forge.pr.merge@git.example.com/other/x/pr/*"))).toBe(true);
  expect(refused.some((why) => why.includes("{data.repo.path} is not one or more segments"))).toBe(true);
  const [run] = (await births()).flatMap((birth) => (birth.run === undefined ? [] : [birth.run]));
  expect(await runRules(host, run ?? "")).toEqual(["call:forge.pr.merge@git.example.com/acme/billing/pr/*", "emit:wf.*"]);
}, 30_000);
