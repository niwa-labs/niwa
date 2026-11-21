// The host program where a run may not be started twice at once.
//
// It installs the workflow plugin with a stub agent action. The action counts its calls and
// waits on a gate, so the run is parked inside a call: the run is still going, and the owner
// may ask for it to be resumed.
//
// The home directory comes from argv[2].

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { counter, gate, requests } from "@niwa-labs/testing";
import { workflow } from "../../src/index.ts";
import { z } from "zod";



const AgentInput = z.object({
  prompt: z.string(),
  harness: z.string().optional(),
  label: z.string().optional(),
});

const AgentOutput = z.object({ answer: z.string() });

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun running-host.ts <home>");
    process.exit(2);
  }

  const calls = counter(home, "running.agent");

  const agent = action("running.agent", {
    description: "A stubbed agent: it counts its calls, fails for a prompt that says so, and waits on a gate.",
    input: AgentInput,
    output: AgentOutput,
    recovery: "repeat",
    async run(input: z.infer<typeof AgentInput>): Promise<z.infer<typeof AgentOutput>> {
      calls.hit();
      // The prompt says so: the call fails, and the run pauses on it.
      if (input.prompt.includes("fail")) throw new Error("the agent could not answer");
      // The call never finishes on its own: the test opens the gate or the run is ended.
      await gate(home, "running.gate").wait();
      return { answer: `answered: ${input.prompt}` };
    },
  });

  const { createNiwa } = await import("@niwa-labs/testing");
  const niwa = createNiwa({ home });
  niwa.use(requests());
  // The stub is an action of the host too, so a script may name it in `meta.uses`: the owner who starts the run holds a grant.
  niwa.use(plugin("running-agent", (api) => api.action(agent)));
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
