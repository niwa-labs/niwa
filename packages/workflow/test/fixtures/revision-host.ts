// The host program for workflow revision.
//
// It installs the workflow plugin with a stub agent action. The action counts its calls and
// fails for the prompt that says "fail", so the run pauses with a request.
//
// The home directory comes from argv[2].

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { counter, requests } from "@niwa-labs/testing";
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
    console.error("usage: bun revision-host.ts <home>");
    process.exit(2);
  }

  const calls = counter(home, "revision.agent");

  const agent = action("revision.agent", {
    description: "A stubbed agent: it counts its calls and fails for the prompt that says so.",
    input: AgentInput,
    output: AgentOutput,
    recovery: "repeat",
    async run(input: z.infer<typeof AgentInput>): Promise<z.infer<typeof AgentOutput>> {
      calls.hit();
      if (input.prompt.includes("fail")) throw new Error("the agent could not answer");
      return { answer: `answered: ${input.prompt}` };
    },
  });

  const { createNiwa } = await import("@niwa-labs/testing");
  const niwa = createNiwa({ home });
  niwa.use(requests());
  // The stub is an action of the host too, so a script may name it in `meta.uses`: the owner who starts the run holds a grant.
  niwa.use(plugin("revision-agent", (api) => api.action(agent)));
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
