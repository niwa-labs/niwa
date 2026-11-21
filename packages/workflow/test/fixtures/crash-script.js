// The script: two agent calls in parallel.
//
// The calls are in two harnesses, as the check says, and they have explicit keys, so the order
// of the branches does not decide which call is which.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Study" }], uses: ["crash.agent"], output: z.json() }, async () => {
  phase("Study");
  const reports = await parallel([
    () => agent("Study the core.", { harness: "crash.one", label: "study:one" }),
    () => agent("Study the state.", { harness: "crash.two", label: "study:two" }),
  ]);
  return { reports };
});
