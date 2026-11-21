// The script: a call that makes a thing, then a wait for its end.

// The owner starts it, and a run holds only what it names.
export default workflow({ uses: ["stub.create", "niwa.records.read"], output: z.json() }, async () => {
  const made = await niwa.stub.create({ name: "lockfile" }, { label: "create" });
  const done = await wait("stub.finished", { filter: { id: made.id }, timeout: "1h" });
  return { made, done };
});
