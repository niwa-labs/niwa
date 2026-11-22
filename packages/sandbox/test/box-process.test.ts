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
//   7. a reader that closes its end does not keep the process from closing
//   8. a launch that fails behind the returned process is told to a late listener, and never throws
//   9. a process ended by a signal reports the signal and no code; an exit with a signal's code is a code
//
// Only the public API is used: "@niwa-labs/sandbox".

import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SandboxUnavailable, BoxRefused, boxSpec, nono, spawnAgent, spawnAgentNow, srt, useSandbox } from "@niwa-labs/sandbox";
import type { AgentProcess, LaunchedBox, Sandbox } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

const undo: Array<() => void> = [];

afterEach(() => {
  for (const restore of undo.splice(0)) restore();
});

/** A wrapper that confines nothing: it drops its own flags and runs what follows `--`. */
async function passthroughBinary(dir: string): Promise<string> {
  const path = join(dir, "wrapper");
  // Asked how it resolves its profile, it grants nothing; asked to run, it runs what follows `--`.
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = profile ]; then echo \'{"filesystem":{"grants":[]}}\'; exit 0; fi\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
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

test("a direct boxed launch must confirm its exact TCP listener before probing or spawning", async () => {
  let probed = false;
  let spawned = false;
  const adapter = {
    ...fake(() => {
      spawned = true;
      throw new Error("a refused launch must not spawn");
    }),
    available: async () => {
      probed = true;
      return true;
    },
  };
  const launch = {
    harness: "server",
    program: "/bin/sh",
    args: [],
    box: { sandbox: adapter, spec: { cwd: "/", listen: { host: "127.0.0.1", port: 0, from: "harness:server" } } },
  } as const;
  await expect(spawnAgent(launch)).rejects.toThrow(BoxRefused);
  const child = spawnAgentNow(launch);
  const error = await new Promise<Error>((resolve) => child.once("error", resolve));
  expect(error).toBeInstanceOf(BoxRefused);
  expect(error.message).toContain("exact listener on TCP 127.0.0.1:0");
  expect(probed).toBe(false);
  expect(spawned).toBe(false);
});

const bytes = (size: number) => new Uint8Array(size).fill(97);
const inert = { write: () => undefined, end: () => undefined };

async function spawnFake(box: () => LaunchedBox): Promise<AgentProcess> {
  undo.push(useSandbox("nono", fake(box)));
  return await spawnAgent({ harness: "t", program: "unused", args: [], cwd: "/", box: { sandbox: "nono", spec: { cwd: "/" } } });
}

test("boxed input waits for its sink before forwarding the next write or EOF", async () => {
  const writing = Promise.withResolvers<void>();
  const firstWrite = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<number>();
  const accepted: string[] = [];
  const adapter = fake(() => ({
    pid: 1,
    stdin: {
      write(data) {
        accepted.push(Buffer.from(data).toString());
        if (accepted.length === 1) {
          writing.resolve();
          return firstWrite.promise;
        }
      },
      end() { accepted.push("EOF"); },
    },
    stdout: new ReadableStream({ start: (controller) => controller.close() }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: exit.promise,
    kill: () => undefined,
  }));
  const child = spawnAgentNow({ harness: "t", program: "unused", args: [], cwd: "/", box: { sandbox: adapter, spec: { cwd: "/" } } });
  const completed: string[] = [];
  child.stdin.write("first", () => completed.push("first"));
  child.stdin.write("second", () => completed.push("second"));
  const finished = new Promise<void>((resolve) => child.stdin.end(resolve));
  expect(accepted).toEqual([]);
  await writing.promise;
  expect(accepted).toEqual(["first"]);
  expect(completed).toEqual([]);
  expect(child.stdin.writableLength).toBe("firstsecond".length);
  firstWrite.resolve();
  await finished;
  expect(accepted).toEqual(["first", "second", "EOF"]);
  expect(completed).toEqual(["first", "second"]);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  exit.resolve(0);
  await closed;
});

test("exit fails boxed input in flight and buffers before sandbox cleanup completes", async () => {
  const sink = Promise.withResolvers<void>();
  const processEnded = Promise.withResolvers<number>();
  const cleanupDone = Promise.withResolvers<number>();
  let attempts = 0;
  const child = await spawnFake(() => ({
    pid: 1,
    stdin: { write: () => { attempts++; return sink.promise; }, end: () => undefined },
    stdout: new ReadableStream({ start: (controller) => controller.close() }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    ended: processEnded.promise,
    exited: cleanupDone.promise,
    kill: () => undefined,
  }));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const pending = ["first", "second"].map((text) => new Promise((resolve) => child.stdin.write(text, resolve)));
  expect(attempts).toBe(1);
  processEnded.resolve(0);
  for (const error of await Promise.all(pending)) expect(error).toMatchObject({ code: "EPIPE" });
  expect(attempts).toBe(1);
  // The sink may still fail once it observes the closed pipe. Its rejection is consumed.
  sink.reject(new Error("the underlying sink closed"));
  cleanupDone.resolve(0);
  await closed;
});

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
  expect(() => nono().manifest(boxSpec({ cwd, closed: ["secret"] }))).toThrow(BoxRefused);
  expect(() => nono().manifest(boxSpec({ cwd, write: ["out"], closed: ["out/key"] }))).toThrow(BoxRefused);
  // Away from the cwd it is not in the way, wherever the host is.
  expect(() => nono().manifest(boxSpec({ cwd, closed: ["../secret"] }))).not.toThrow();

  const flags = nono().manifest(boxSpec({ cwd, read: ["lib"], write: ["out"], sockets: ["run/host.sock"] })).flags;
  expect(flags).toEqual([
    "--silent",
    "--read", cwd,
    "--read", `${cwd}/lib`,
    "--allow", `${cwd}/out`,
    "--allow-unix-socket", `${cwd}/run/host.sock`,
    "--block-net",
  ]);

  const settings = srt().manifest(boxSpec({ cwd, write: ["out", "~/.claude"], closed: ["secret"], sockets: ["run/host.sock"] })).settings;
  expect(settings.filesystem).toEqual({
    denyRead: [{ path: `${cwd}/secret`, literal: true }],
    allowWrite: [
      { path: `${cwd}/out`, literal: true },
      { path: "~/.claude", literal: true },
    ],
    denyWrite: [{ path: `${cwd}/secret`, literal: true }],
  });
  expect(settings.network.allowUnixSockets).toEqual([`${cwd}/run/host.sock`]);
});

test("a relative working directory is resolved once, against the host's", () => {
  const manifest = nono().manifest(boxSpec({ cwd: "work", write: ["out"] }));
  expect(manifest.cwd).toBe(resolve("work"));
  expect(manifest.flags).toContain(resolve("work", "out"));
});

for (const platform of ["darwin", "linux"] as const) {
  for (const adapter of [
    nono({ platform, binary: "/nonexistent/nono" }),
    srt({ platform, command: ["/nonexistent/srt"] }),
  ]) {
    test(`${adapter.name} on ${platform} refuses a TCP loopback listener before running the wrapper`, async () => {
      const spec = boxSpec({
        cwd: "/",
        net: ["127.0.0.1"],
        listen: { host: "127.0.0.1", port: 43210, from: "harness:opencode" },
      });
      expect(() => adapter.manifest(spec)).toThrow(BoxRefused);
      await expect(adapter.launch(spec, ["true"])).rejects.toThrow(BoxRefused);
    });
  }
}

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

test("a reader that closes its end does not keep the process from closing", async () => {
  // Output keeps coming after the reader has gone, so a write finds the stream closed already.
  let pulled = 0;
  const stdout = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await sleep(20);
      controller.enqueue(bytes(1024));
      if (++pulled >= 5) controller.close();
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
  // The reader gives up on the stream with an error it has heard already: no event is left to come.
  child.stdout.on("error", () => undefined);
  child.stdout.destroy(new Error("the reader is gone"));
  child.stderr.destroy();
  const closed = new Promise<string>((resolve) => child.once("close", () => resolve("closed")));
  expect(await Promise.race([closed, sleep(2000).then(() => "silent")])).toBe("closed");
});

test("a launch that fails behind the returned process is told to a late listener as well, and does not throw", async () => {
  undo.push(
    useSandbox("nono", {
      ...fake(() => {
        throw new Error("unused");
      }),
      launch: async () => {
        throw new Error("the box could not start");
      },
    }),
  );
  const child = spawnAgentNow({ harness: "t", program: "unused", args: [], cwd: "/", box: { sandbox: "nono", spec: { cwd: "/" } } });
  // Only `close` is heard: with no `error` listener the failure must not be thrown.
  const early = new Promise<string>((resolve) => child.once("close", () => resolve("closed")));
  expect(await Promise.race([early, sleep(2000).then(() => "silent")])).toBe("closed");

  const late: string[] = [];
  child.once("error", (error) => late.push(`error ${error.message}`));
  child.once("close", () => late.push("close"));
  await sleep(50);
  expect(late).toEqual(["error the box could not start", "close"]);
});

test("a process ended by a signal reports the signal and no code; an exit with a signal's code is a code", async () => {
  const signalled = await boxed("/bin/sh", ["-c", "kill -TERM $$"], false);
  const ended = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => signalled.once("close", (code, signal) => resolve([code, signal])));
  expect(ended).toEqual([null, "SIGTERM"]);
  expect(signalled.exitCode).toBeNull();
  expect(signalled.signalCode).toBe("SIGTERM");

  const exited = await boxed("/bin/sh", ["-c", "exit 143"], false);
  const code = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => exited.once("close", (code, signal) => resolve([code, signal])));
  expect(code).toEqual([143, null]);
  expect(exited.signalCode).toBeNull();
});
