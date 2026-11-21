// The host program for workflow resume.
//
// It installs the workflow plugin with a stub agent action. The action counts its calls, so the
// test can tell a repeated call from a reused one, and it waits on a gate: the gate of the
// harness named in the input, so one branch can finish while the other is still in flight.
//
// The home directory comes from argv[2].

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { gate, counter } from "@niwa-labs/testing";
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
    console.error("usage: bun crash-host.ts <home>");
    process.exit(2);
  }

  const calls = counter(home, "crash.agent");

  const agent = action("crash.agent", {
    description: "A stubbed agent: it counts its calls and waits on the gate of its harness.",
    input: AgentInput,
    output: AgentOutput,
    recovery: "repeat",
    async run(input: z.infer<typeof AgentInput>): Promise<z.infer<typeof AgentOutput>> {
      calls.hit();
      // The harness of the call: it names the gate the call waits on.
      const name = input.harness ?? "default";
      await gate(home, `crash.gate.${name}`).wait();
      // The call is counted when it finished, so the counter says what the journal holds.
      counter(home, `crash.${input.harness ?? "default"}`).hit();
      return { answer: `answered: ${input.prompt}` };
    },
  });

  const { createNiwa } = await import("@niwa-labs/testing");
  const niwa = createNiwa({ home });
  // The stub is an action of the host too, so a script may name it in `meta.uses`: the owner who starts the run holds a grant.
  niwa.use(plugin("crash-agent", (api) => api.action(agent)));
  niwa.use(workflow({ agentAction: agent }));
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
