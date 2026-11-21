// proc.run: a command in a box, how it ends, and where its output goes.
//
// What it proves:
//   1. a run's box writes its cwd and a temp directory in it, has no network and no host environment
//      but the real HOME, and closes niwa's keys, journal and secrets; it fits nono even for a cwd
//      inside the niwa home
//   2. the exit code, and the output of both streams, come back; a failing exit is a result
//   3. a command that runs too long is stopped with what it started
//   4. a background child that outlives its parent does not hold the run
//   5. the whole output is an artifact; the result and the record carry only a bounded tail
//   6. a box that cannot run stops the call before any process exists
//   7. the box a run and its record name is its manifest, with the policy the sandbox reports it applies
//   8. a run's temp directory is inside its cwd and gone after it; a run is refused where it cannot have one
//   9. a run reads the toolchains by default, takes the profiles it asks for, and finds the places of every
//      other profile, an installation's among them, closed; a host it asks for is refused

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { nono, sandbox } from "@niwa-labs/sandbox";
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

test("a run's box writes its cwd and a temp directory in it, reaches nothing, and holds no host environment but HOME", async () => {
  const sandbox = recordingSandbox();
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  process.env["NIWA_ID"] = "leaked-session";
  process.env["GITLAB_TOKEN"] = "leaked-token";
  try {
    const result = await host.niwa.call(procRun, { cmd: sh("env"), cwd, timeout: 10_000, env: { MODE: "ci" } });
    const [spec] = sandbox.specs;
    expect(sandbox.specs).toHaveLength(1);
    const temp = spec?.env["TMPDIR"] ?? "";
    expect(temp.startsWith(`${cwd}/`)).toBe(true);
    expect(spec?.write.map(String).sort()).toEqual([cwd, temp].sort());
    expect(spec?.net).toEqual([]);
    expect(Object.keys(spec?.env ?? {}).sort()).toEqual(["HOME", "MODE", "PATH", "TEMP", "TMP", "TMPDIR"]);
    expect(spec?.env["HOME"]).toBe(homedir());
    const home = realpathSync(host.home);
    expect(spec?.closed.map(String)).toEqual(
      expect.arrayContaining([join(home, "owner.token"), join(home, "host.key"), join(home, "journal.db"), join(home, "secrets"), join(realpathSync(homedir()), ".ssh")]),
    );
    expect(result.box.request).toEqual({ mode: "allow", items: [{ item: "toolchains", from: "host" }] });
    expect(result.box.paths).toContainEqual({ path: cwd, mode: "write", from: "cwd" });
    expect(result.box.paths).toContainEqual({ path: temp, mode: "write", from: "temp" });
    expect(result.box.env.sort()).toEqual(["HOME", "MODE", "PATH", "TEMP", "TMP", "TMPDIR"]);
    const seen = outputOf(host, result.output);
    expect(seen).toContain("MODE=ci");
    expect(seen).not.toContain("leaked");
  } finally {
    delete process.env["NIWA_ID"];
    delete process.env["GITLAB_TOKEN"];
  }
});

test("the box a run and its record name carries the policy the sandbox applies, not the spec it was given", async () => {
  const sandbox = recordingSandbox((spec) => ({
    write: [...spec.write, join(spec.cwd, ".own")],
    devices: ["/dev/null", "/dev/tty"],
    read: { only: [spec.cwd, "/opt/tool"] },
    net: [],
  }));
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  const result = await host.niwa.call(procRun, { cmd: sh("true"), cwd, timeout: 10_000 });
  expect(result.box.policy.write).toContain(join(cwd, ".own"));
  expect(result.box.policy.devices).toEqual(["/dev/null", "/dev/tty"]);
  expect(result.box.policy.read).toEqual({ only: [cwd, "/opt/tool"] });
  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect((finished[0]?.data as { box?: unknown }).box).toEqual(result.box);
});

test("a run has the real home and a temp directory of its own inside its cwd, and nothing of it is left behind", async () => {
  const sandbox = recordingSandbox();
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  const result = await host.niwa.call(procRun, {
    cmd: sh('echo "$HOME"; echo "$TMPDIR"; echo "$TMP"; echo "$TEMP"; touch "$TMPDIR/scratch"'),
    cwd,
    timeout: 10_000,
  });
  expect(result.exit).toBe(0);
  const [home, temp, tmp, tempToo] = outputOf(host, result.output).trim().split("\n");
  expect(home).toBe(homedir());
  expect(temp?.startsWith(`${cwd}/`)).toBe(true);
  expect([tmp, tempToo]).toEqual([temp, temp]);
  expect(existsSync(temp as string)).toBe(false);
  expect(readdirSync(cwd)).toEqual([]);

  // A call that names its own TMPDIR keeps it, and nothing is left behind either.
  const named = await host.niwa.call(procRun, { cmd: sh('echo "$TMPDIR"'), cwd, timeout: 10_000, env: { TMPDIR: "/somewhere" } });
  expect(outputOf(host, named.output).trim()).toBe("/somewhere");
  expect(readdirSync(cwd)).toEqual([]);
});

test("a run in a directory it cannot write is refused: it would have no temp directory", async () => {
  const host = await start({ sandbox: recordingSandbox() });
  const cwd = realpathSync(dirIn(host.home, "work"));
  chmodSync(cwd, 0o555);
  try {
    const error = await host.niwa.call(procRun, { cmd: sh("true"), cwd, timeout: 10_000 }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(String(error)).toContain("cannot be written");
  } finally {
    chmodSync(cwd, 0o755);
  }
});

test("a run reads the toolchains by default, and `only` replaces them", async () => {
  const base = realpathSync(mkdtempSync(join(homedir(), ".niwa-proc-path-")));
  const tools = dirIn(base, "bin");
  const saved = process.env["PATH"];
  process.env["PATH"] = `${tools}:relative:${homedir()}:/usr/bin`;
  try {
    const sandbox = recordingSandbox();
    const host = await start({ sandbox });
    const cwd = realpathSync(dirIn(host.home, "work"));
    await host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000 });
    expect(sandbox.specs[0]?.read.map(String)).toEqual(expect.arrayContaining([tools, "/usr/bin"]));
    expect(sandbox.specs[0]?.read.map(String)).not.toContain(realpathSync(homedir()));
    await host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000, box: { only: [] } });
    expect(sandbox.specs[1]?.read).toEqual([]);
  } finally {
    process.env["PATH"] = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("a run takes the profiles it asks for, and the places of every other profile, an installation's among them, are closed", async () => {
  const base = realpathSync(mkdtempSync(join(homedir(), ".niwa-proc-profiles-")));
  try {
    const boxes = sandbox({ profiles: { tool: { write: [join(base, "tool-cache")] } } });
    boxes.install("codex-luna", { write: [join(base, "codex-home")] });
    const recording = recordingSandbox();
    const host = await start({ sandbox: recording, boxes });
    const cwd = realpathSync(dirIn(host.home, "work"));
    const result = await host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000, box: { allow: ["tool"] } });
    expect(result.box.paths).toContainEqual({ path: join(base, "tool-cache"), mode: "write", from: "profile:tool" });
    expect(result.box.closed).toContainEqual({ path: join(base, "codex-home"), from: "harness:codex-luna" });
    expect(recording.specs[0]?.write.map(String)).toContain(join(base, "tool-cache"));

    await host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000 });
    expect(recording.specs[1]?.closed.map(String)).toEqual(expect.arrayContaining([join(base, "tool-cache"), join(base, "codex-home")]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a run that asks for a host, or for a place another profile keeps, is refused before anything starts", async () => {
  const sandbox = recordingSandbox();
  const host = await start({ sandbox });
  const cwd = realpathSync(dirIn(host.home, "work"));
  const error = await host.niwa.call(procRun, { cmd: sh("true"), cwd, timeout: 10_000, box: { allow: [{ net: "registry.npmjs.org" }, { read: "~/.npmrc" }] } }).then(
    () => undefined,
    (thrown: unknown) => String(thrown),
  );
  expect(error).toContain("registry.npmjs.org cannot be reached: this box reaches no network");
  expect(error).toContain("take the profile npm");
  expect(sandbox.specs).toEqual([]);
});

test("the box of a run inside the niwa home, where worktrees live, is one nono can express", async () => {
  const sandbox = recordingSandbox();
  // A home under the user's home, as the host's is.
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
  expect(data["tail"]).toBe(result.tail);
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
