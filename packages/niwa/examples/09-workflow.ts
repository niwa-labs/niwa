// A workflow script. It is not run with `bun` directly: the workflow module runs it in a
// process of its own, `niwa.call(workflowStart, { file, args: { repos: [...] } })`.
//
// A workflow is a script made of steps. `agent()` starts a session in any harness.
//
// On failure the run pauses with a choice: retry, skip, cancel. An agent may edit
// this file and restart the run with its id; calls that already finished return
// their results from the journal and are not repeated.

import type { ScriptApi } from "@niwa-labs/script";

// The names a script is given are globals of the process it runs in:
// they are declared here so the type checker knows them. In a script that `workflow.check` reads,
// `z` and the rest are declared for you and need no import.
declare const workflow: ScriptApi["workflow"];
declare const z: ScriptApi["z"];
declare const agent: ScriptApi["agent"];
declare function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
declare function phase(name: string): void;

// The script declares what it takes (`input`) and what it returns (`output`) as zod schemas: the
// host holds the arguments of a start to `input` before a run exists, and the result to `output`
// when the run ends. The function is given `input`, parsed, and its return is checked by the type
// checker against `output`.
export default workflow(
  {
    name: "research-and-merge",
    description: "Study several repositories in parallel and merge the findings.",
    input: z.object({ repos: z.array(z.string()) }),
    output: z.string(),
    // The plan of the script: phase(title) enters one, and a run shows which are done, current and ahead.
    phases: [{ title: "Study" }, { title: "Merge", detail: "one report from all of them" }],
  },
  async ({ repos }) => {
    phase("Study");
    const studied = await parallel(
      repos.map((repo) => () =>
        agent(`Study how ${repo} is built. Answer with a short report.`, {
          harness: "mcode-work",
          label: `study:${repo}`, // an explicit key, so reordering the list does not rerun work
        }),
      ),
    );
    const reports = studied.map((one) => one.answer);

    phase("Merge");
    const merged = await agent(`Merge these reports into one:\n${JSON.stringify(reports)}`, {
      harness: "claude-personal",
    });
    return merged.answer;
  },
);

// The script may not read the clock or random numbers directly: `now()` and `random()` record them,
// and that is what makes the replay honest.
