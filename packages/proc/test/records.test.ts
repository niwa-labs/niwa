// The declarations of the proc actions: what a call may say, and the class each action claims.

import { expect, test } from "bun:test";

import { PROC_EXEC_CLASS, PROC_RUN_CLASS, procExec, procRun, secret } from "../src/records.ts";

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

test("a call is about its real directory, so a link cannot name another place", () => {
  expect(procRun.target?.({ ...base, cwd: "/tmp" } as never)).toBe(procRun.target?.({ ...base, cwd: "/private/tmp" } as never));
});

test("run is a write in the local world, exec an irreversible one in the external world", () => {
  expect(PROC_RUN_CLASS).toEqual({ effect: "write", world: "local" });
  expect(PROC_EXEC_CLASS).toEqual({ effect: "irreversible", world: "external" });
});
