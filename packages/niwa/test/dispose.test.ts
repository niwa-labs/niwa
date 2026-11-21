// A host that stops takes the processes of its control sides with it.
//
// The harness here is a fake pi that records its own pid; the session is started through the
// sessions plugin, the host is closed, and the pid must be gone.

import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import type { ActionName } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";
import { eventually, openBoxes, tempDir, tempHome } from "@niwa-labs/testing";

import { pi, piSides } from "@niwa-labs/harness-pi";

const HARNESS = harnessId("dispose-test");

const FAKE_PI = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync("@PID@", String(process.pid));
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.type === "get_state") {
      out({ type: "response", id: frame.id, command: "get_state", success: true, data: {
        sessionId: "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", sessionFile: "/tmp/niwa-dispose/none.jsonl", isStreaming: false, messageCount: 0,
      } });
    } else if (frame.type === "prompt") {
      out({ type: "response", id: frame.id, command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "agent_end", messages: [], willRetry: false });
    }
  }
}
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("closing the host stops the harness process a session started", async () => {
  const dir = await tempDir("dispose");
  dirs.push(dir);
  const pidFile = join(dir, "pid");
  const binary = join(dir, "fake-pi");
  await writeFile(binary, FAKE_PI.replaceAll("@PID@", pidFile));
  await chmod(binary, 0o755);

  const kind = pi({ id: HARNESS, sessionsRoot: dir, home: dir, model: "test/model", control: { mode: "full", binary } });
  const instance: Harness = {
    id: HARNESS,
    kind: harnessKind("pi"),
    machine: machineId("machine-1"),
    home: dir,
    sides: piSides,
  };

  const home = await tempHome();
  try {
    const niwa = createNiwa({ home: home.path });
    niwa.use(sessions({ harnesses: [{ instance, reading: kind.reading, control: kind.control }], sandbox: openBoxes() }));
    await niwa.serve();
    await niwa.call("session.start" as ActionName, { harness: HARNESS, prompt: "hello" });

    await eventually(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    await niwa.close();
    // close() waited for the control side: the child is gone when it returns.
    expect(alive(pid)).toBe(false);
  } finally {
    await home.cleanup();
  }
});
