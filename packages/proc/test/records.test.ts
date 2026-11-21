// The declarations of the proc actions: what a call may say, and the class each action claims.

import { expect, test } from "bun:test";

import { secret } from "@niwa-labs/core";

import { procExec, procRun } from "../src/records.ts";
import { procHost } from "./support.ts";

const base = { cmd: ["true"], cwd: "/tmp", timeout: 1000 };

test("a run takes plain environment values only: a secret reference is refused", () => {
  expect(procRun.input.safeParse({ ...base, env: { A: "1" } }).success).toBe(true);
  expect(procRun.input.safeParse({ ...base, env: { A: secret("TOKEN") } }).success).toBe(false);
});

test("an exec takes a secret reference where a run does not", () => {
  expect(procExec.input.safeParse({ ...base, env: { A: secret("TOKEN") }, secrets: ["TOKEN"], net: true }).success).toBe(true);
});

test("a call needs an absolute directory, a program and a timeout inside the limit", () => {
  expect(procRun.input.safeParse({ ...base, cwd: "relative" }).success).toBe(false);
  expect(procRun.input.safeParse({ ...base, cmd: [] }).success).toBe(false);
  expect(procRun.input.safeParse({ ...base, cmd: [""] }).success).toBe(false);
  expect(procRun.input.safeParse({ ...base, timeout: 0 }).success).toBe(false);
  expect(procRun.input.safeParse({ ...base, timeout: 3_600_001 }).success).toBe(false);
  expect(procExec.input.safeParse({ ...base, extra: 1 }).success).toBe(false);
});

test("a secret reference names a variable-like secret", () => {
  expect(() => secret("has space")).toThrow();
  expect(secret("DEPLOY_KEY")).toEqual({ secret: "DEPLOY_KEY" });
});

test("run is a write in the local world, exec an irreversible one in the external world, as the host describes them", async () => {
  const host = await procHost();
  try {
    const actions = (await host.niwa.describe()).actions.filter((one) => one.name.startsWith("proc."));
    expect(actions.map(({ name, effect, world }) => ({ name, effect, world }))).toEqual([
      { name: "proc.run", effect: "write", world: "local" },
      { name: "proc.exec", effect: "irreversible", world: "external" },
    ]);
  } finally {
    await host.stop();
  }
});
