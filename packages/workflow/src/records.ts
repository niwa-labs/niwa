/**
 * The records of a workflow run.
 *
 * A run is a few facts and nothing else:
 *
 * - **requested**: a run was asked for, which wakes the handler of the plugin;
 * - **started**: the handler began a script, with the file it came from and the arguments it got;
 * - **phase entered**, **phase left** and **step phase**: a branch of the script entered a declared phase, a branch
 *   that had one ended, and the phase a step was made in;
 * - **log**: what the script wrote;
 * - **paused**: something did not complete and a decision is needed. A paused run is a request
 *   with the choices of the core: retry, skip, cancel;
 * - **finished**: the run ended, with its result;
 * - **subscription installed** and **uninstalled**: a script niwa starts by itself on records.
 *
 * The calls the script made are not here: they are steps of the run's invocation, and the
 * journal holds them like any other step.
 */

import { EntityDescription, JsonSchemaValue, JsonValueSchema, idSchema, principalSchema, record } from "@niwa-labs/core";
import { Subscription } from "@niwa-labs/script";
import { z } from "zod";

import { ScopeClosing, ScopeOutcome, WorkflowPhases } from "./language.ts";

/** The id of a run: `run-3fa9c2`, issued by niwa. */
export const RunId = idSchema("run");
export type RunId = z.infer<typeof RunId>;

/** The id of a registered workflow: `wf-a3f9c2`, issued at its first registration. */
export const WorkflowId = idSchema("workflow");
export type WorkflowId = z.infer<typeof WorkflowId>;

/** The id of an installation: `sub-3fa9c2`, issued when the script is installed. */
export const InstallationId = idSchema("subscription");
export type InstallationId = z.infer<typeof InstallationId>;

/** A version of a workflow: the sha256 of its source closure, the entry file and the local files it imports. */
export const WorkflowVersion = z.string().regex(/^[0-9a-f]{64}$/, "a version is a sha256 in hex").brand<"WorkflowVersion">();
export type WorkflowVersion = z.infer<typeof WorkflowVersion>;

/** Where a run came from, when it is more than a file: the workflow and the version it runs, the installation that started it, the directory it was started for. */
const RunOrigin = {
  /** The registered workflow the run runs, when it was started by its id. */
  workflow: WorkflowId.optional(),
  /** The version of the workflow it runs. */
  version: WorkflowVersion.optional(),
  /** The installation whose record started the run. */
  installation: InstallationId.optional(),
  /** The directory the run was started for, an absolute path: the project it belongs to. Absent when the caller named none. */
  directory: z.string().optional(),
  /** The run and the step of it that started this run, when a run started it: the tree a cancel and a pause go down. */
  parent: z.object({ run: z.string(), step: z.string() }).optional(),
  /** The most branches each group of the run runs at once, set from outside; the script's own limit holds when it is lower. */
  concurrency: z.number().int().positive().optional(),
  /** The limits of the run: how many runs deep its tree may go, the run that started it being one. A child run takes them. */
  limits: z.object({ depth: z.number().int().positive().optional() }).optional(),
};

export { JsonSchemaValue };

/** The hash of the contract of a script: its input and output schemas, as the host reads them. */
export const ContractHash = z.string().regex(/^[0-9a-f]{64}$/, "a contract hash is a sha256 in hex").brand<"ContractHash">();
export type ContractHash = z.infer<typeof ContractHash>;

/** A field of a value that did not pass a schema. */
export const Issue = z.object({ path: z.string(), message: z.string() });
export type Issue = z.infer<typeof Issue>;

/** The run started: a script, and the arguments it was given. */
export const RunStarted = record(
  "workflow.run.started",
  z.object({
    /** The id of the run: the identity of this attempt at the script. */
    run: RunId,
    /** The file the script came from. */
    file: z.string(),
    /** The arguments the script was given. */
    args: z.unknown(),
    /** The label of the run, when it has one. */
    label: z.string().optional(),
    /**
     * The hash of the script file as it was when the run started.
     *
     * A hash that differs from the one of the file now means the script was edited, so the run
     * that is resumed is a revision and not a replay. It is absent when the file could not be read.
     */
    hash: z.string().optional(),
    /** Whether the script process runs in a box (an empty one: no write, no network, a clean environment). Absent: it does not. */
    box: z.boolean().optional(),
    /** The hash of the contract (input and output schemas) the run started under. Absent when the script could not be read. */
    contract: ContractHash.optional(),
    /** The phases the script declares, in order: the plan the run's progress is shown against. Absent when it declares none. */
    phases: WorkflowPhases.optional(),
    ...RunOrigin,
  }),
);

/** The script wrote a line to the log of the run. */
export const RunLog = record(
  "workflow.run.log",
  z.object({ run: RunId, text: z.string() }),
);

/**
 * A branch of the script entered a phase it declares: `phase(title)` was called in it, or the branch was made (by
 * `parallel` or `pipeline`) in a branch that was in a phase, and starts in that one. The branch is its path in the
 * script (`p1.0`, `p1.0.s2.1`), `""` for the script itself. Written under the branch and the number of the change
 * within it, so a replay writes the same record and one branch does not take another's.
 */
export const PhaseEntered = record(
  "workflow.phase.entered",
  z.object({
    run: RunId,
    /** The path of the branch: `""` for the script itself. */
    branch: z.string(),
    /** The title of the declared phase. */
    phase: z.string(),
  }),
);

/** A branch that was in a phase ended: its phase is no longer one the run is in. Under the branch's own key. */
export const PhaseLeft = record(
  "workflow.phase.left",
  z.object({
    run: RunId,
    /** The path of the branch. */
    branch: z.string(),
  }),
);

/**
 * A step of the run was made in a declared phase: the phase its branch was in when the step began. Written just
 * before the step, under the step's key, so the steps of a run are grouped by phase from the journal alone.
 */
export const StepPhase = record(
  "workflow.step.phase",
  z.object({
    run: RunId,
    /** The key of the step: its label, or its place among the unlabeled calls. */
    key: z.string(),
    /** The title of the declared phase. */
    phase: z.string(),
  }),
);


/**
 * The run paused: something did not complete, and a decision is needed.
 *
 * The choices are the ones of the core: retry, skip, cancel. The step it paused on is named, so
 * the answer says which step it is about.
 */
export const RunPaused = record(
  "workflow.run.paused",
  z.object({
    /** The run that paused. */
    run: RunId,
    /** Why it paused. */
    reason: z.string(),
    /** The step it paused on, when it paused on one. */
    key: z.string().optional(),
    /** The choices an owner may answer with. */
    choices: z.array(z.enum(["retry", "skip", "cancel"])).optional(),
  }),
);

/** A request to stop entering script operations at a workflow boundary. */
export const RunPauseRequested = record("workflow.run.pause-requested", z.object({ run: RunId }));

/** Release only the specified request, so a duplicate cannot release a later pause. */
export const RunContinued = record("workflow.run.continued", z.object({ run: RunId, pause: z.string() }));

/** How a run ended: with the result the script returned, with an error, or by a cancel. */
export const RunOutcome = z.discriminatedUnion("status", [
  /** The script returned, and what it returned passes its `output`. */
  z.object({ status: z.literal("done"), result: z.json() }),
  /** The run ended with no result of the script: what it returned does not pass its `output`. */
  z.object({
    status: z.literal("failed"),
    error: z.object({ code: z.literal("output-invalid"), message: z.string(), issues: z.array(Issue) }),
  }),
  z.object({ status: z.literal("cancelled") }),
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

/** The run finished: how it ended. */
export const RunFinished = record(
  "workflow.run.finished",
  z.object({
    /** The run that finished. */
    run: RunId,
    /** How it ended. */
    outcome: RunOutcome,
  }),
);

/**
 * The run was asked for: a script, and the arguments it gets.
 *
 * The handler of the plugin is woken by this record, so the run is an invocation like any other.
 */
export const RunRequested = record("workflow.run.requested", z.object({
  /** The id of the run: the identity of this attempt at the script. */
  run: RunId,
  /** The file the script came from. */
  file: z.string(),
  /** The arguments the script was given. */
  args: z.unknown(),
  /** The label of the run, when it has one. */
  label: z.string().optional(),
  /** The sha256 of the script as it was read when the run was asked for; the run records it as the script it started. */
  hash: z.string().optional(),
  /** Whether the script process runs in a box (an empty one: no write, no network, a clean environment). Absent: it does not. */
  box: z.boolean().optional(),
  /** The hash of the contract of the script as it was read when the run was asked for. */
  contract: ContractHash.optional(),
  /** Run again the steps from this one on: a step key, a key prefix of a branch or scope, or the title of a phase. */
  from: z.string().min(1).optional(),
  ...RunOrigin,
}));

/** A call of the script was taken from an earlier start of the run instead of being made again. */
export const StepReused = record(
  "workflow.step.reused",
  z.object({
    run: RunId,
    /** The key of the call. */
    key: z.string(),
    /** The start of the run whose answer it took. */
    from: z.string(),
  }),
);

// The record a script starts on is read from its header, so the script package defines it.
export { Subscription };

/**
 * A built-in workflow: one a plugin ships and offers (`BUILTIN_WORKFLOW`), named by the plugin and its name among
 * the plugin's built-ins. The pair is what finds it again when the host starts: niwa issues the ids, the pair keeps them.
 */
export const Builtin = z.object({
  /** The plugin that offers it, as the host says. */
  plugin: z.string().min(1),
  /** Its name among the built-ins of that plugin. */
  name: z.string().min(1),
});
export type Builtin = z.infer<typeof Builtin>;

/**
 * A script was installed: from now on niwa starts one run of it per record that matches.
 *
 * The record says what was pinned (the file and its hash), what starts the script, what it uses,
 * and who installed it: the runs are born from the grant of the installer, for attribution and
 * for the cascade.
 */
export const SubscriptionInstalled = record(
  "workflow.subscription.installed",
  z.object({
    installation: InstallationId,
    /** What the installation is for, in a few words of whoever made it. */
    description: EntityDescription,
    /** The registered workflow that was installed, when it was installed by its id. */
    workflow: WorkflowId.optional(),
    version: WorkflowVersion.optional(),
    file: z.string(),
    hash: z.string(),
    on: z.array(Subscription),
    uses: z.array(z.string()),
    /** The JSON Schema of the trigger the script gets: absent for a script with `on`, which always gets the record. */
    input: JsonSchemaValue.optional(),
    /** The JSON Schema of what the script returns; absent when it returns nothing. */
    output: JsonSchemaValue.optional(),
    /** The hash of the contract, at the installation. */
    contract: ContractHash,
    /** Absent when nothing limits the installer (the host itself). */
    installer: principalSchema.optional(),
    /** Whether the runs of the script are boxed, as for `workflow.start`. Absent: they are not. */
    box: z.boolean().optional(),
    /** The built-in this installation is, made by the workflow module when the host started. Absent for one somebody made. */
    builtin: Builtin.optional(),
  }),
);

/** An installation ended: nothing starts from it any more. */
export const SubscriptionUninstalled = record(
  "workflow.subscription.uninstalled",
  z.object({ installation: InstallationId, reason: z.string() }),
);

/** A record type a script declares in `emits`: the name it gives it, its type `wf.<name>.<record>`, and the JSON Schema of its data. */
export const EmittedRecord = z.object({ record: z.string(), type: z.string(), schema: JsonSchemaValue });
export type EmittedRecord = z.infer<typeof EmittedRecord>;

/** A workflow that a registered one calls (`flow.<id>` in its `uses`), with the contract it was checked against. */
export const FlowCall = z.object({ workflow: WorkflowId, contract: ContractHash });
export type FlowCall = z.infer<typeof FlowCall>;

/**
 * A version of a workflow was registered: from now on `flow.<id>` runs it.
 *
 * The first registration issues the id; a later one under the same id is a new version. What the
 * script declared is kept, so the action the workflow is has its schemas without loading the script.
 */
export const WorkflowRegistered = record(
  "workflow.registered",
  z.object({
    workflow: WorkflowId,
    version: WorkflowVersion,
    file: z.string(),
    description: EntityDescription,
    input: JsonSchemaValue.optional(),
    output: JsonSchemaValue.optional(),
    contract: ContractHash,
    uses: z.array(z.string()),
    /** The registered workflows it calls. */
    calls: z.array(FlowCall),
    /** The `name` the script gives itself, the prefix of its records: no other registered workflow has it. Absent when it has none. */
    name: z.string().optional(),
    /** The records of other scripts (`wf.<name>.<record>`) it waits for or reads by name: a change in what their writer declares checks it again. */
    reads: z.array(z.string()).optional(),
    /** The record types it declares in `emits`: they join the record catalogue the typing of other scripts is made from. Absent when it declares none. */
    emits: z.array(EmittedRecord).optional(),
    /** The records that start it once it is installed (its `on`). Absent when it declares none: it is only started by hand. */
    on: z.array(Subscription).optional(),
    /** The phases it declares, in order. Absent when it declares none. */
    phases: WorkflowPhases.optional(),
    /** The built-in it is: registered by the workflow module from the file the plugin ships, never by hand. */
    builtin: Builtin.optional(),
  }),
);

/** One built-in as the host wants it now: the plugin's declaration, and the version its file is. */
export const WantedBuiltin = Builtin.extend({
  file: z.string().min(1),
  description: EntityDescription,
  version: WorkflowVersion,
});
export type WantedBuiltin = z.infer<typeof WantedBuiltin>;

/**
 * The built-ins that stand are not the ones the plugins offer: written when the host starts and finds a built-in
 * missing, of another version, or one no plugin offers any more. Its handler registers and installs what is wanted
 * and uninstalls the rest.
 */
export const BuiltinsWanted = record("workflow.builtins.wanted", z.object({ items: z.array(WantedBuiltin) }));

/** One error of a check, with its place in the file. */
export const CheckProblem = z.object({ file: z.string(), line: z.number().int(), column: z.number().int(), code: z.string(), message: z.string() });

/**
 * A workflow was checked again because one it calls changed its contract.
 *
 * A version whose latest check failed is broken: it does not start until a check passes again.
 */
export const WorkflowRechecked = record(
  "workflow.rechecked",
  z.object({
    workflow: WorkflowId,
    version: WorkflowVersion,
    /** The workflow whose new contract asked for the check. */
    because: WorkflowId,
    ok: z.boolean(),
    errors: z.array(CheckProblem),
    /** The contracts of the workflows it calls, as the check met them. */
    calls: z.array(FlowCall),
  }),
);

/**
 * The records a script writes with `emit`: every type under `wf.`, with data of any shape.
 *
 * A composition may declare a type of its own under `wf.` (`emits`) to give its data a schema; the
 * others are this one.
 */
export const ScriptRecord = record("wf.*", z.unknown());

/** The types of the workflow module. */
/** A group of branches of a run opened: its key prefix, what leaving it does, its deadline, and whether an outer cancel waits for it. */
export const ScopeOpened = record(
  "workflow.scope.opened",
  z.object({
    run: RunId,
    scope: z.string(),
    onExit: z.enum(["wait", "cancel"]),
    /** The moment the group runs out of time, in milliseconds since the epoch. */
    deadline: z.number().optional(),
    onDeadline: z.enum(["skip", "fail"]).optional(),
    shield: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
);

/** A branch joined a group: written before the branch makes its first step. */
export const ScopeBranched = record("workflow.scope.branched", z.object({ run: RunId, scope: z.string(), key: z.string() }));

/** A branch of a group ended. `order` is its place among the outcomes of the group: the order `next()` gives them in. */
export const ScopeSettled = record(
  "workflow.scope.settled",
  z.object({
    run: RunId,
    scope: z.string(),
    key: z.string(),
    order: z.number().int().nonnegative(),
    outcome: ScopeOutcome,
    error: z.object({ name: z.string(), message: z.string() }).optional(),
  }),
);

/** A group closed: its block returned, threw, or ran out of time, and every branch of it ended. */
export const ScopeClosed = record("workflow.scope.closed", z.object({ run: RunId, scope: z.string(), outcome: ScopeClosing }));

export const WORKFLOW_TYPES = [
  ScriptRecord,
  RunRequested,
  RunStarted,
  PhaseEntered,
  PhaseLeft,
  StepPhase,
  RunLog,
  RunPaused,
  RunPauseRequested,
  RunContinued,
  RunFinished,
  StepReused,
  ScopeOpened,
  ScopeBranched,
  ScopeSettled,
  ScopeClosed,
  SubscriptionInstalled,
  SubscriptionUninstalled,
  WorkflowRegistered,
  WorkflowRechecked,
  BuiltinsWanted,
];
