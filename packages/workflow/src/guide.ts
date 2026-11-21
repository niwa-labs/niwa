/**
 * The guide of `workflow.guide`: how to write a script, by hand, and then what the host
 * generates — the typing and the catalogue of the actions the caller may use.
 */

import type { ActionDescription, ActionName } from "@niwa-labs/core";

import type { Trigger } from "./check.ts";
import { scriptTyping } from "./script-types.ts";
import type { HarnessBlock } from "./script-types.ts";

/** How a script is written. Short: the types say the rest. */
export const HOW_TO_WRITE = `A workflow script is a file that exports, by default, the call workflow({ ... }, fn): what it declares, and
the async function that is the script. It runs in a process of its own; every call it makes goes to the host and
is a step of the run. The names below are globals: do not import them (z is zod). The generated declarations give
their types. A script may import packages: the record types, query builders and helpers plugins give scripts.

  import { taskDone } from "@niwa-labs/tasks/records";

  export default workflow({
    name: "build",
    description: "Make a task and wait for it",
    input: z.object({ text: z.string(), minutes: z.number().int().default(30) }),
    output: z.object({ task: z.string() }),
    uses: ["task.*", "niwa.records.read"],
  }, async ({ text, minutes }) => {
    const task = await niwa.task.create({ ... }, { label: "create" });
    const done = await wait(taskDone(task.id), { timeout: minutes + "m" });
    if ("timedOut" in done && !(await ask.confirm("Keep waiting?", { timeout: "10m" }))) return { task: "gave up" };
    await sleep("5m");
    return { task: task.id };
  });

- The declaration is the contract. input is a z.object: the fields of the flags and the form, and the function is
  given it parsed, with the defaults put in; a start whose arguments do not pass it is refused before a run
  exists (input-invalid, with the fields). output is what the function returns: a script with no output returns
  nothing, and a script with no input is given nothing. The type checker holds the function to both: a wrong field is an
  error with its place. A result that does not pass output ends the run as failed (output-invalid, with the fields).
  Both must be written in JSON Schema without loss: z.unknown(), z.any(), transforms, z.custom and dates are refused.
- workflow.check reads the declaration by loading the module in a process of its own, where the names of niwa are
  stubs that throw: imports at the top work, and the function is never run. It gives description, input and output as
  JSON Schema and a contract hash; workflow.get and workflow.installation.get show them. A run keeps the hash of the contract it began under: a
  resume that finds another contract stops on the revise pause when the arguments it recorded no longer pass input.
- name, uses and on are read from the text of the declaration, as literals, so what a script may do is known without
  running it.

Calling actions:
- niwa.<group>.<action>(input, { label }) calls the action <group>.<action>. call(name, input, { label }) is the
  same by name. A name with a dash is niwa.agent["search-old"]. agent(prompt, { harness, visible, model, effort, mode, cwd }) starts a session
  (a call of session.start.<harness>) in the directory cwd, or in the host's own directory when it is absent, with the model,
  effort and mode given (mode is "ask", "auto" or "full"; auto when absent), which it keeps for its whole life (a kind that cannot apply them refuses the call); it sees only the action that answers, plus the names or masks in visible,
  which must lie within the grant of the run. The harness is one the host serves (an unknown one is an error of the check), and a model or an effort is checked against the list its adapter gives, where it gives one.
  The options of the harness's kind go in the block named after the kind:
  agent(prompt, { harness: "claude-sonnet", claude: { advisor: false } }); only the block of that harness's kind is typed,
  the block of another kind, or a field the block does not have, is an error of the check and is refused, and a session
  resumed later starts again with the options it was started with.
- agent(prompt, { worktree: true }) runs the session in a new git worktree (the git module's git.worktree.create) of cwd's
  repository, or { worktree: { repo, base, description } }; the base is the repository's current branch when absent. When the
  call ends with the worktree clean and no new commit, it is removed; otherwise the answer carries
  worktree: { id, path, branch, changed: true } and the branch stays for you, the agent or the owner to merge: niwa never merges.
  With a worktree the answer is an object, so a schema is a z.object (or z.record); any other schema is an error of the check.
- agent(prompt, { box: { allow: ["bun", { read: "~/data" }] } }) gives the session's box more than the host's default
  (the project and the toolchains), and { box: { only: [{ read: "." }] } } gives it that instead; an item is a profile's
  name, "project", "toolchains", { read }, { write } or { net }. The session always has its own installation's profile.
  Beyond the default the run's uses needs the rule: "box.use@bun", "box.read@/path/*", "box.write@...", "box.net@<host>".
- agent(prompt, { schema }) with a zod schema gives a typed answer. z is a global (zod, no import): write the schema
  with z.object({ ... }), pass it, and the call gives the answer already parsed, typed as z.infer<typeof Schema>.
  Without schema the call gives { answer }, the text. The schema goes to the host as JSON Schema and is part of the
  step: another schema is another call on a replay, and a finished call is answered from the journal without
  asking again. An answer that does not pass the schema is never returned: a harness with structured output
  has the call fail (the run pauses for a retry, a skip or a cancel), and for the others the session is told what
  was wrong when it submits, and answers again. A rule JSON Schema cannot say (a .refine, a .transform that
  needs code) is checked only in the script, after the step is recorded: a replay gives the same recorded answer, so
  a failure of such a rule repeats until the call gets a new label or another schema.

    const Review = z.object({ verdict: z.enum(["approve", "changes"]), notes: z.array(z.string()) });
    const review = await agent("Review the diff in ./src", { harness: "codex", schema: Review });
    if (review.verdict === "changes") log(review.notes.join("\n"));
- uses lists the actions the script calls, as names or masks ("task.*"). The check holds the script to it:
  a call outside the list is an error, and so is an agent() call on a harness it does not list as "session.start.<harness>";
  a harness known only when the script runs is a warning of the check, which asks for an entry that covers it. The run holds exactly those rights, narrowed from the caller's: a mask the
  caller does not hold refuses the start. Without uses a script started by a caller with a grant may call
  nothing; only a caller that nothing limits (the host itself) gets every action.
- Run workflow.check { file } before workflow.start: it type-checks the script against the declarations below and
  does not run it. workflow.start refuses a script with errors.

Registered workflows:
- workflow.register { file } checks the script and issues its id wf-…; workflow.register { file, id } registers a
  new version of that workflow. A version is the hash of the script and the local files it imports. A registered
  script says what it is in workflow({ description }). workflow.list and workflow.get show the workflows.
- workflow.start { id, args } runs the latest version and answers the id of the run (run-…); workflow.start { file }
  runs a script once without registering it. A run belongs to a directory, the project it is for: the CLI and the MCP
  server pass their working directory, and workflow.start { directory } names another one.
- Every registered workflow is the action flow.<id>: it runs the workflow to its end and answers its output. A script
  calls it as niwa.flow["wf-a3f9c2"](input) with "flow.wf-a3f9c2" in uses. When a workflow changes its contract, the
  ones that call it are checked again; one that no longer passes is broken and does not start until a version passes.

Scripts niwa starts by itself:
- on lists the records that start the script: a type, or a type with a filter written as a literal,
  on: ["task.done", { type: "message.sent", filter: { "to.id": "owner" } }]. The header is read as text, so a
  type is named there as text, never by an imported reference; references are for wait and read.records. The filter is equality on fields of
  the data of the record (a dotted path goes into nested data), as the filter of wait is; the check refuses a path
  no record of the type holds, and a literal its field cannot hold. The function gets the record as its argument,
  typed as NiwaTrigger: { id, type, data }, narrowed to the types on lists. A script with on has no input. The record gives its author no rights.
- workflow.install { id | file, description } checks the script, issues the installation id sub-…, makes the profile
  wf:<sub-…> = narrow(the installer's grant, uses) and pins the hash of the file; from then on niwa starts one run per
  matching record under that profile, and the start of each run names the installation. Records from before the
  installation start nothing. workflow.uninstall { id }, workflow.installation.list and workflow.installation.get
  end and list them. Narrowing the installer's grant narrows the runs that start after it, and closing it stops new runs;
  the runs that live keep the grant they were born with.

Time and the outside:
- wait(type, { filter, from, timeout }) gives { data, at }: the first record of that type written after from (a
  position an earlier wait or read gave) or after the wait began, whose data holds every field of the filter (a
  field, or a dotted path), and its position; or { timedOut: true }. A wait from at misses nothing written after
  the record. There is no waitAny.
- A type is its name as text, or the type itself imported from the records entry of the plugin that declares it:
  import { TaskDone } from "@niwa-labs/tasks/records"; then wait(TaskDone, { filter: { task: task.id }, from }) and
  read.records(TaskDone, { filter, from, limit }) give data typed by its schema, and read.records({ types: [TaskDone,
  TaskUpdated] }) data typed by each. The import is resolved from the folder of the script, so the plugin's package
  must be found from there; a registered copy and a boxed run find packages in the node_modules niwa runs with, and
  the packages of other repositories that a plugin on the host offers to scripts (@niwa-labs/forge/flow).
  The host waits for and reads the type at the version it writes; the check and the run refuse a type the host
  does not know and a reference to another version of it.
- The records entry of a plugin also gives query builders: taskDone(task.id) from "@niwa-labs/tasks/records" is the
  type and the filter of the end of one task. wait(taskDone(task.id), { from, timeout }) and
  read.records(taskDone(task.id)) take it as they take a type, and the check follows it to its type. The flow entry of a plugin gives helpers that wait
  as a step of the script: untilSessionEnded("end", { session, timeout }) from "@niwa-labs/history/flow".
- sleep(ms | "5m") records its wake-up moment: a replay does not sleep from the start.
- ask.choice(text, options, opts), ask.multi, ask.confirm(text, opts), ask.text(text, opts) and ask.form(text, zodObject, opts) ask the owner and give a typed value (the id picked, the ids, a boolean, a string, what the schema parses); opts is { timeout, label }. A cancel or no answer in time throws an error named AskCancelled or AskExpired, which the script may catch (it is never a false answer); uncaught, the run waits for a revision or a cancel, since a retry would get the same error.
- const Blocked = record("blocked", z.object({ pr: z.number() })) declares a record; workflow({ name, emits: [Blocked] }) lists it,
  and emit(Blocked, { pr }) writes wf.<name>.blocked, the data held to the schema (a script emits nothing it does not list);
  wait(type) and read.records({ types }) give data typed by the type; read.state(plugin), read.records(query), now() and random()
  are recorded reads. read.records({ from, types, filter, stream, limit, tail }) gives { records, next }: types are exact
  names or families written prefix.*, and next is the position to read or wait on from.
- What the script does is held to the grant of the run: wait, read.state and read.records need niwa.records.read,
  a call needs its action. ask, emit (emit:wf.*, which every run has), sleep, now and random need nothing in
  uses.

Steps and replay:
- Every call is a step under its label, or under its place among the calls of its branch. Give a label to any
  call that must keep its result when the script is reordered. A finished step is never repeated.
- parallel([() => ...]) or parallel({ a: () => ..., b: () => ... }, { concurrency }) and pipeline([() => ..., (previous) => ...])
  (two to four stages, each given the value before it, typed) group calls; phase(title) says where the script is (below);
  log(text) writes a line to the log of the run.

Scopes:
- scope(name, { concurrency, onExit, deadline, onDeadline, shield }, async (s) => { s.start(key, fn); await s.next(); }) is a
  group of branches that never outlive it. s.next() gives the outcomes ({ key, result: { ok, value } | { ok: false, error } })
  in the order the host committed them, and null when all were read; s.ready(), s.rest(), s.pending(), s.cancel(reason, keys)
  and s.run(key, { id, args }) (a branch that is a child run) go with it. Keys and names are words: no ".", "~", "/" or ":".
- Leaving the block waits for the branches left (onExit "wait") or cancels them ("cancel"); a block that throws cancels them,
  and a cancel goes down into the scopes inside, except a shield ({ shield: true }), whose block an outer cancel waits for.
  A cancelled branch gives { ok: false, error: { name: "Cancelled" } }; a branch that ended keeps its result.
- deadline cancels the scope when it runs out: onDeadline "skip" gives undefined, "fail" throws DeadlineExceeded;
  moveOnAfter(name, "5m", fn) and failAfter(name, "5m", fn) are the short forms. stream(name, { a: fn, b: fn }) starts the
  branches and gives their outcomes one at a time (next(), for await) until it is closed; race(name, { a: fn, b: fn }) gives the
  first branch that succeeds. parallel, stream and race are scopes; workflow.start { concurrency } caps every scope of a run.

Phases:
- workflow({ phases: [{ title: "Review" }, { title: "Fix", detail: "fix what was confirmed" }], ... }) declares the plan of the
  script, in order, as a literal: titles are not empty and are not repeated. phase("Review") enters one: the type checker
  allows only the declared titles (in the declarations below NiwaPhase is never: they declare no phases), and an undeclared
  one fails the script where it is named. Steps take no phase: a step is in the phase its branch is in when it begins.
- phase() at the top sets the phase of the script. A branch of parallel or pipeline starts in the phase of the branch that
  made it; phase() inside a branch changes that branch only, so branches can be in different phases at once:
    phase("Review");
    await parallel(items.map((item) => async () => { await review(item); phase("Fix"); await fix(item); }));
    phase("Report");
- workflow.inspect and workflow.wait show the plan (status.phases) and the phases the run is in (status.currentPhases):
  current is the phase of a branch that is going (several while branches are in different ones; the script itself is not
  in its phase while its parallel runs); done is a phase entered, not current, before every current one (with no current
  phase, every phase entered: a run that finished with its result has all it entered done); ahead is the rest — not entered,
  or entered by a branch that ended while another branch has not reached it. workflow.inspect groups the steps by phase;
  workflow.get and workflow.list show the declared phases.
- Edit the file and resume the run by its id: the calls along the longest unchanged prefix of the earlier start are taken
  (the same key and the same call; an agent call is its prompt and harness), and the first new or changed call and everything
  after it in its branch, or after its scope, run. A call with an effect that ran before is taken all the same, never made
  twice. workflow.resume { run, from } runs the steps from a step key, a branch or a phase on again.`;

/** What the guide answers with. */
export interface Guide {
  guide: string;
  declarations: string;
  actions: Array<{ name: string; description: string; input: string }>;
}

/** The guide for the actions a caller may call. */
export function guideFor(
  description: readonly ActionDescription[],
  callable: readonly ActionName[],
  triggers: readonly Trigger[] = [],
  blocks: ReadonlyMap<string, HarnessBlock> = new Map(),
): Guide {
  const typing = scriptTyping(description, callable, triggers, [], blocks);
  const wanted = new Set<string>(callable);
  return {
    guide: HOW_TO_WRITE,
    declarations: typing.declarations,
    actions: description
      .filter((action) => wanted.has(action.name))
      .map((action) => ({ name: action.name, description: action.description, input: typing.inputs.get(action.name) ?? "unknown" })),
  };
}
