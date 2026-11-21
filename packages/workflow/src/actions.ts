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
  ShownCall,
  Subscription,
  WorkflowId,
  WorkflowVersion,
} from "./records.ts";
import { WorkflowPhases } from "./language.ts";
import { RunState, RunStatus } from "./status.ts";
import { WorkflowInspection } from "./inspect.ts";

export const StartInput = z.object({
  /** The registered workflow to run, at its latest version: its id or any text that names it. */
  id: IdText.optional(),
  /** A script file to run once, unregistered. A start names `id` or `file`, not both. */
  file: z.string().optional(),
  args: z.unknown().optional(),
  label: z.string().optional(),
  /** Run the script process in an empty box. Default: the module's own choice, which is no box. */
  box: z.boolean().optional(),
  /** Answer when the run finishes or pauses, or when `timeoutMs` has passed, as `workflow.wait` does. Default: answer at once. */
  wait: z.boolean().optional(),
  /** With `wait`: how long to wait, in milliseconds. Default: a minute. */
  timeoutMs: z.number().int().positive().optional(),
});
export const RunInput = z.object({ run: z.string() });
/** What a resume may say: which run, and with `choice` how to answer its pause. */
export const ResumeInput = RunInput.extend({
  /** Answer the pause of the run: retry the step it paused on, skip it, or cancel the run. Without it the run is started again from the top. */
  choice: z.enum(["retry", "skip", "cancel"]).optional(),
});
export const ReviseInput = z.object({ run: z.string(), file: z.string() });

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

/** What a revision found: what is reused, what runs again and what is shown. */
export const Revision = z.object({
  reused: z.array(z.object({ key: z.string(), action: z.string(), input: JsonValueSchema, outcome: JsonValueSchema })),
  rerun: z.array(
    z.object({
      key: z.string(),
      action: z.string(),
      input: JsonValueSchema,
      reason: z.enum(["new key", "unfinished"]),
    }),
  ),
  shown: z.array(ShownCall),
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
    "Start a run: a registered workflow by its id (its latest version), or a script file run once, and the arguments it gets. Answers the id of the run (run-…). A broken workflow does not start.",
  input: StartInput,
  output: StartOutput,
});

export const workflowResume = actionRef("workflow.resume", {
  description: "Run a workflow again from the top: the calls that finished are answered from the journal. A script that was edited is a revision: what it would show is found first, and the run pauses on it. With choice (retry, skip or cancel) it answers the pause of the run instead. For whoever started the run, and the owner.",
  input: ResumeInput,
  output: ResumeOutput,
});

export const workflowPause = actionRef("workflow.pause", {
  description: "Request a durable pause at a workflow boundary. Operations already admitted can complete. Answers the current state and the pause identifier. For whoever started the run, and the owner.",
  input: RunInput,
  output: RunStatus,
});

export const workflowContinue = actionRef("workflow.continue", {
  description: "Release the specified manual pause and let the same workflow invocation continue. An outstanding question or failed step keeps its own state. For whoever started the run, and the owner.",
  input: RunInput.extend({ pause: z.string().min(1) }),
  output: RunStatus,
});

export const workflowRevise = actionRef("workflow.revise", {
  description: "Resume an edited workflow script: unchanged calls reuse their results, new calls run, and a changed input under an old key is shown and nothing runs.",
  input: ReviseInput,
  output: ReviseOutput,
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
  description: "The runs, one line each: the id, the name, the state, a few words of what it is up to or how it ended, the questions it asked, and for a paused run the command that answers it.",
  input: RunsInput,
  output: z.object({ runs: z.array(z.string()) }),
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
    "Install a workflow that niwa starts by itself: one run per record that matches its `on`. A registered workflow by its id, or a script file. Answers the id of the installation (sub-…). The runs are held to the profile wf:<sub-…> (the id of the installation), which is narrow(the caller's grant, uses). Records from before the installation start nothing.",
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
    "Register a workflow script: it becomes the action flow.<id>, with its input and output as its schemas. Without id a new workflow is made and its id (wf-…) is answered; with id the script is a new version of that workflow; a built-in (one a plugin ships) is refused, its versions come with the plugin. The version is the hash of the script and the local files it imports. A changed contract checks the workflows that call it again, and the ones that no longer pass are marked broken.",
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
