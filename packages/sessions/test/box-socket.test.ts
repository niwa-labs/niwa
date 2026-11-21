// A boxed session reaches niwa's socket on a real machine.
//
// A session is started through `session.start` in the host's default box: the sessions module
// puts the host's socket into the box, and the session's shell, inside the real srt or nono, speaks
// to the running host with its `NIWA_ID` and calls `access.mine`. gitlab.com, which the box does
// not name, stays unreachable. A box made without the socket does not reach the host: the socket
// is there because the module put it there.
//
// Skipped unless NIWA_LIVE=1 and the sandbox works on this machine.

import { afterAll, describe, expect, test } from "bun:test";

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { actionName } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionControl, StartOptions } from "@niwa-labs/harness";
import { boxSpec, nono, sandbox as sandboxHost, spawnAgent, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";
import { createNiwa, live, tempDir, tempHome } from "@niwa-labs/testing";

import { sessions } from "../src/index.ts";


const HARNESS = "shell";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A control side whose session is one shell command, run by the funnel inside the box the grant made. */
class ShellControl implements SessionControl {
  constructor(private readonly script: (cwd: string) => string) {}

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
    return { session: sessionId(harnessId(HARNESS), "s1") };
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

/** One hello with the token in `NIWA_ID`, then `access.mine`, over the socket: the line-framed wire of the host. */
const callMine = (socket: string) =>
  `{ printf '{"id":0,"op":"hello","client":"box","token":"%s"}\\n{"id":1,"op":"call","action":"access.mine","input":{}}\\n' "$NIWA_ID"; sleep 2; } | nc -U ${socket}`;

const CURL = (url: string) => `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${url}`;

function instance(dir: string): Harness {
  return {
    id: harnessId(HARNESS),
    kind: harnessKind("shell"),
    machine: machineId("machine-1"),
    home: dir,
    sides: {
      reading: { list: false, read: false, watch: false },
      control: { start: true, resume: false, send: false, interrupt: false, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } },
    },
  };
}

for (const sandbox of [srt(), nono()]) {
  const present = live && (await sandbox.available());
  describe(sandbox.name, () => {
    test.skipIf(!present)("a session in its box calls the running host with its NIWA_ID; gitlab.com stays closed", async () => {
      const dir = await realpath(await tempDir("box-socket"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      // A home under the user's home, as the host's is: nono grants the temp area on its own, so
      // it cannot close the host's keys inside it.
      const home = { path: await realpath(await mkdtemp(join(homedir(), ".niwa-box-home-"))), cleanup: () => rm(home.path, { recursive: true, force: true }) };
      const out = join(dir, "answers.txt");
      const control = new ShellControl(
        () => `( ${callMine(join(home.path, "niwa.sock"))}; echo; echo "gitlab $(${CURL("https://gitlab.com")} 2>&1)" ) > ${out} 2>&1`,
      );
      const host = createNiwa({ home: home.path });
      host.use(sessions({ harnesses: [{ instance: instance(dir), control }], sandbox: sandboxHost({ adapter: sandbox }) }));
      await host.serve();
      cleanups.push(async () => {
        await host.close();
        await home.cleanup();
      });

      await host.call(actionName("session.start"), { harness: HARNESS, prompt: "", cwd: dir });

      const answers = await readFile(out, "utf8");
      expect(answers).toContain('"id":1,"ok":true');
      expect(answers).not.toContain("gitlab 200");
    });

    test.skipIf(!present)("a box made without the socket does not reach the host", async () => {
      const dir = await realpath(await tempDir("box-nosocket"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const home = await tempHome();
      const host = createNiwa({ home: home.path });
      await host.serve();
      cleanups.push(async () => {
        await host.close();
        await home.cleanup();
      });
      await expectNoReach(sandbox, dir, join(home.path, "niwa.sock"));
    });
  });
}

async function expectNoReach(sandbox: Sandbox, cwd: string, socket: string): Promise<void> {
  const spec = boxSpec({ cwd, env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
  const box = await sandbox.launch(spec, ["/bin/sh", "-c", `printf '{"id":0,"op":"hello","client":"box"}\\n' | nc -U ${socket}`]);
  const [stdout, code] = await Promise.all([new Response(box.stdout).text(), box.exited]);
  expect(stdout).not.toContain('"op"');
  expect(code).not.toBe(0);
}
