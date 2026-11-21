// The process of a boxed launch.
//
// What it proves:
//   1. a boxed launch that asks to be detached leads its own process group, and a signal sent to
//      the process reaches the wrapper as that signal
//   2. a box's output is read at the pace of its reader
//   3. a clean-up that fails ends the process with an exit and an error, not an unhandled rejection
//   4. a listener that comes after the box ended is still told of the exit and the close
//   5. a relative path of a spec is read from its working directory, in the flags and in the check
//   6. a wrapper that is not there is `SandboxUnavailable`, not a bare ENOENT
//
// Only the public API is used: "@niwa-labs/sandbox".

import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SandboxUnavailable, SandboxUnsupported, boxSpec, nono, spawnAgent, srt, useSandbox } from "@niwa-labs/sandbox";
import type { AgentProcess, LaunchedBox, Sandbox } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

const undo: Array<() => void> = [];

afterEach(() => {
  for (const restore of undo.splice(0)) restore();
});

/** A wrapper that confines nothing: it drops its own flags and runs what follows `--`. */
async function passthroughBinary(dir: string): Promise<string> {
  const path = join(dir, "wrapper");
  await writeFile(path, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  await chmod(path, 0o755);
  return path;
}

async function boxed(program: string, args: string[], detached: boolean): Promise<AgentProcess> {
  const dir = await tempDir("box-process");
  undo.push(useSandbox("nono", nono({ binary: await passthroughBinary(dir) })));
  return await spawnAgent({
    harness: "t",
    program,
    args,
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    detached,
    box: { sandbox: "nono", spec: { cwd: dir } },
  });
}

function lines(child: AgentProcess): { next(): Promise<string> } {
  let text = "";
  const waiting: Array<() => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text += chunk;
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    async next() {
      while (!text.includes("\n")) await new Promise<void>((resolve) => waiting.push(resolve));
      const at = text.indexOf("\n");
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      return line;
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a detached boxed process leads its group, so a signal to the group reaches what it started", async () => {
  const child = await boxed("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], true);
  const output = lines(child);
  const grandchild = Number(await output.next());
  try {
    expect(alive(grandchild)).toBe(true);
    // The wrapper's own pid names the group: this throws ESRCH when the process is not its leader.
    process.kill(-child.pid!, "SIGKILL");
    for (let tries = 0; tries < 100 && alive(grandchild); tries++) await sleep(20);
    expect(alive(grandchild)).toBe(false);
  } finally {
    if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
  }
});

test("the signal given to kill reaches the boxed process", async () => {
  const child = await boxed("/bin/sh", ["-c", "trap 'echo got; exit 7' USR1; echo ready; while :; do sleep 0.1; done"], false);
  const output = lines(child);
  expect(await output.next()).toBe("ready");
  const codes: Array<number | null> = [];
  child.on("exit", (code) => codes.push(code));
  expect(child.kill("SIGUSR1")).toBe(true);
  expect(await output.next()).toBe("got");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  expect(codes).toEqual([7]);
});

/** A sandbox that runs nothing: its box is what the test makes of it. */
function fake(box: () => LaunchedBox): Sandbox {
  return {
    name: "nono",
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: "nono", cwd: spec.cwd, env: spec.env }),
    launch: async () => box(),
  };
}

const bytes = (size: number) => new Uint8Array(size).fill(97);
const inert = { write: () => undefined, end: () => undefined };

async function spawnFake(box: () => LaunchedBox): Promise<AgentProcess> {
  undo.push(useSandbox("nono", fake(box)));
  return await spawnAgent({ harness: "t", program: "unused", args: [], cwd: "/", box: { sandbox: "nono", spec: { cwd: "/" } } });
}

test("a box's output is read at the pace of its reader", async () => {
  const chunk = 8192;
  const chunks = 2000;
  let pulled = 0;
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (pulled > chunks) controller.close();
      else controller.enqueue(bytes(chunk));
    },
  });
  const child = await spawnFake(() => ({
    pid: 1,
    stdin: inert,
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.resolve(0),
    kill: () => undefined,
  }));
  // Nobody reads yet: only what the stream holds is taken from the box.
  await sleep(100);
  expect(pulled).toBeLessThan(50);

  let received = 0;
  child.stdout.on("data", (data: Buffer) => {
    received += data.length;
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  expect(received).toBe(chunk * chunks);
});

test("a clean-up that fails ends the process with an exit and an error, not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const hear = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", hear);
  try {
    const child = await spawnFake(() => ({
      pid: 1,
      stdin: inert,
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: Promise.reject(new Error("the settings could not be removed")),
      kill: () => undefined,
    }));
    const heard: string[] = [];
    child.on("exit", (code) => heard.push(`exit ${code}`));
    child.on("error", (error) => heard.push(`error ${error.message}`));
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await sleep(20);
    expect(heard).toEqual(["exit null", "error the settings could not be removed"]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", hear);
  }
});

test("a failed clean-up with nobody listening for errors does not throw", async () => {
  const child = await spawnFake(() => ({
    pid: 1,
    stdin: inert,
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.reject(new Error("gone")),
    kill: () => undefined,
  }));
  const code = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  expect(code).toBeNull();
});

test("a listener that comes after the box ended is told of the exit and the close", async () => {
  const child = await spawnFake(() => ({
    pid: 1,
    stdin: inert,
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.resolve(5),
    kill: () => undefined,
  }));
  const told = Promise.all([
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code))),
  ]);
  expect(await Promise.race([told, sleep(2000).then(() => "silent")])).toEqual([5, 5]);
  expect(child.exitCode).toBe(5);
});

test("relative paths of a spec are read from its working directory, for the flags and for the check", () => {
  const cwd = "/niwa-absent-base/work";
  expect(() => nono().manifest(boxSpec({ cwd, denyRead: ["secret"] }))).toThrow(SandboxUnsupported);
  expect(() => nono().manifest(boxSpec({ cwd, write: ["out"], denyRead: ["out/key"] }))).toThrow(SandboxUnsupported);
  // Away from the cwd it is not in the way, wherever the host is.
  expect(() => nono().manifest(boxSpec({ cwd, denyRead: ["../secret"] }))).not.toThrow();

  const flags = nono().manifest(boxSpec({ cwd, read: ["lib"], write: ["out"], sockets: ["run/host.sock"] })).flags;
  expect(flags).toEqual([
    "--silent",
    "--read", cwd,
    "--read", `${cwd}/lib`,
    "--allow", `${cwd}/out`,
    "--allow-unix-socket", `${cwd}/run/host.sock`,
    "--block-net",
  ]);

  const settings = srt().manifest(boxSpec({ cwd, write: ["out", "~/.claude"], denyRead: ["secret"], sockets: ["run/host.sock"] })).settings;
  expect(settings.filesystem).toEqual({
    denyRead: [{ path: `${cwd}/secret`, literal: true }],
    allowWrite: [
      { path: `${cwd}/out`, literal: true },
      { path: "~/.claude", literal: true },
    ],
    denyWrite: [],
  });
  expect(settings.network.allowUnixSockets).toEqual([`${cwd}/run/host.sock`]);
});

test("a relative working directory is resolved once, against the host's", () => {
  const manifest = nono().manifest(boxSpec({ cwd: "work", write: ["out"] }));
  expect(manifest.cwd).toBe(resolve("work"));
  expect(manifest.flags).toContain(resolve("work", "out"));
});

test("a wrapper that is not there is SandboxUnavailable, and a working directory that is not there is not", async () => {
  const spec = boxSpec({ cwd: await tempDir("box-missing") });
  await expect(nono({ binary: "/nonexistent/nono" }).launch(spec, ["true"])).rejects.toBeInstanceOf(SandboxUnavailable);
  await expect(srt({ command: ["/nonexistent/srt"] }).launch(spec, ["true"])).rejects.toBeInstanceOf(SandboxUnavailable);

  const present = nono({ binary: await passthroughBinary(await tempDir("box-wrapper")) });
  const failure = await present.launch(boxSpec({ cwd: "/niwa-absent-base/work" }), ["true"]).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SandboxUnavailable);
});
