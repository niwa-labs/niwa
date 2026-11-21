// A call that could not start a command says so as a refusal, so nobody is left wondering whether
// the command ran.
//
// What it proves, for proc.run:
//   1. a sandbox that cannot run here, one that cannot express the box, and one whose wrapper
//      cannot be started each refuse the call as a ProcRefusal, which the caller catches and the
//      core does not record as a failure that may have had an effect
//   2. nothing was started, and no `proc.finished` was written
//   3. a sandbox whose policy lets a process reach a host, or one that reports no policy, cannot
//      run it, so the promise of the action is never made on its word; a box the sandbox cannot
//      hold is a refusal of its own, `box-refused`

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { CatchableError } from "@niwa-labs/core";
import { BoxRefused, SandboxUnavailable } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";

import { ProcRefusal } from "../src/index.ts";
import { absentSandbox, dirIn, heldPolicy, procActions, recordingSandbox } from "./support.ts";

type Bench = Awaited<ReturnType<typeof procActions>>;
const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.stop();
});

const sh = (script: string) => ["/bin/sh", "-c", script];

const unsupported: Sandbox = {
  ...recordingSandbox(),
  async launch() {
    throw new BoxRefused([{ code: "adapter", message: "reads are an allow-list there" }], "nono");
  },
};
const wrapperGone: Sandbox = {
  ...recordingSandbox(),
  async launch() {
    throw new SandboxUnavailable("nono", "the wrapper cannot be started");
  },
};

test("a sandbox whose policy does not keep a run off the network refuses the call before anything starts", async () => {
  const cases: Array<[Sandbox, RegExp]> = [
    [recordingSandbox(() => undefined), /does not say what a box lets a process reach/],
    [recordingSandbox((spec) => ({ ...heldPolicy(spec), net: ["example.com"] })), /lets a process reach example\.com/],
  ];
  for (const [sandbox, reason] of cases) {
    const bench = await procActions({ sandbox });
    benches.push(bench);
    const cwd = realpathSync(dirIn(bench.home, "work"));
    const error = await bench.call("proc.run", { cmd: sh("touch ran"), cwd, timeout: 10_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProcRefusal);
    expect((error as ProcRefusal).code).toBe("box-refused");
    expect((error as Error).message).toMatch(reason);
    expect(existsSync(join(cwd, "ran"))).toBe(false);
    expect(bench.emitted).toEqual([]);
  }
});

test("a box that cannot be had refuses the call before anything starts", async () => {
  for (const [sandbox, message, code] of [
    [absentSandbox, /sandbox nono is not available/, "no-sandbox"],
    [unsupported, /was refused/, "box-refused"],
    [wrapperGone, /the wrapper cannot be started/, "no-sandbox"],
  ] as const) {
    const bench = await procActions({ sandbox });
    benches.push(bench);
    const cwd = realpathSync(dirIn(bench.home, "work"));
    const error = await bench.call("proc.run", { cmd: sh("touch ran"), cwd, timeout: 10_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProcRefusal);
    expect(error).toBeInstanceOf(CatchableError);
    expect((error as ProcRefusal).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    expect(existsSync(join(cwd, "ran"))).toBe(false);
    expect(bench.emitted).toEqual([]);
  }
});
