/**
 * The actions of the workflow module, as typed references: name, description and the two schemas.
 *
 * A caller imports these to call a workflow action with input and output checked by the type
 * checker, on the host and on a client. The module's factory builds its real actions from the same
 * references (`action(workflowStart, { recovery, run })`).
 */

import { z } from "zod";

import { EntityDescription, IdText, JsonValueSchema, actionRef, getRef, listRef } from "@niwa-labs/core";

import {
  Builtin,
  CheckProblem,
  ContractHash,
  EmittedRecord,
  FlowCall,
  InstallationId,
  JsonSchemaValue,
  RunId,
  Subscription,
  TrialVersion,
  WorkflowId,
  WorkflowVersion,
} from "./records.ts";
import { WorkflowPhases } from "./language.ts";
import { RunEntry, RunState, RunStatus } from "./status.ts";
import { WorkflowInspection } from "./inspect.ts";

/** An absolute path: a POSIX root, or a drive letter and a separator. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

export const StartInput = z.object({
  /** The registered workflow to run, at its latest version: its id or any text that names it. */
  id: IdText.optional(),
  /**
   * With `id`: run this version of it instead of the latest. A candidate version of a gated built-in is started only by a
   * run in the trusted suite's pinned trial.
   */
  version: WorkflowVersion.optional(),
  /** A script file to run once, unregistered. A start names `id` or `file`, not both. */
  file: z.string().optional(),
  args: z.unknown().optional(),
  label: z.string().optional(),
  /** Run the script process in an empty box. Default: the module's own choice, which is no box. */
  box: z.boolean().optional(),
  /**
   * The directory the run is for, an absolute path: the project it belongs to, which the cockpit groups runs by. The CLI and
   * the MCP server fill it with their working directory when the caller names none; a start with none has no directory.
   */
  directory: z.string().regex(ABSOLUTE_PATH, "a directory is an absolute path").optional(),
  /** The most branches each scope of the run runs at once; a scope's own lower limit holds. Default: no limit from outside. */
  concurrency: z.number().int().positive().optional(),
  /**
   * The limits of the run: `depth`, how many runs deep its tree may go, the run itself being one; `deadline`, how long the
   * whole script may take, in milliseconds. A run that reaches its deadline pauses until it is extended or cancelled. Its
   * child runs take them, and never end later than it.
   */
  limits: z.object({ depth: z.number().int().positive().optional(), deadline: z.number().int().positive().optional() }).optional(),
  /**
   * Rules that narrow the run below what `uses` and the caller give it, never wider: a call of the run is decided on its
   * final input against them. A rule the run would not have refuses the start.
   */
  allow: z.array(z.string().min(1)).optional(),
  /** Answer when the run finishes or pauses, or when `timeoutMs` has passed, as `workflow.wait` does. Default: answer at once. */
  wait: z.boolean().optional(),
  /** With `wait`: how long to wait, in milliseconds. Default: a minute. */
  timeoutMs: z.number().int().positive().optional(),
});
export const RunInput = z.object({ run: z.string() });
/** What a resume may say: which run, and with `choice` how to answer its pause. */
/** Run again the steps from one on: a step key, the key prefix of a branch or a scope, or the title of a phase. */
const From = z.string().min(1);
export const ResumeInput = RunInput.extend({
  /** Answer the pause of the run: retry the step it paused on, skip it, or cancel the run. Without it the run is started again from the top. */
  choice: z.enum(["retry", "skip", "cancel"]).optional(),
  /** Started again from the top, run the steps from this one on instead of taking them from the earlier start. */
  from: From.optional(),
});
export const ReviseInput = z.object({ run: z.string(), file: z.string(), from: From.optional() });

export const RunOutput = z.object({ run: RunId, finished: z.boolean() });

/** What a start answers: the run, and with `wait` where it got to. */
export const StartOutput = RunOutput.merge(RunStatus.partial().omit({ run: true }));

export const WaitInput = z.object({
  run: z.string(),
  /** How long to wait, in milliseconds. Default: a minute. */
  timeoutMs: z.number().int().positive().optional(),
});

export const RunsInput = z.object({
  /** Only the runs in this state. */
  state: RunState.optional(),
  /** Only the latest this many runs. */
  limit: z.number().int().positive().optional(),
});

/** What a revision found: the calls taken from the earlier starts of the run, and the ones that run again. */
export const Revision = z.object({
  reused: z.array(z.object({ key: z.string(), action: z.string(), input: JsonValueSchema, outcome: JsonValueSchema })),
  rerun: z.array(
    z.object({
      key: z.string(),
      action: z.string(),
      input: JsonValueSchema,
      reason: z.enum(["new", "changed", "unfinished", "after a change", "recomputed"]),
    }),
  ),
  /** Why the edited script could not be read to its end, when it could not. */
  unresolved: z.string().optional(),
});

export const CheckInput = z.object({ file: z.string() });

/** One error of a check, with its place in the file. */
export const CheckError = CheckProblem;

/** What a script declares: its description, its schemas as JSON Schema, and the hash of the two schemas. */
export const ScriptContract = z.object({
  description: z.string().optional(),
  /** What the script takes: absent for a script with no `input` and for a script with `on`, which is given the record. */
  input: JsonSchemaValue.optional(),
  /** What the script returns: absent when it returns nothing. */
  output: JsonSchemaValue.optional(),
  contract: ContractHash,
});

/** A check: the errors, and what the script declares when its schemas could be read. */
export const CheckOutput = ScriptContract.partial().extend({
  /** The records the script emits: the name it gives each, its type `wf.<name>.<record>`, and the JSON Schema of its data. */
  emits: z.array(EmittedRecord).optional(),
  /** The phases the script declares, in order. */
  phases: WorkflowPhases.optional(),
  file: z.string(),
  ok: z.boolean(),
  errors: z.array(CheckError),
  /** What the check could not settle, such as an `ask()` call whose harness is known only when the script runs; absent when there is none. */
  warnings: z.array(CheckError).optional(),
  note: z.literal("described, the script was not run"),
});

export const GuideOutput = z.object({
  /** How to write a script. */
  guide: z.string(),
  /** The typing of a script, generated from the actions the caller may call. */
  declarations: z.string(),
  /** The actions the caller may call, with the type of their input as the declarations name it. */
  actions: z.array(z.object({ name: z.string(), description: z.string(), input: z.string() })),
});

export const ReviseOutput = RunOutput.extend({ revision: Revision });

export const ResumeOutput = RunOutput.extend({ revision: Revision.optional() });

export const workflowStart = actionRef("workflow.start", {
  description:
    "Run a script now: a registered workflow by its id (its latest version), or a script file run once, and the arguments it gets. It starts one run and subscribes to nothing (workflow.install does that). Answers the id of the run (run-…). A broken workflow does not start.",
  input: StartInput,
  output: StartOutput,
});

export const workflowResume = actionRef("workflow.resume", {
  description: "Run a workflow again from the top: the calls along the longest unchanged prefix of the earlier start are taken from it (each marked as taken), and the first new or changed call and everything after it run; a call with an effect that was made before is never made twice. from names a step, a branch or a phase to run again from. A script that was edited is a revision, and the answer says what is taken and what runs. With choice (retry, skip or cancel) it answers the pause of the run instead. For whoever started the run, and the owner.",
  input: ResumeInput,
  output: ResumeOutput,
});

/** What a pause may say: which run, and with `effects: "deny"` a hold instead of a pause at a boundary. */
export const PauseInput = RunInput.extend({
  /**
   * `"deny"`: hold the run instead of pausing it. A new call of an action that writes or cannot be undone is refused;
   * reads and niwa's own records go on, and operations already going are left to end.
   */
  effects: z.literal("deny").optional(),
  /** With `effects: "deny"`: hold the runs this run started too, at any depth. A pause at a boundary goes down the tree by itself. */
  tree: z.boolean().optional(),
});

export const workflowPause = actionRef("workflow.pause", {
  description:
    'Request a durable pause at a workflow boundary. Operations already admitted can complete. Answers the current state and the pause identifier. With effects: "deny" the run is held instead: new writes and irreversible calls are refused while reads and records of niwa\'s own go on; the hold is holding while operations it began are still going (listed in hold.inFlight) and held once they ended; tree: true holds the runs it started too. workflow.continue with the hold\'s id releases it. For whoever started the run, and the owner.',
  input: PauseInput,
  output: RunStatus,
});

export const workflowBuiltinTrial = actionRef("workflow.builtin.trial", {
  description: "Pin the offered versions for an approved built-in suite run and its descendants. Only the plugin's designated suite may open a trial.",
  input: z.strictObject({}),
  output: z.object({ entries: z.array(TrialVersion) }),
});

export const workflowBuiltinPromote = actionRef("workflow.builtin.promote", {
  description: "Accept all candidates pinned by this suite run. If the proposal or the accepted set has changed, accept none and return stale.",
  input: z.strictObject({}),
  output: z.object({
    status: z.enum(["promoted", "stale"]),
    run: RunId,
    versions: z.array(z.object({ workflow: WorkflowId, version: WorkflowVersion })),
  }),
});

export const workflowContinue = actionRef("workflow.continue", {
  description: "Release the specified manual pause and let the same workflow invocation continue. An outstanding question or failed step keeps its own state. For whoever started the run, and the owner.",
  input: RunInput.extend({ pause: z.string().min(1) }),
  output: RunStatus,
});

export const workflowRevise = actionRef("workflow.revise", {
  description: "Resume a run on an edited script: the calls along the longest unchanged prefix of the earlier start are taken from it, and the first new or changed call and everything after it run; a call with an effect that was made before is never made twice. from names a step, a branch or a phase to run again from.",
  input: ReviseInput,
  output: ReviseOutput,
});

/** What a stop names: the run, and a branch, scope or step of it by its key prefix; with none, the whole run. */
export const StopInput = RunInput.extend({
  /** The key prefix of what is stopped: a scope (`@review`), a branch of it (`@review.a`), or a step. Absent: the whole run. */
  at: z.string().min(1).optional(),
  /** Stop through the shields under it as well: their blocks are not waited for. */
  force: z.boolean().optional(),
  /** Why it is stopped, which the cancelled steps keep. Default: stopped by the owner. */
  reason: z.string().min(1).optional(),
});

export const workflowStop = actionRef("workflow.stop", {
  description:
    "Stop a branch, a scope or a step of a run by its key prefix: its steps end as cancelled, its sessions are interrupted and its child runs cancelled, and the rest of the run goes on. A shielded scope under it is spared unless force is set. Without at it stops the whole run with its child runs. For whoever started the run, and the owner.",
  input: StopInput,
  output: RunOutput,
});

export const workflowExtend = actionRef("workflow.extend", {
  description:
    "Move the deadline of a run later by `by` milliseconds, from the deadline or from now when it has passed. A run paused at its deadline goes on. For whoever started the run, and the owner.",
  input: RunInput.extend({ by: z.number().int().positive() }),
  output: RunStatus,
});

export const workflowCancel = actionRef("workflow.cancel", {
  description: "End a workflow run and interrupt the sessions it started. For whoever started the run, and the owner.",
  input: RunInput,
  output: RunOutput,
});

export const workflowWait = actionRef("workflow.wait", {
  description: "Wait for a run to finish or pause: the state (finished, paused or running), the result or the reason and the choices, and the questions the run asked that are still open. The end of the timeout is not an error: the state is then running.",
  input: WaitInput,
  output: RunStatus,
});

export const workflowInspect = actionRef("workflow.inspect", {
  description: "Read a run's current state and the phases and script steps recorded in the journal. For whoever started the run, and the owner.",
  input: RunInput,
  output: WorkflowInspection,
});

export const workflowRuns = actionRef("workflow.runs", {
  description: "The runs, one line each: the id, the name, the state, a few words of what it is up to or how it ended, the questions it asked, and for a paused run the command that answers it. `entries` has the same runs as fields, with the directory each was started for.",
  input: RunsInput,
  output: z.object({ runs: z.array(z.string()), entries: z.array(RunEntry) }),
});

export const workflowCheck = actionRef("workflow.check", {
  description: "Type-check a workflow script against the actions the caller may call, and the uses of the script, and read what it declares (description, input and output as JSON Schema, the contract hash). The module is loaded in a disposable process to read its schemas; the script function is not run. Returns the errors with file, line and column.",
  input: CheckInput,
  output: CheckOutput,
});

export const workflowGuide = actionRef("workflow.guide", {
  description: "How to write a workflow script: a short guide, the generated TypeScript declarations of everything a script may call, and the catalogue of those actions.",
  input: z.object({}),
  output: GuideOutput,
});

export const InstallInput = z.object({
  /** The registered workflow to install, at its latest version: its id or any text that names it. */
  id: IdText.optional(),
  /** A script file to install, unregistered. An installation names `id` or `file`, not both. */
  file: z.string().optional(),
  /** What the installation is for, in a few words. */
  description: EntityDescription,
  /** Run the scripts of the installation in an empty box. Default: the module's own choice, which is no box. */
  box: z.boolean().optional(),
});
export const UninstallInput = z.object({ id: IdText });

/** An installation as `workflow.installation.get` shows it. */
export const Installation = ScriptContract.omit({ description: true }).extend({
  id: InstallationId,
  description: EntityDescription,
  workflow: WorkflowId.optional(),
  version: WorkflowVersion.optional(),
  file: z.string(),
  hash: z.string(),
  on: z.array(Subscription),
  uses: z.array(z.string()),
  /** Why its runs do not start: the workflow it installed is broken. */
  broken: z.string().optional(),
  /** The built-in it is, and the plugin that ships it: it is not uninstalled by hand. */
  builtin: Builtin.optional(),
});

export const workflowInstall = actionRef("workflow.install", {
  description:
    "Subscribe a workflow: niwa starts it by itself, one run per record that matches its `on`; nothing runs now (workflow.start runs a script once). A registered workflow by its id, or a script file. Answers the id of the installation (sub-…). The runs are held to the profile wf:<sub-…> (the id of the installation), which is narrow(the caller's grant, uses). Records from before the installation start nothing.",
  input: InstallInput,
  output: z.object({ id: InstallationId, profile: z.string(), on: z.array(Subscription) }),
});

export const workflowUninstall = actionRef("workflow.uninstall", {
  description: "Remove an installation: nothing starts from it any more, and its profile is emptied. Runs that live are left to end. For whoever installed it, and the owner. A built-in is refused: it is turned off by the option of its plugin.",
  input: UninstallInput,
  output: z.object({ id: InstallationId }),
});

export const workflowInstallationList = listRef("workflow.installation.list", {
  kind: "subscription",
  noun: "workflow installation",
  detail: "Only the installations that stand.",
  item: { workflow: WorkflowId.optional(), file: z.string(), hash: z.string(), on: z.array(Subscription), builtin: Builtin.optional() },
});

export const workflowInstallationGet = getRef("workflow.installation.get", {
  kind: "subscription",
  noun: "workflow installation",
  entity: Installation,
});

export const RegisterInput = z.object({
  file: z.string(),
  /** Register the script as a new version of this workflow. Without it, the script is a new workflow. */
  id: IdText.optional(),
});

export const workflowRegister = actionRef("workflow.register", {
  description:
    "Register a workflow script: it becomes the action flow.<id>, with its input and output as its schemas. Without id a new workflow is made and its id (wf-…) is answered; with id the script is a new version of that workflow, which only whoever made it and the owner may register; a built-in (one a plugin ships) is refused, its versions come with the plugin. The version is the hash of the script and the local files it imports. A changed contract checks the workflows that call it again, and the ones that no longer pass are marked broken.",
  input: RegisterInput,
  output: z.object({
    id: WorkflowId,
    version: WorkflowVersion,
    description: EntityDescription,
    /** Whether this version is new: registering the same version again changes nothing. */
    added: z.boolean(),
    /** The workflows that call this one and were checked again, and whether each passed. */
    rechecked: z.array(z.object({ id: WorkflowId, version: WorkflowVersion, ok: z.boolean() })),
  }),
});

/** One version of a registered workflow, as `workflow.get` shows it. */
export const WorkflowVersionEntry = z.object({
  version: WorkflowVersion,
  /** The file the version was registered from. */
  file: z.string(),
  /** The copy of its code niwa keeps in its home: what the version runs from. Absent when niwa holds no copy of it. */
  stored: z.string().optional(),
  description: EntityDescription,
  input: JsonSchemaValue.optional(),
  output: JsonSchemaValue.optional(),
  contract: ContractHash,
  uses: z.array(z.string()),
  calls: z.array(FlowCall),
  /** The record types it declares in `emits`. */
  emits: z.array(EmittedRecord).optional(),
  /** The records that start it once it is installed: a workflow without them can be started, not installed. */
  on: z.array(Subscription).optional(),
  /** The phases it declares, in order: the plan a run of it is shown against. */
  phases: WorkflowPhases.optional(),
  /** Why it does not start, when it is broken. */
  broken: z.string().optional(),
  /** A candidate version of a gated built-in: not accepted yet, it is started only by name of its version. */
  candidate: z.literal(true).optional(),
  /** A candidate superseded by another proposal before acceptance. */
  superseded: z.literal(true).optional(),
});

export const workflowList = listRef("workflow.list", {
  kind: "workflow",
  noun: "workflow",
  detail: "Each is the action flow.<id>.",
  item: {
    version: WorkflowVersion,
    versions: z.number().int(),
    broken: z.boolean(),
    installations: z.array(InstallationId),
    /** The phases its latest version declares, in order. */
    phases: WorkflowPhases.optional(),
    /** The built-in it is, and the plugin that ships it. */
    builtin: Builtin.optional(),
  },
});

export const workflowGet = getRef("workflow.get", {
  kind: "workflow",
  noun: "workflow",
  detail: "Its versions, the latest last, with their schemas and whether they are broken, and its installations.",
  entity: z.object({
    id: WorkflowId,
    description: EntityDescription,
    versions: z.array(WorkflowVersionEntry),
    installations: z.array(InstallationId),
    /** The built-in it is, and the plugin that ships it. */
    builtin: Builtin.optional(),
  }),
});
