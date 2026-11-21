// The script: two branches that call, and read the clock and a random number.

// The owner starts it, and a run holds only what it names.
export default workflow({ uses: ["stub.hold"], output: z.json() }, async () => {
  return await parallel([
    async () => {
      const held = await niwa.stub.hold({ name: "a" });
      return { held, at: await now() };
    },
    async () => {
      const held = await niwa.stub.hold({ name: "b" });
      return { held, dice: await random() };
    },
  ]);
});
