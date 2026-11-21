// The host program where a cancelled run stops its child.
//
// It installs the workflow plugin with a stub agent action. The action counts its calls and
// waits on a gate, so the run is parked inside a call: the script is waiting for the answer of
// a call that never comes.
//
// The home directory comes from argv[2].

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { counter, gate } from "@niwa-labs/testing";
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
    console.error("usage: bun cancel-host.ts <home>");
    process.exit(2);
  }

  const calls = counter(home, "cancel.agent");

  const agent = action("cancel.agent", {
    description: "A stubbed agent: it counts its calls and waits on a gate.",
    input: AgentInput,
    output: AgentOutput,
    recovery: "repeat",
    effect: "write",
    async run(input: z.infer<typeof AgentInput>): Promise<z.infer<typeof AgentOutput>> {
      calls.hit();
      // The call never finishes on its own: the test opens the gate or the run is cancelled.
      await gate(home, "cancel.gate").wait();
      return { answer: `answered: ${input.prompt}` };
    },
  });

  const { createNiwa } = await import("@niwa-labs/testing");
  const niwa = createNiwa({ home });
  // The stub is an action of the host too, so a script may name it in `meta.uses`: the owner who starts the run holds a grant.
  niwa.use(plugin("cancel-agent", (api) => api.action(agent)));
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
