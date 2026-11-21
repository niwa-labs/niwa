// The script: one call that waits, and a second one.
//
// The first call is parked on a gate of the host, so the run is still going when the owner asks
// for it to be resumed.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["running.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await agent("This call waits.", { label: "work:first" });
  const second = await agent("This call comes after.", { label: "work:second" });
  return { first, second };
});
