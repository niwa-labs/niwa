// A workflow that niwa itself starts on records. `on` lists what starts it: a record type, or a
// type with a filter, so niwa does not start a process for a record that cannot matter. The filter
// is equality on fields of the data of the record (a dotted path goes into nested data), written as
// a literal. The header is read as text without running the script, so its types are names: a
// type imported by reference (`TaskDone` from "@niwa-labs/tasks/records") is for `wait` and
// `read.records` in the body. The function gets the record as its argument; its author gets no
// rights from it.
// test/workflow-subscriptions.test.ts installs it on a host.
//
// Installing it, from a client or from another script. The profile `wf:<sub-…>` is made as
// `narrow(installer's grant, uses)`, and the file is pinned by its hash. It needs
// `call:workflow.install`. Narrowing or closing the installer's grant reaches only the runs started
// after it; a run that is going keeps its grant. Records from before the installation start nothing.
//
//   await niwa.workflow.install({ file: "examples/14-workflow-subscription.ts", description: "notify failed tasks" });
//
// The host names the record types a script may start on: `workflow({ triggers: [TaskDone] })`.

import type { ScriptApi } from "@niwa-labs/script";

declare const niwa: ScriptApi["niwa"];
declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];

/** The record that started the run, as the generated `NiwaTrigger` of `workflow.guide` types it. */
interface Failed {
  id: string;
  type: "task.done";
  data: { task: string; outcome: { status: "failure"; reason: string } };
}

export default workflow(
  {
    on: [{ type: "task.done", filter: { "outcome.status": "failure" } }],
    uses: ["message.send"],
    output: z.string(),
  },
  async (trigger: Failed) => {
    const { task, outcome } = trigger.data;
    await niwa.message.send(
      { to: { kind: "owner" }, body: { type: "update", text: `Task ${task} failed: ${outcome.reason}` } },
      { label: "notify" },
    );
    return task;
  },
);
