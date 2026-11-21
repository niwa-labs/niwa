// Live: `agent(prompt, { schema })` on a real Claude model (haiku, through Claude Code).
//
// A script asks a tiny question with a zod schema and gets the answer parsed. Claude Code takes
// the schema in the question and checks the answer against it, so the value that comes back
// already passed the schema.
//
// Skipped unless NIWA_LIVE=1 and the `claude` binary is on the PATH.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { actionName } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness } from "@niwa-labs/harness";
import { claudeCode, claudeCodeSides } from "@niwa-labs/harness-claude";
import { sessions } from "@niwa-labs/sessions";
import { tempHome, live, claudePrompt } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";
import type { RunStatus } from "@niwa-labs/workflow";

const HARNESS = harnessId("claude-haiku");
const START = actionName("workflow.start");

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

test.skipIf(!(live && Bun.which("claude") !== null))(
  "a script gets a typed answer from claude-haiku",
  async () => {
    const home = await tempHome();
    homes.push(home);
    const kind = claudeCode({ id: HARNESS, home: join(home.path, "claude"), model: "haiku" });
    const instance: Harness = {
      id: HARNESS,
      kind: kind.instance.kind,
      machine: machineId("machine-1"),
      home: join(home.path, "claude"),
      sides: claudeCodeSides,
    };
    const host = createNiwa({ home: home.path });
    host.use(sessions({ harnesses: [{ instance, reading: kind.reading, control: kind.control }] }));
    host.use(workflow({ harnesses: [HARNESS] }));
    await host.serve();
    hosts.push(host);

    await mkdir(home.path, { recursive: true });
    const file = join(home.path, "capital.js");
    await writeFile(
      file,
      [
        "const Capital = z.object({ city: z.string(), population_millions: z.number() });",
        "export default workflow({ output: z.json() }, async () => {",
        `  const answer = await agent(${JSON.stringify(claudePrompt("What is the capital of France, and roughly how many millions of people live in the city?"))}, { harness: "claude-haiku", schema: Capital });`,
        "  return answer;",
        "});",
      ].join("\n"),
    );
    const done = (await host.call(START, { file, wait: true, timeoutMs: 240_000 })) as RunStatus;
    expect(done.state).toBe("finished");
    if (done.outcome?.status !== "done") throw new Error("the run should be done");
    const result = z.object({ city: z.string(), population_millions: z.number() }).parse(done.outcome.result);
    // The model may answer in the language of its own settings: the city is Paris in any.
    expect(result.city).toMatch(/paris|париж/i);
    expect(result.population_millions).toBeGreaterThan(1);
  },
  300_000,
);
