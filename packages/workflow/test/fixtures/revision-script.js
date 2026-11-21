// The script: one call that finishes, one that fails.
//
// The keys are explicit, so the revision knows which call is which.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["revision.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await agent("Study the core.", { label: "work:first" });
  const second = await agent("This one will fail.", { label: "work:second" });
  return { first, second };
});
