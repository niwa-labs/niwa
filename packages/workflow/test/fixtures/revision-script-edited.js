// The edited script.
//
// The first call is unchanged: it reuses its result.
// The second call has another prompt under the same key: it is shown, not rerun.
//
// The file is written by the test into the home, so the revision compares the script as it is
// now with the calls that were recorded.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["revision.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await agent("Study the core.", { label: "work:first" });
  const second = await agent("This one will fail, differently.", { label: "work:second" });
  return { first, second };
});
