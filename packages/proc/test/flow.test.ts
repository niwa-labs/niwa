// runCheck in a real script: the check runs with proc.run, passes on a zero exit, and reads the
// report the command printed at the end of its output.

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa, requests, tempHome, timers, workflow } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { proc } from "../src/index.ts";
import { reportOf } from "../src/flow.ts";
import { recordingSandbox } from "./support.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 30_000);

/** Run a script that imports `@niwa-labs/proc/flow`, on a host with the proc module, and answer its result. */
async function runScript(source: string): Promise<{ result: unknown; sandbox: ReturnType<typeof recordingSandbox>; work: string }> {
  const temp = await tempHome();
  const home = realpathSync(temp.path);
  const sandbox = recordingSandbox();
  const host: Host = createNiwa({ home });
  host.use(requests(), timers([]), proc({ sandbox }), workflow());
  await host.serve();
  cleanups.push(async () => {
    await host.close().catch(() => {});
    await temp.cleanup();
  });
  const src = join(home, "src");
  const work = join(home, "work");
  await mkdir(join(src, "node_modules", "@niwa-labs"), { recursive: true });
  await mkdir(work, { recursive: true });
  await symlink(realpathSync(join(import.meta.dir, "..")), join(src, "node_modules", "@niwa-labs", "proc"), "dir");
  await writeFile(join(src, "check.ts"), source.replaceAll("$WORK", work));
  const ended = (await host.call("workflow.start" as never, { file: join(src, "check.ts"), wait: true, timeoutMs: 30_000 } as never)) as {
    state: string;
    outcome?: { status: string; result?: unknown };
  };
  if (ended.outcome?.status !== "done") throw new Error(`the run did not finish: ${JSON.stringify(ended).slice(0, 1500)}`);
  return { result: ended.outcome.result, sandbox, work };
}

test("a check passes on a zero exit, fails on another, and gives the report it printed last", async () => {
  const { result, sandbox, work } = await runScript(`
    import { runCheck } from "@niwa-labs/proc/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const good = await runCheck("good", { cmd: ["sh", "-c", "echo testing; echo '{\\"coverage\\": 0.8}'"], cwd: "$WORK", timeout: "1m", report: "json" });
      const bad = await runCheck("bad", { cmd: ["sh", "-c", "echo it broke; exit 3"], cwd: "$WORK" });
      return { good: { ok: good.ok, exit: good.exit, report: good.report, artifact: typeof good.artifact.digest }, bad: { ok: bad.ok, exit: bad.exit, summary: bad.summary } };
    });`);
  expect(result).toEqual({
    good: { ok: true, exit: 0, report: { coverage: 0.8 }, artifact: "string" },
    bad: { ok: false, exit: 3, summary: "exited with 3\nit broke" },
  });
  expect(sandbox.specs.map((spec) => spec.cwd)).toEqual([work, work]);
}, 30_000);

test("a report is read from the end of the output: JSON on the last line, lcov totals, JUnit suite counts", () => {
  expect(reportOf("json", "noise\n{\"total\": 3}\n")).toEqual({ total: 3 });
  expect(reportOf("json", "no report here")).toBeUndefined();
  expect(reportOf("lcov", "SF:a.ts\nLF:10\nLH:5\nend_of_record\nSF:b.ts\nLF:10\nLH:10\nend_of_record\n")).toEqual({ found: 20, hit: 15, coverage: 0.75 });
  expect(reportOf("junit", '<testsuite name="a" tests="4" failures="1" errors="0"></testsuite><testsuite tests="2" failures="0" errors="1" skipped="1">')).toEqual({
    tests: 6,
    failures: 1,
    errors: 1,
    skipped: 1,
  });
});
