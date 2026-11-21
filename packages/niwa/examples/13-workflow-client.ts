// A workflow script that is a client of all of niwa, not only of `agent()`: it calls actions,
// waits for a record, sleeps and asks the owner. It is not run with `bun` directly: the
// workflow module runs it in a process of its own, `niwa.call(workflowStart, { file })`.
// test/workflow-client-example.test.ts runs it on a host.
//
// The names a script is given are globals of that process. They are
// declared here so the type checker knows them. The answers are `any` until `workflow.guide`
// generates the types of the actions from what the host describes.

import type { ScriptApi } from "@niwa-labs/script";

declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const niwa: ScriptApi["niwa"];
declare const wait: ScriptApi["wait"];
declare const ask: ScriptApi["ask"];
declare const sleep: ScriptApi["sleep"];

export default workflow(
  {
    name: "build-and-wait",
    description: "Make a task, wait for its end, ask the owner when it is slow.",
    output: z.object({ status: z.string(), task: z.string().optional() }),
  },
  async () => {
    // A generated wrapper over the action `task.create`; `call("task.create", ...)` is the same.
    const task = await niwa.task.create(
      {
        kind: "build",
        description: "Update the lockfile",
        text: "Update the lockfile",
        askedBy: { kind: "owner" },
        responsible: { kind: "agent", id: "builder" },
        reportTo: { kind: "owner" },
      },
      { label: "create" },
    );

    // Wait for a record of this task. "An answer or a timeout" is the `timeout` option: no waitAny.
    const done = await wait("task.done", { filter: { task: task.id }, timeout: "30m" });
    if ("timedOut" in done) {
      // Ask the owner at the moment of need. A cancelled question or none answered within the timeout
      // throws AskCancelled or AskExpired (the `name` of the error): the script catches it, and here
      // no answer is a denial.
      try {
        const go = await ask.confirm("The build task is slow. Keep waiting?", { timeout: "10m" });
        if (!go) return { status: "gave up" };
      } catch (error) {
        if (error instanceof Error && (error.name === "AskCancelled" || error.name === "AskExpired")) return { status: "gave up" };
        throw error;
      }
    }

    // The moment of waking is recorded on the first pass; a replay does not sleep again.
    await sleep("5m");
    return { status: "done", task: task.id };
  },
);
