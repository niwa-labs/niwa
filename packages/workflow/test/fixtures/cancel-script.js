// The script: a long call, and a second call that must never happen.
//
// The first call is long: the stubbed agent waits on a gate that the test never opens. The run
// is cancelled while that call is in flight, so the second call must never be made.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Work" }], uses: ["cancel.agent"], output: z.json() }, async () => {
  phase("Work");
  const first = await agent("This call takes a long time.", { label: "work:first" });
  const second = await agent("This call must never happen.", { label: "work:second" });
  return { first, second };
});
