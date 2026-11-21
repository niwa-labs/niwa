// Watching one started command: what is told when its output could not be kept or was cut off.
//
// What it proves:
//   1. an artifact store that fails stops the command and fails the call: it is never a result
//      with an empty output and exit 0
//   2. reading that is given up on, because something the command started in another group still
//      holds its pipes, is said in the result
//   3. a command whose output was all read says so

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { ArtifactStore, ArtifactWriter } from "@niwa-labs/core";
import { eventually } from "@niwa-labs/testing";

import { OutputCapture } from "../src/artifact.ts";
import { launchPlain, supervise } from "../src/supervise.ts";
import { alive } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "niwa-supervise-"));
  dirs.push(dir);
  return dir;
}

const ENV = { PATH: "/usr/bin:/bin" };
const TIMES = { timeout: 20_000, killGraceMs: 100, drainMs: 150 };

/** A store whose writer takes nothing, or keeps the bytes it is given. */
function store(write: (chunk: Uint8Array) => void): { store: ArtifactStore; discarded: () => boolean } {
  let discarded = false;
  const writer: ArtifactWriter = {
    write,
    finish: () => ({ digest: "sha256:0", size: 0, type: "text/plain" }),
    discard: () => {
      discarded = true;
    },
  };
  return {
    store: {
      put: () => {
        throw new Error("not used");
      },
      writer: () => writer,
      read: () => {
        throw new Error("not used");
      },
    },
    discarded: () => discarded,
  };
}

test("an artifact store that fails stops the command and fails the call", async () => {
  const dir = workDir();
  const kept = store(() => {
    throw new Error("the disk is full");
  });
  const capture = new OutputCapture({ artifacts: kept.store, secrets: [], limit: 1 << 20, tailBytes: 16 });
  const child = launchPlain(["/bin/sh", "-c", "echo $$ > pid; echo hi; sleep 30"], dir, ENV);
  const began = Date.now();
  await expect(supervise(child, capture, TIMES)).rejects.toThrow("the disk is full");
  expect(Date.now() - began).toBeLessThan(10_000);
  await eventually(() => existsSync(join(dir, "pid")), 2_000, "the command should have started");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  await eventually(() => !alive(pid), 5_000, "the command should have been stopped");
});

test("output left in a pipe that something in another group still holds is said to be cut off", async () => {
  const dir = workDir();
  const kept = store(() => {});
  const capture = new OutputCapture({ artifacts: kept.store, secrets: [], limit: 1 << 20, tailBytes: 16 });
  const script = `perl -e 'use POSIX; if (!fork) { POSIX::setsid(); open(my $f, ">", "pid"); print $f $$; close $f; exec "sleep", "30" }'; echo hi`;
  const child = launchPlain(["/bin/sh", "-c", script], dir, ENV);
  try {
    const ended = await supervise(child, capture, TIMES);
    expect(ended.outcome).toBe("exited");
    expect(ended.exit).toBe(0);
    expect(ended.outputCut).toBe(true);
  } finally {
    await eventually(() => existsSync(join(dir, "pid")), 2_000, "the detached process should have started");
    try {
      process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("a command whose whole output was read says nothing was cut off", async () => {
  const dir = workDir();
  const kept = store(() => {});
  const capture = new OutputCapture({ artifacts: kept.store, secrets: [], limit: 1 << 20, tailBytes: 16 });
  const child = launchPlain(["/bin/sh", "-c", "echo hi; sleep 30 &"], dir, ENV);
  const ended = await supervise(child, capture, TIMES);
  expect(ended.exit).toBe(0);
  expect(ended.outputCut).toBe(false);
});
