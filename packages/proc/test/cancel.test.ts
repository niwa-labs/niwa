// A call cancelled while it runs: the command is stopped, with what it started, and the record says so.
//
// What it proves, for proc.run and proc.exec:
//   1. a call cancelled before the command starts, even while the sandbox is being probed, starts nothing
//   2. a call cancelled while the command runs stops it and its children, and `proc.finished` says
//      the command was cancelled

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { eventually } from "@niwa-labs/testing";

import { absentSandbox, alive, dirIn, procActions, recordingSandbox } from "./support.ts";

type Bench = Awaited<ReturnType<typeof procActions>>;
const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.stop();
});

async function start(options: Parameters<typeof procActions>[0] = {}): Promise<Bench> {
  const bench = await procActions({ killGraceMs: 200, ...options });
  benches.push(bench);
  return bench;
}

const sh = (script: string) => ["/bin/sh", "-c", script];

test("a call cancelled before it starts starts nothing", async () => {
  const sandbox = recordingSandbox();
  const bench = await start({ sandbox });
  const cwd = realpathSync(dirIn(bench.home, "work"));
  const gone = new AbortController();
  gone.abort("stopped by the owner");
  for (const name of ["proc.run", "proc.exec"] as const) {
    await expect(bench.call(name, { cmd: sh("touch ran"), cwd, timeout: 10_000 }, gone.signal)).rejects.toBeDefined();
  }
  await Bun.sleep(100);
  expect(existsSync(join(cwd, "ran"))).toBe(false);
  expect(sandbox.specs).toEqual([]);
  expect(bench.emitted).toEqual([]);
});

test("a call cancelled while the sandbox is being probed does not start the command", async () => {
  const gone = new AbortController();
  const base = recordingSandbox();
  const sandbox = {
    ...base,
    available: async () => {
      await Bun.sleep(50);
      gone.abort("stopped by the owner");
      return true;
    },
  };
  const bench = await start({ sandbox });
  const cwd = realpathSync(dirIn(bench.home, "work"));
  await expect(bench.call("proc.run", { cmd: sh("touch ran"), cwd, timeout: 10_000 }, gone.signal)).rejects.toBeDefined();
  await Bun.sleep(100);
  expect(existsSync(join(cwd, "ran"))).toBe(false);
  expect(base.specs).toEqual([]);
});

test("a call cancelled while its command runs stops it with its children, and the record says it was cancelled", async () => {
  for (const name of ["proc.run", "proc.exec"] as const) {
    const bench = await start({ sandbox: name === "proc.run" ? recordingSandbox() : absentSandbox });
    const cwd = realpathSync(dirIn(bench.home, `work-${name}`));
    const gone = new AbortController();
    const began = Date.now();
    const running = bench.call(name, { cmd: sh("sleep 60 & echo $! > child.pid; wait"), cwd, timeout: 60_000 }, gone.signal);
    await eventually(() => existsSync(join(cwd, "child.pid")), 5_000, "the command should have started");
    gone.abort("stopped by the owner");
    const result = await running;
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result.outcome).toBe("cancelled");
    expect(result.exit).toBeNull();
    const child = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    await eventually(() => !alive(child), 5_000, "the child should be gone");
    expect(bench.emitted.map((row) => [row.type, row.data["outcome"]])).toEqual([["proc.finished", "cancelled"]]);
  }
});
