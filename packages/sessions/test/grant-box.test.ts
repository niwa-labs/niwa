// A session's box reaches the hosts it asks for, on a real machine.
//
// A session is started through `session.start` with a box that writes its directory and reaches
// example.com, and nothing else. The harness is a shell: its process is the real thing the
// funnel starts inside the real srt, so no model is asked, and what the box lets through is
// what the shell itself reaches. example.com answers, which shows the box lets the listed host
// through, and gitlab.com, which is not in the box, does not.
//
// Skipped unless NIWA_LIVE=1 and srt works on this machine.

import { afterAll, expect, test } from "bun:test";

import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { actionName } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl, StartOptions } from "@niwa-labs/harness";
import { sandbox, spawnAgent, srt } from "@niwa-labs/sandbox";
import { createNiwa, live, tempDir, tempHome } from "@niwa-labs/testing";

import { sessions } from "../src/index.ts";


const present = live && (await srt().available());

const HARNESS = "shell";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A control side whose session is one shell command, run by the funnel inside the box the grant made. */
class ShellControl implements SessionControl {
  /** What the command was told: it writes what each host answered into this file. */
  constructor(private readonly script: (out: string) => string) {}

  async start(options: StartOptions) {
    const child = await spawnAgent({
      harness: HARNESS,
      program: "/bin/sh",
      args: ["-c", this.script(String(options.cwd))],
      cwd: options.cwd,
      env: options.env,
      box: options.box,
    });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    return { session: { harness: harnessId(HARNESS), native: "s1" as never } };
  }
  async resume(): Promise<void> {}
  async send() {
    return { status: "started" as const };
  }
  async interrupt(): Promise<void> {}
  async ask(): Promise<never> {
    throw new Error("a shell is not asked");
  }
  async *life() {}
  async state() {
    return "idle" as const;
  }
}

const probe = (url: string) => `echo "${url} $(curl -sS -m 10 -o /dev/null -w '%{http_code}' ${url} 2>&1)"`;

test.skipIf(!present)("a session whose box lacks gitlab.com cannot reach it from its shell", async () => {
  const dir = await realpath(await tempDir("grant-box"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const home = await tempHome();
  const out = join(dir, "answers.txt");
  const control = new ShellControl(() => `( ${probe("https://example.com")}; ${probe("https://gitlab.com")} ) > ${out}`);
  const instance: Harness = {
    id: harnessId(HARNESS),
    kind: harnessKind("shell"),
    machine: machineId("machine-1"),
    home: dir,
    sides: {
      reading: { list: false, read: false, watch: false },
      control: { start: true, resume: false, send: false, interrupt: false, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } },
    },
  };
  const host = createNiwa({ home: home.path });
  host.use(sessions({ harnesses: [{ instance, control }], sandbox: sandbox({ adapter: "srt" }) }));
  await host.serve();
  cleanups.push(async () => {
    await host.close();
    await home.cleanup();
  });

  await host.call(actionName("session.start"), {
    harness: HARNESS,
    prompt: "",
    cwd: dir,
    box: { allow: [{ net: "example.com" }] },
  });

  const answers = await readFile(out, "utf8");
  expect(answers).toContain("https://example.com 200");
  expect(answers).toContain("https://gitlab.com");
  expect(answers).not.toContain("https://gitlab.com 200");
});
