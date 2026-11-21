// The script: one call that finishes, one that fails.
//
// The keys are explicit, so the revision knows which call is which.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["revision.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await ask({ label: "work:first" }, "Study the core.");
  const second = await ask({ label: "work:second" }, "This one will fail.");
  return { first, second };
});
