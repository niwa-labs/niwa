// A call that could not start a command says so as a refusal, so nobody is left wondering whether
// the command ran.
//
// What it proves, for proc.run:
//   1. a sandbox that cannot run here, one that cannot express the box, and one whose wrapper
//      cannot be started each refuse the call as a ProcRefusal, which the caller catches and the
//      core does not record as a failure that may have had an effect
//   2. nothing was started, and no `proc.finished` was written
//   3. a sandbox that does not keep writes to the cwd and reads to an allow-list (srt, or one that
//      says nothing) cannot run it, so the promise of the action is never made on its word

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { CatchableError } from "@niwa-labs/core";
import { SandboxUnavailable, SandboxUnsupported, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";

import { ProcRefusal } from "../src/index.ts";
import { absentSandbox, dirIn, procActions, recordingSandbox } from "./support.ts";

type Bench = Awaited<ReturnType<typeof procActions>>;
const benches: Bench[] = [];
afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.stop();
});

const sh = (script: string) => ["/bin/sh", "-c", script];

const unsupported: Sandbox = {
  ...recordingSandbox(),
  async launch() {
    throw new SandboxUnsupported("nono", "reads are an allow-list there");
  },
};
const wrapperGone: Sandbox = {
  ...recordingSandbox(),
  async launch() {
    throw new SandboxUnavailable("nono", "the wrapper cannot be started");
  },
};

test("a sandbox that does not hold writes and reads to the lists of the spec refuses the call before anything starts", async () => {
  const { guarantees: _kept, ...silent } = recordingSandbox();
  const writesOnly: Sandbox = { ...recordingSandbox(), guarantees: { exactWrites: true, closedReads: false } };
  const readsOnly: Sandbox = { ...recordingSandbox(), guarantees: { exactWrites: false, closedReads: true } };
  for (const sandbox of [silent, writesOnly, readsOnly, srt()]) {
    const bench = await procActions({ sandbox });
    benches.push(bench);
    const cwd = realpathSync(dirIn(bench.home, "work"));
    const error = await bench.call("proc.run", { cmd: sh("touch ran"), cwd, timeout: 10_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProcRefusal);
    expect((error as ProcRefusal).code).toBe("no-sandbox");
    expect((error as Error).message).toMatch(/keep writes to the directory and reads to an allow-list/);
    expect(existsSync(join(cwd, "ran"))).toBe(false);
    expect(bench.emitted).toEqual([]);
  }
});

test("a box that cannot be had refuses the call before anything starts", async () => {
  for (const [sandbox, message] of [
    [absentSandbox, /sandbox nono is not available/],
    [unsupported, /cannot express this spec/],
    [wrapperGone, /the wrapper cannot be started/],
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
    expect((error as ProcRefusal).code).toBe("no-sandbox");
    expect((error as Error).message).toMatch(message);
    expect(existsSync(join(cwd, "ran"))).toBe(false);
    expect(bench.emitted).toEqual([]);
  }
});
