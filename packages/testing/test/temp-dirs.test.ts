// The directories a test makes are removed when the process ends, however the test ended, and only
// the ones of this run: a run that is still alive keeps its own.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "./fixtures/temp-dirs-child.ts");

// The children get a temporary directory of their own, so the count of what they leave is exact.
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "niwa-temp-dirs-scratch-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function runChild(how: string): Promise<{ made: string[]; code: number | null }> {
  const child = Bun.spawn(["bun", CHILD, how], {
    env: { ...process.env, TMPDIR: scratch },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  return { made: out.split("\n").filter((line) => line !== ""), code };
}

const left = (): string[] => readdirSync(scratch).filter((name) => name.startsWith("niwa-test-"));

for (const how of ["exit", "cleaned", "throw", "term", "int"]) {
  test(`a process that ends by "${how}" leaves none of its directories`, async () => {
    const { made } = await runChild(how);
    expect(made).toHaveLength(3);
    expect(made.every((path) => path.startsWith(scratch))).toBe(true);
    expect(left()).toEqual([]);
  });
}

test("a killed process leaves its directories until the next run starts, which removes them", async () => {
  const { made } = await runChild("kill");
  expect(made.every((path) => existsSync(path))).toBe(true);

  // The directory of a run that is alive (this one) and a directory nobody owns are not touched.
  const alive = join(scratch, `niwa-test-${String(process.pid)}-alive-x`);
  const foreign = join(scratch, "niwa-test-notapid-x");
  mkdirSync(alive);
  mkdirSync(foreign);

  await runChild("exit");

  expect(made.some((path) => existsSync(path))).toBe(false);
  expect(existsSync(alive)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  rmSync(alive, { recursive: true });
  rmSync(foreign, { recursive: true });
});

test("`bun test` removes the directories of a test that failed before its cleanup", async () => {
  const leaky = join(import.meta.dir, "./fixtures/temp-dirs-leaky.ts");
  const run = Bun.spawn(["bun", "test", leaky], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, TMPDIR: scratch },
    stdout: "ignore",
    stderr: "pipe",
  });
  const report = await new Response(run.stderr).text();
  expect(await run.exited).not.toBe(0);
  expect(report).toContain("1 fail"); // It ran, and failed where it was meant to.
  expect(left()).toEqual([]);
});
