// The host program where the key of an unlabeled call says its branch.
//
// It installs the workflow plugin with a stub agent action. The action counts its calls and
// waits on a gate of its own prompt, so the branches of the script answer in the order the
// test opens the gates: the second branch may answer before the first.
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
    console.error("usage: bun branches-host.ts <home>");
    process.exit(2);
  }

  const calls = counter(home, "branches.agent");

  const agent = action("branches.agent", {
    description: "A stubbed agent: it counts its calls and waits on the gate of its prompt.",
    input: AgentInput,
    output: AgentOutput,
    recovery: "repeat",
    effect: "write",
    async run(input: z.infer<typeof AgentInput>): Promise<z.infer<typeof AgentOutput>> {
      calls.hit();
      // The gate of the call: the test opens the gates in the order it wants the calls to end.
      await gate(home, `branches.gate.${input.prompt}`).wait();
      return { answer: `answered: ${input.prompt}` };
    },
  });

  const { createNiwa } = await import("@niwa-labs/testing");
  const niwa = createNiwa({ home });
  // The stub is an action of the host too, so a script may name it in `meta.uses`: the owner who starts the run holds a grant.
  niwa.use(plugin("branches-agent", (api) => api.action(agent)));
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
