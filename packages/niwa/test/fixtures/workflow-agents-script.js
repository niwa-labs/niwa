// The script of the live workflow test: two agent calls in parallel, then a pipeline step.
//
// The two calls are labeled, so their keys are the labels and do not depend on the order in
// which they arrive. The pipeline step is a call of its own. Every call names the harness, so
// the call reaches the agents of that harness.
//
// The prompt asks for the JSON the answer must be, because the answer of a session is checked
// against a schema: a bare word is not an answer that passes it.

const HARNESS = "mcode-test";

export default workflow({ phases: [{ title: "Work" }], uses: ["session.start.mcode-test"], output: z.json() }, async () => {
  phase("Work");
  const both = await parallel([
    () =>
      ask({
        harness: HARNESS,
        label: "work:alpha",
      }, 'Answer with exactly this JSON: {"answer":"alpha"}'),
    () =>
      ask({
        harness: HARNESS,
        label: "work:bravo",
      }, 'Answer with exactly this JSON: {"answer":"bravo"}'),
  ]);
  const chained = await pipeline([
    (previous) =>
      ask({
        harness: HARNESS,
        label: "work:charlie",
      }, `Answer with exactly this JSON: {"answer":"charlie"}`),
  ]);
  return { both, chained };
});
