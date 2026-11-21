// The fixed script: the first call is unchanged, the failing call has a new key.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["revision.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await agent("Study the core.", { label: "work:first" });
  const second = await agent("This one will work.", { label: "work:second-fixed" });
  return { first, second };
});
