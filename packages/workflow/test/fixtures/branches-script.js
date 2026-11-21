// The script: two branches in parallel, with unlabeled calls.
//
// The calls carry no label: the key of a call says which branch it is in. The branches make
// their calls in the order they are written, so the answer of the second branch is not the
// answer of the first one.

// The owner starts it, and a run holds only what it names: the stub agent.
export default workflow({ phases: [{ title: "Study" }], uses: ["branches.agent"], output: z.json() }, async () => {
  phase("Study");
  const reports = await parallel([
    async () => {
      const first = await ask({}, "b1");
      const second = await ask({}, "b2");
      return [first, second];
    },
    async () => {
      const first = await ask({}, "c1");
      const second = await ask({}, "c2");
      return [first, second];
    },
  ]);
  return reports;
});
