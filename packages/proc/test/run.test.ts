// proc.run: a command in a box, how it ends, and where its output goes.
//
// What it proves:
//   1. the box a run asks for writes only in the cwd, has no network and no host environment, and
//      closes the keys of the host; the spec fits nono even for a cwd inside the niwa home
//   2. the exit code, and the output of both streams, come back; a failing exit is a result
//   3. a command that runs too long is stopped with what it started
//   4. a background child that outlives its parent does not hold the run
//   5. the whole output is an artifact; the result and the record carry only a bounded tail
//   6. a box that cannot run stops the call before any process exists
//   7. the box a run and its record name is the policy the sandbox reports it applies

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { nono } from "@niwa-labs/sandbox";
import { eventually } from "@niwa-labs/testing";

import { procRun } from "../src/index.ts";
import type { ProcResult } from "../src/index.ts";
import { absentSandbox, alive, dirIn, outputOf, procHost, recordingSandbox } from "./support.ts";

type Host = Awaited<ReturnType<typeof procHost>>;
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function start(options: Parameters<typeof procHost>[0] = {}, at?: string): Promise<Host> {
  const host = await procHost(options, at);
  hosts.push(host);
  return host;
}

const sh = (script: string) => ["/bin/sh", "-c", script];

test("a run asks for a box that writes only in its cwd, reaches nothing, and holds no host environment", async () => {
  const sandbox = recordingSandbox();
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  process.env["NIWA_ID"] = "leaked-session";
  process.env["GITLAB_TOKEN"] = "leaked-token";
  try {
    const result = await host.niwa.call(procRun, { cmd: sh("env"), cwd, timeout: 10_000, env: { MODE: "ci" } });
    const [spec] = sandbox.specs;
    expect(sandbox.specs).toHaveLength(1);
    expect(spec?.write).toEqual([cwd]);
    expect(spec?.net).toEqual([]);
    expect(Object.keys(spec?.env ?? {}).sort()).toEqual(["HOME", "MODE", "PATH", "TMPDIR"]);
    const home = realpathSync(host.home);
    expect(spec?.denyRead).toEqual(expect.arrayContaining([join(home, "owner.token"), join(home, "host.key"), join(home, "secrets")]));
    expect(result.box).toEqual({ sandbox: "nono", write: [cwd], devices: ["/dev/null"], read: [cwd, "/usr/lib"], net: [] });
    const seen = outputOf(host, result.output);
    expect(seen).toContain("MODE=ci");
    expect(seen).not.toContain("leaked");
  } finally {
    delete process.env["NIWA_ID"];
    delete process.env["GITLAB_TOKEN"];
  }
});

test("the box a run and its record name is the policy the sandbox applies, not the spec it was given", async () => {
  const sandbox = recordingSandbox((spec) => ({
    write: [...spec.write, join(spec.cwd, ".own")],
    devices: ["/dev/null", "/dev/tty"],
    read: { only: [spec.cwd, "/opt/tool"] },
    net: [],
  }));
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  const result = await host.niwa.call(procRun, { cmd: sh("true"), cwd, timeout: 10_000 });
  const box = { sandbox: "nono", write: [cwd, join(cwd, ".own")], devices: ["/dev/null", "/dev/tty"], read: [cwd, "/opt/tool"], net: [] };
  expect(result.box).toEqual(box);
  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect((finished[0]?.data as { box?: unknown }).box).toEqual(box);
});

test("a run has a TMPDIR inside its cwd, the one place its box lets it write, and nothing of it is left behind", async () => {
  const sandbox = recordingSandbox();
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  const result = await host.niwa.call(procRun, { cmd: sh('echo "$TMPDIR"; touch "$TMPDIR/scratch"'), cwd, timeout: 10_000 });
  const temp = outputOf(host, result.output).trim();
  expect(result.exit).toBe(0);
  expect(temp.startsWith(`${cwd}/`)).toBe(true);
  expect(sandbox.specs[0]?.env["TMPDIR"]).toBe(temp);
  expect(existsSync(temp)).toBe(false);
  expect(readdirSync(cwd)).toEqual([]);

  // A call that names its own TMPDIR keeps it, and no directory is made.
  const named = await host.niwa.call(procRun, { cmd: sh('echo "$TMPDIR"'), cwd, timeout: 10_000, env: { TMPDIR: "/somewhere" } });
  expect(outputOf(host, named.output).trim()).toBe("/somewhere");
  expect(readdirSync(cwd)).toEqual([]);
});

test("the box of a run inside the niwa home, where worktrees live, is one nono can express", async () => {
  const sandbox = recordingSandbox();
  // A home under the user's home, as the host's is: nono grants the temp area on its own, so it
  // cannot close the host's keys there.
  const host = await start({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
  const cwd = dirIn(host.home, "worktrees", "wt-1");
  await host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000 });
  const [spec] = sandbox.specs;
  if (spec === undefined) throw new Error("no box was asked for");
  expect(() => nono().manifest(spec)).not.toThrow();
});

test("a failing exit is a result with its code, and both streams are in the output", async () => {
  const host = await start({ sandbox: recordingSandbox() });
  const cwd = dirIn(host.home, "work");
  const result: ProcResult = await host.niwa.call(procRun, { cmd: sh("echo out; echo err >&2; exit 3"), cwd, timeout: 10_000 });
  expect(result.outcome).toBe("exited");
  expect(result.exit).toBe(3);
  expect(result.tail).toContain("out");
  expect(result.tail).toContain("err");
  const stored = outputOf(host, result.output);
  expect(stored.split("\n").sort()).toEqual(["", "err", "out"]);
});

test("a run that outlasts its timeout is stopped, with the child it started", async () => {
  const host = await start({ sandbox: recordingSandbox(), killGraceMs: 200 });
  const cwd = dirIn(host.home, "work");
  const pidFile = join(cwd, "child.pid");
  const began = Date.now();
  const result = await host.niwa.call(procRun, { cmd: sh(`sleep 60 & echo $! > child.pid; wait`), cwd, timeout: 400 });
  expect(result.outcome).toBe("timed-out");
  expect(result.exit).toBeNull();
  expect(Date.now() - began).toBeLessThan(10_000);
  const child = Number(readFileSync(pidFile, "utf8"));
  await eventually(() => !alive(child), 5_000, "the child should be gone");
});

test("a command that traps the stop signal is killed once its grace is over", async () => {
  const host = await start({ sandbox: recordingSandbox(), killGraceMs: 200 });
  const cwd = dirIn(host.home, "work");
  const result = await host.niwa.call(procRun, { cmd: sh("trap '' TERM; while :; do sleep 1; done"), cwd, timeout: 300 });
  expect(result.outcome).toBe("timed-out");
});

test("a background child left behind does not hold the run, and does not survive it", async () => {
  const host = await start({ sandbox: recordingSandbox() });
  const cwd = dirIn(host.home, "work");
  const began = Date.now();
  const result = await host.niwa.call(procRun, { cmd: sh("sleep 60 & echo $! > child.pid; echo hi"), cwd, timeout: 30_000 });
  expect(result.outcome).toBe("exited");
  expect(result.exit).toBe(0);
  expect(Date.now() - began).toBeLessThan(10_000);
  expect(result.tail).toBe("hi\n");
  const child = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
  await eventually(() => !alive(child), 5_000, "the child should be gone");
});

test("the output is an artifact: the result and the record keep only a bounded tail", async () => {
  const host = await start({ sandbox: recordingSandbox(), tailBytes: 64 });
  const cwd = dirIn(host.home, "work");
  const result = await host.niwa.call(procRun, { cmd: sh("i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done"), cwd, timeout: 20_000 });
  const whole = outputOf(host, result.output);
  expect(whole.startsWith("line-0\n")).toBe(true);
  expect(whole.endsWith("line-4999\n")).toBe(true);
  expect(result.output.size).toBe(Buffer.byteLength(whole));
  expect(result.tail.length).toBeLessThanOrEqual(64);
  expect(whole.endsWith(result.tail)).toBe(true);

  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect(finished).toHaveLength(1);
  const data = finished[0]?.data as Record<string, unknown>;
  expect(JSON.stringify(data).length).toBeLessThan(1500);
  expect(data).toMatchObject({ action: "proc.run", cwd: realpathSync(cwd), program: "/bin/sh", exit: 0, output: result.output });
});

test("a box that cannot run stops the call before a process exists", async () => {
  const host = await start({ sandbox: absentSandbox });
  const cwd = dirIn(host.home, "work");
  const marker = join(cwd, "ran");
  await expect(host.niwa.call(procRun, { cmd: sh(`touch ${marker}`), cwd, timeout: 10_000 })).rejects.toThrow(/sandbox nono is not available/);
  await Bun.sleep(100);
  expect(existsSync(marker)).toBe(false);
  expect((await host.niwa.records.read()).filter((row) => row.type === "proc.finished")).toEqual([]);
});

test("a directory that is not there is refused", async () => {
  const host = await start({ sandbox: recordingSandbox() });
  await expect(host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd: join(host.home, "nowhere"), timeout: 1000 })).rejects.toThrow(/does not exist/);
  writeFileSync(join(host.home, "file"), "");
  await expect(host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd: join(host.home, "file"), timeout: 1000 })).rejects.toThrow(/not a directory/);
});
