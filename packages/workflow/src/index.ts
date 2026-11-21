/**
 * The workflow module: a named script of steps, run in any harness.
 *
 * - `workflow.register`, `workflow.list`, `workflow.get` — a script registered as a workflow `wf-…`, with
 *   versions (the hash of its source closure); every registered workflow is the action `flow.<id>`;
 * - `workflow.start` — start a run `run-…` of a registered workflow by its id, or of a script file once;
 * - `workflow.resume` — start a run again from the top with the file and arguments it was started
 *   with, and the calls that finished are answered from the journal; a script that was edited in
 *   place is a revision: what it would show is found first, and the run pauses on it;
 * - `workflow.revise` — report what an edited script reuses, reruns and shows, then run it unless
 *   something is shown;
 * - `workflow.pause` and `workflow.continue` — hold and release the same invocation at a script boundary;
 *   admitted operations can finish, and the pause survives a host restart on the same plugin version.
 * - `workflow.cancel` — end a run, and interrupt the sessions it started; resume, revise, cancel and
 *   uninstall are for whoever started the run or made the installation, and for the owner;
 * - `workflow.check` — type-check a script against the actions the caller may call, and read what it declares, without
 *   running it; `workflow.start` refuses a script that does not pass;
 * - `workflow.guide` — how to write a script, with the generated typing and the action catalogue;
 * - `workflow.install`, `workflow.uninstall`, `workflow.installation.list`, `workflow.installation.get` — a
 *   script with `on` that niwa itself starts, one run per record that matches, under the profile `wf:<sub-…>`.
 *
 * A script is `export default workflow({ input, output, ... }, fn)`: the module is loaded in a
 * disposable process to read its schemas (`describe.ts`), the arguments of a start are held to `input`
 * before a run exists, the result to `output` when it ends (`workflow.run.finished` carries a typed
 * outcome), and the run keeps the hash of its contract: a resume under another one stops on the
 * `revise` pause when what the run recorded no longer passes.
 *
 * A run is an invocation of the plugin's handler, so its calls are steps of that invocation. A
 * failure pauses the run with the choices of the core. The workflow does not repair itself.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import { AccessGranted, CANCEL_STEPS_ACTION, CORE_TYPES, DESCRIPTION_MAX, DESCRIPTION_MIN, DeniedError, EntityDescription, IdIndex, JsonValueSchema, RESOLVE_ACTION, action, cancelHolds, keyUnder, runIdOfPrincipal, callerOf, fillRule, grant, isRuleTemplate, jsonOf, narrow, principalOf, record, recordId, rule, seq, ruleText, specsOf, storedOutcome, toJsonSchema } from "@niwa-labs/core";
import { COCKPIT_MODULE, plugin } from "@niwa-labs/plugin";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HOST_KEY_FILE, OWNER_TOKEN_FILE } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, PENDING_EXTERNAL, PendingExternalAnswerSchema, SCRIPT_PACKAGE } from "@niwa-labs/plugin";
import type { ServiceContext, Subscriber } from "@niwa-labs/plugin";
import type { Action, ActionContext, ArtifactStore, Caller, Grant, Handler, IssuedId, JournalReader, JsonSchema, Principal, RecordType, RuleSpec, Seq, StepsCancelled, StoredRecord } from "@niwa-labs/core";
import { scriptOn } from "@niwa-labs/script";
import { requireBox } from "@niwa-labs/sandbox";
import type { BoxSandboxName } from "@niwa-labs/sandbox";
import { requestCancel } from "@niwa-labs/requests/records";
import { SessionEnded, SessionMarked, SessionStarted, SessionStartReserved, sessionEnd, sessionInterrupt } from "@niwa-labs/sessions/records";

import { AskCancelled, AskExpired, bridge } from "./bridge.ts";
import {
  workflowCancel,
  workflowStop,
  workflowCheck,
  workflowContinue,
  workflowExtend,
  workflowPause,
  workflowBuiltinPromote,
  workflowGet,
  workflowGuide,
  workflowInspect,
  workflowInstall,
  workflowInstallationGet,
  workflowInstallationList,
  workflowList,
  workflowRegister,
  workflowResume,
  workflowRevise,
  workflowRuns,
  workflowStart,
  workflowUninstall,
  workflowWait,
} from "./actions.ts";
import { actionName, holds } from "@niwa-labs/core";
import { catalogueFor } from "./catalogue.ts";
import { neutralValue } from "./ask.ts";
import { isUse, scriptChecker, scriptReads, scriptUses, useName, withDeclaration } from "./check.ts";
import { describer } from "./describe-cache.ts";
import { contractOf, emittedTypesOf } from "./describe.ts";
import type { Described } from "./describe.ts";
import type { CheckError, CheckReport } from "./check.ts";
import { guideFor } from "./guide.ts";
import { inspectRun } from "./inspect.ts";
import { SCRIPT_TYPES, agentActionName } from "./language.ts";
import { sessionAgent } from "./agent.ts";
import type { HarnessLaunch } from "./agent.ts";
import {
  Builtin,
  BuiltinsWanted,
  BuiltinPromoted,
  InstallationId,
  ContractHash,
  Issue,
  JsonSchemaValue,
  RunFinished,
  RunLog,
  RunOutcome,
  RunPaused,
  RunPauseRequested,
  RunDeadlineExtended,
  RunHoldRequested,
  RunContinued,
  PhaseEntered,
  PhaseLeft,
  ScopeBranched,
  ScopeClosed,
  ScopeOpened,
  StepPhase,
  RunId,
  RunRequested,
  RunStarted,
  ScriptRecord,
  SubscriptionInstalled,
  SubscriptionUninstalled,
  WORKFLOW_TYPES,
  WorkflowRechecked,
  WorkflowRegistered,
  WantedBuiltin,
  WorkflowVersion,
} from "./records.ts";
import type { EmittedRecord, FlowCall, Subscription, WorkflowId } from "./records.ts";
import { builtinOf, declaredBy, dependentsOf, flowActionName, readersOf, versionOf, workflowIdsOf, workflowsOf } from "./registry.ts";
import { packageRoots } from "./installation.ts";
import { linkOfferedPackages, offeredPackageOf, storedEntry, storedVersion, storeVersion, workflowsDir } from "./store.ts";
import type { OfferedPackage } from "./store.ts";
import type { RegisteredWorkflow } from "./registry.ts";
import { decide } from "./revise.ts";
import type { CurrentCall, RecordedCall, RevisionReport } from "./revise.ts";
import { runScript, stopRun } from "./runner.ts";
import { StatsFold, workflowStats } from "./stats.ts";
import type { ScriptBox } from "./runner.ts";
import { activeHold, activeManualPause, deadlineOf, deadlineReached, holdOver, manualPausesOf, openRequestsOfInvocations, runEntry, runExists, runIds, runLine, statusOf } from "./status.ts";
import type { PendingOperations, RunState as RunStateName, RunStatus } from "./status.ts";
import { installationIdsOf, installationsOf, profileOf, profileRulesOf, standing } from "./subscriptions.ts";
import type { Installation } from "./subscriptions.ts";

/** What the module is given. */
export interface WorkflowOptions {
  /** The action every agent call goes to. Default: `session.start.<harness>`. A test points it at a stub. */
  agentAction?: Action<any, any>;
  /** The actions agent calls go to, by harness name; `agentAction` serves the harnesses not listed. */
  agents?: Record<string, Action<any, any>>;
  /**
   * The harnesses a script may name.
   *
   * The plugin registers the agent action of each of them — `session.start.<harness>` — so a
   * script that names a harness reaches the agents of that harness with no hand glue. A harness given with the
   * `models` or `efforts` its adapter knows holds a script to them: a model or an effort outside them is an error of
   * the check, and of the call. The options block a harness takes is the one the sessions module binds it to
   * (`harness.list`): the block of another kind is an error of the check, and of the call.
   */
  harnesses?: ReadonlyArray<string | ({ readonly id: string } & HarnessLaunch)>;
  /** The directory relative script paths are resolved against. */
  root?: string;
  /**
   * The record types a script may `emit`: only the script's own, `wf.<name>.*`.
   *
   * Record types are declared when a plugin is installed, so the types a script writes are given
   * here and the plugin declares them.
   */
  emits?: readonly RecordType<any>[];
  /**
   * The record types a script may start on (`on`).
   *
   * Handlers are registered when a plugin is installed, so the types a script may subscribe to are
   * given here, as the types it may `emit` are: as types, or by name, which is resolved against the
   * types of the plugins installed before this one. A script that lists another type does not pass
   * its check, and so cannot be installed.
   *
   * The records of scripts, `wf.*`, need no entry: any script may start on what another one emits.
   */
  triggers?: ReadonlyArray<RecordType<any> | string>;
  /**
   * Run the script processes in an empty box when a start or an installation does not say. Default:
   * no box, a plain child process; the owner usually runs without one.
   */
  box?: boolean;
  /** The sandbox of a box. Default: `srt`. */
  sandbox?: BoxSandboxName;
}

/** Where a run came from: the workflow and version it runs, the installation that started it. */
interface RunOrigin {
  workflow?: WorkflowId;
  version?: WorkflowVersion;
  installation?: InstallationId;
  directory?: string;
  parent?: { run: string; step: string };
  concurrency?: number;
  limits?: { depth?: number; deadline?: number };
  allow?: { rules: string[]; version: string };
}

/** A run as `workflow.run.started` records it. */
interface RunFacts extends RunOrigin {
  file: string;
  args: unknown;
  label?: string;
  /** The hash of the contract the run began under, when it could be read. */
  contract?: ContractHash;
  /** The hash of the script file at the start of the run, when it could be read. */
  hash?: string;
  /** Whether the script process runs in a box, as the run was born. */
  box?: boolean;
  /** The invocations that ran the script, one per start. */
  invocations: string[];
}

/**
 * What the latest invocation of a run is doing.
 *
 * A run is an invocation of the plugin's handler, and a resume or a revision starts another
 * one: the two would write over the same children of the run. So the state of the latest
 * invocation is what says whether the run may be started again.
 */
type RunState = "running" | "waiting" | "paused" | "done";

/** What the sync of one built-in answers, and what the retirement of the ones no plugin offers takes and answers. */
const BuiltinSynced = z.object({ workflow: z.string(), installation: z.string().optional() });
const BuiltinRetireInput = z.object({ keep: z.array(Builtin) });
const BuiltinRetired = z.object({ uninstalled: z.array(z.string()) });

/** How long `workflow.wait` waits when it is not told, in milliseconds. */
const DEFAULT_WAIT_MS = 60_000;

/** How deep runs may call other workflows: a run whose request has more runs above it does not start. */
const CALL_DEPTH = 16;


/** The plugin of the module. */
export function workflow(opts: WorkflowOptions = {}) {
  // The agent action of every harness the plugin was given: a script that names a harness
  // reaches the agents of that harness, and nothing else is asked of the host.
  const harnessActions = new Map<string, Action<any, any>>();
  for (const harness of opts.harnesses ?? []) {
    const { id, ...launch } = typeof harness === "string" ? { id: harness } : harness;
    harnessActions.set(id, sessionAgent(id, launch));
  }
  const actionFor = (harness: string | undefined): Action<any, any> | undefined => {
    if (harness === undefined) return opts.agentAction;
    return opts.agents?.[harness] ?? harnessActions.get(harness) ?? opts.agentAction;
  };
  const actionNameOf = (harness: string | undefined): string =>
    String(actionFor(harness)?.name ?? agentActionName(harness));

  const checkScript = scriptChecker();

  const emits = new Map<string, RecordType<any>>();
  for (const type of opts.emits ?? []) {
    if (!type.name.startsWith(SCRIPT_TYPES)) {
      throw new TypeError(`workflow({ emits }): a script may emit only "${SCRIPT_TYPES}<name>.*" types, not "${type.name}"`);
    }
    emits.set(type.name, type);
  }

  return plugin("workflow", (api) => {
    /** The clock of the host, once it serves: what the deadline of a group, and of a run, is measured by. */
    let hostClock: ServiceContext | undefined;
    /** The moment now, by the clock of the host once it serves. */
    const clockNow = (): number => hostClock?.now() ?? Date.now();
    const scheduleAt = (at: number, fn: () => void): (() => void) => {
      if (hostClock !== undefined) return hostClock.schedule(at, fn);
      const timer = setTimeout(fn, Math.max(0, at - Date.now()));
      return () => clearTimeout(timer);
    };
    // The page of this plugin in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "workflow", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });
    api.declare(...WORKFLOW_TYPES, ...emits.values());

    const triggers = new Map<string, RecordType<any>>();
    for (const entry of opts.triggers ?? []) {
      const type = typeof entry === "string" ? (emits.get(entry) ?? api.recordType(entry)) : entry;
      if (type !== undefined) triggers.set(type.name, type);
      else if (typeof entry === "string" && !entry.startsWith(SCRIPT_TYPES)) {
        throw new TypeError(
          `workflow({ triggers }): "${entry}" is not a record type of a plugin installed before workflow: install the plugin that declares it first`,
        );
      }
    }
    // The built-ins the plugins installed before this one offer: the types they start on are triggers as the given ones are.
    // A plugin installed after this one that offers a built-in is refused by the host: it would never be installed.
    for (const { plugin: by, value } of api.offers(BUILTIN_WORKFLOW)) {
      for (const entry of value.triggers ?? []) {
        const type = typeof entry === "string" ? api.recordType(entry) : entry;
        if (type === undefined) {
          throw new TypeError(
            `the built-in workflow "${value.name}" of "${by}" starts on "${String(entry)}", a record type no plugin installed before workflow declares`,
          );
        }
        if (!type.name.startsWith(SCRIPT_TYPES)) triggers.set(type.name, type);
      }
    }
    /**
     * The packages the plugins give scripts from outside niwa's tree, read once every plugin is installed: a stored copy
     * finds them, and a box may read them and what they load. An offer that is not a niwa package at its folder, or a
     * second folder for a name, is not given to scripts, and the host says why when it starts.
     */
    let offered: { packages: OfferedPackage[]; roots: string[]; refused: string[] } | undefined;
    const scriptPackages = (): { packages: OfferedPackage[]; roots: string[]; refused: string[] } => {
      if (offered !== undefined) return offered;
      const packages: OfferedPackage[] = [];
      const refused: string[] = [];
      for (const { plugin: by, value } of api.offers(SCRIPT_PACKAGE)) {
        const found = offeredPackageOf(value.name, value.root);
        const known = typeof found === "string" ? undefined : packages.find((one) => one.name === found.name);
        if (typeof found === "string") refused.push(`the package "${by}" offers scripts is not given to them: ${found}`);
        else if (known !== undefined && known.root !== found.root) refused.push(`${found.name} is offered to scripts from ${known.root}, so not from ${found.root}`);
        else if (known === undefined) packages.push(found);
      }
      offered = { packages, roots: packages.flatMap((one) => packageRoots(one.root)), refused };
      return offered;
    };

    // The types a script may start on, with the schema of their data: the triggers, and the records of scripts that have a schema.
    const triggerSchemas = [...new Map([...emits, ...triggers]).values()].map((type) => ({
      name: type.name,
      schema: toJsonSchema(type.schema, "input"),
    }));

    /**
     * The types a script may start on, wait for and read, with the schema of their data: the ones above, and the record
     * types the registered workflows declare in `emits` (the latest version of each), which grow from the journal as
     * `flow.<id>` does. A type the composition gives keeps its own schema.
     */
    const triggersNow = (): Array<{ name: string; schema: JsonSchema }> => {
      const known = new Map<string, { name: string; schema: JsonSchema }>(triggerSchemas.map((entry) => [entry.name, entry]));
      if (api.journal?.() === undefined) return [...known.values()];
      for (const registered of workflowsOf(journal())) {
        for (const declared of registered.latest.emits ?? []) {
          if (!known.has(declared.type)) known.set(declared.type, { name: declared.type, schema: declared.schema });
        }
      }
      return [...known.values()];
    };

    /** The version of a record type the host knows: what a script that names the type by reference must name. */
    const recordVersion = (name: string): number | undefined => (emits.get(name) ?? api.recordType(name))?.version;

    /** The schema of the data of a record type the host knows: what a script that waits for it or reads it is typed by. */
    const recordSchema = (name: string): JsonSchema | undefined => {
      const type = emits.get(name) ?? api.recordType(name);
      return type === undefined ? undefined : toJsonSchema(type.schema, "output");
    };

    // The agent actions of the harnesses are installed by the host: a script that names a
    // harness reaches the agents of that harness with no hand glue.
    for (const harnessAction of harnessActions.values()) api.action(harnessAction);

    /** The box of a script process, when the run is boxed. */
    const boxFor = (boxed: boolean | undefined): ScriptBox | undefined =>
      boxed === true
        ? {
            sandbox: opts.sandbox ?? "srt",
            closed: [join(api.home(), OWNER_TOKEN_FILE), join(api.home(), HOST_KEY_FILE)],
            read: [workflowsDir(api.home()), ...scriptPackages().roots],
          }
        : undefined;

    /** The box a run or an installation asked for, or else the module's own choice. */
    const boxOf = async (asked: boolean | undefined): Promise<boolean> => {
      const boxed = asked ?? opts.box ?? false;
      // A box that cannot be had here stops the start before anything is made of it.
      if (boxed) await requireBox({ sandbox: opts.sandbox ?? "srt", spec: { cwd: process.cwd() } });
      return boxed;
    };

    /**
     * What a module declares, read once for a version of the script: a start that checked it a moment ago, a run that
     * begins any other way (a resume, a restart, a record) and a version the journal registered do not read it again.
     * Registrations are checked in the box the module is given, so only that box takes what they say.
     */
    const describe = describer({
      known: (version, boxed) => (boxed === (opts.box ?? false) && api.journal?.() !== undefined ? declaredBy(journal(), version) : undefined),
    });

    /**
     * The types a run may emit, by the name the script gives them: what it declares in `emits`, under `wf.<name>.`, with
     * the schema it declares, or the composition's own type of that name.
     */
    const emitTypesOf = (described: Described | undefined): Map<string, RecordType<unknown>> =>
      new Map(
        described === undefined
          ? []
          : emittedTypesOf({ described }).map(({ record: name, type, schema }) => [
              name,
              emits.get(type) ?? record(type, z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])),
            ]),
      );

    /** The script against the actions its caller may call. */
    const checked = async (ctx: ActionContext, source: { file: string; text: string }, boxed: boolean): Promise<CheckReport> => {
      const text = await checkScript(source, { ...(await catalogueFor(ctx, api.rights(ctx.caller))), triggers: triggersNow(), records: recordSchema, versions: recordVersion });
      return withDeclaration(text, describe, boxFor(boxed));
    };

    const journal = (): JournalReader => {
      const reader = api.journal?.();
      if (reader === undefined) throw new Error("the journal is not open yet");
      return reader;
    };

    // The runs by state, for `niwa.host.status`.
    api.summarize(() => {
      const counts: Record<RunStateName, number> = { running: 0, paused: 0, finished: 0 };
      for (const run of runIds(journal())) counts[statusOf(journal(), run).state] += 1;
      return counts;
    });

    const settled = (status: RunStatus, includeManual: boolean) =>
      status.state === "finished" ||
      (status.state === "paused" && (includeManual || status.manualPause === undefined || status.invocation !== undefined));

    /** The run as it is once it finishes or pauses, or as it is when the time is over. */
    const settle = async (run: string, timeoutMs: number = DEFAULT_WAIT_MS, includeManual = true): Promise<RunStatus> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = statusOf(journal(), run);
        const left = deadline - Date.now();
        if (settled(status, includeManual) || left <= 0) return status;
        await api.untilCommit(left);
      }
    };

    /**
     * The status of a run, with what plugins began outside niwa and have not ended when the run is held: the hold stops
     * the run's own writes, and these go on until someone calls them off. Each plugin's listing is read now, as a step
     * of the call; a plugin that cannot be asked is said so, its operations are not taken for none.
     */
    const showing = async (status: RunStatus, ctx: ActionContext): Promise<RunStatus> => {
      if (status.hold === undefined) return status;
      const offered = api.offers(PENDING_EXTERNAL);
      if (offered.length === 0) return status;
      const pending: PendingOperations[] = [];
      for (const { plugin: by, value } of offered) {
        const listed = await ctx.step.outcome(actionName(value.list), {});
        const answer = listed.status === "completed" ? PendingExternalAnswerSchema.safeParse(listed.value) : undefined;
        if (answer?.success === true) {
          if (answer.data.items.length > 0) pending.push({ plugin: String(by), label: value.label, items: answer.data.items });
          continue;
        }
        const why = listed.status === "completed" ? "it did not answer `{ items }`" : listed.status === "failed" ? listed.error : listed.status === "denied" ? listed.reason : listed.status;
        pending.push({ plugin: String(by), label: value.label, items: [], unavailable: `${value.list}: ${why}` });
      }
      return pending.length === 0 ? status : { ...status, hold: { ...status.hold, pending } };
    };

    const runIndex = new IdIndex("run", () => runsIssuedOf(journal()));
    const workflowIndex = new IdIndex("workflow", () => workflowIdsOf(journal()));
    const installationIndex = new IdIndex("subscription", () => installationIdsOf(journal()));

    /** The run a text names: its id, or a unique start or end of it, among the runs the caller may act on. */
    const runOf = (text: string, caller: Caller): RunId => {
      const reader = journal();
      const mine = runIndex.resolve(text, (run) => isOwnerOrStarter(caller, ownerOfRun(reader, run)));
      // The whole id of a run of another is named all the same, so the refusal says whose it is; a part of one names nothing.
      return mine ?? runIndex.require(text, (run) => run === text);
    };

    /** The registered workflow a text names. */
    const workflowOf = (text: string): RegisteredWorkflow => {
      const id = workflowIndex.require(text);
      const found = workflowsOf(journal()).find((one) => one.id === id);
      if (found === undefined) throw new RunRefusal("unknown-workflow", `no workflow "${text}"`);
      return found;
    };

    /** The copy of a registered version niwa keeps in its home: what the version runs and is checked on. */
    const storedOf = (id: WorkflowId, version: WorkflowVersion): string => {
      const stored = storedVersion(api.home(), id, version);
      if (stored === undefined) throw new RunRefusal("not-stored", `niwa holds no code of the version ${version} of ${id}: register it again`);
      if ("problem" in stored) throw new RunRefusal("not-the-version", stored.problem);
      return stored.entry;
    };

    /** The plugin whose built-in a caller is a run of; undefined for any other caller. */
    const builtinPluginOf = (caller: Caller): string | undefined => {
      if (caller.kind !== "client" || caller.principal?.kind !== "run") return undefined;
      const id = factsOf(journal(), runIdOfPrincipal(caller.principal.id))?.workflow;
      return id === undefined ? undefined : workflowsOf(journal()).find((one) => one.id === id)?.builtin?.plugin;
    };

    /**
     * What a start of a registered workflow runs: the stored copy of its latest version, or of the version it names. A
     * broken version does not start, and a candidate starts only by its version, for a run of a built-in of its plugin.
     */
    const registeredTarget = (registered: RegisteredWorkflow, version?: WorkflowVersion, caller?: Caller): { file: string } & RunOrigin => {
      if (version !== undefined) {
        const named = registered.versions.find((one) => one.version === version);
        if (named === undefined) throw new RunRefusal("unknown-version", `the workflow ${registered.id} has no version ${version}`);
        if (named.candidate === true && (caller === undefined || registered.builtin === undefined || builtinPluginOf(caller) !== registered.builtin.plugin)) {
          throw new RunRefusal("candidate", `the version ${version} of ${registered.id} is a candidate: only a run of a built-in of the plugin "${registered.builtin?.plugin ?? ""}" starts it`);
        }
        if (named.broken !== undefined) throw new RunRefusal("workflow-broken", `the version ${version} of ${registered.id} is broken, it does not start: ${named.broken}`);
        return { file: storedOf(registered.id, version), workflow: registered.id, version };
      }
      const latest = registered.latest;
      if (latest.candidate === true) {
        throw new RunRefusal("candidate", `the workflow ${registered.id} has only a candidate version: it is not started by its id until a version is promoted`);
      }
      if (latest.broken !== undefined) {
        throw new RunRefusal("workflow-broken", `the workflow ${registered.id} is broken, it does not start: ${latest.broken}. Register a version that passes`);
      }
      return { file: storedOf(registered.id, latest.version), workflow: registered.id, version: latest.version };
    };

    const known = (run: string): RunFacts => {
      const facts = factsOf(journal(), run);
      if (facts === undefined) throw new Error(`unknown run "${run}"`);
      return facts;
    };

    /**
     * The run may be started again only when the invocation that is going has ended.
     *
     * A run is one invocation of the handler, and a resume or a revision starts another one.
     * Two invocations of the same run would write over the same children of the run, so a run
     * that is still going is refused.
     *
     * A run that is paused waits for a decision: the pause is resolved with a cancel as part of
     * the resume, so the old invocation is ended and the new one starts on a clean run.
     */
    const guardResumable = async (run: string, ctx: ActionContext): Promise<void> => {
      const latest = latestInvocationOf(journal(), run);
      if (latest === undefined) return;
      if (latest.state === "done") return;
      if (latest.state === "paused") {
        // The pause is resolved with a cancel: the old invocation ends, and the run starts again.
        await ctx.step(RESOLVE_ACTION, { invocation: latest.invocation, choice: "cancel" });
        return;
      }
      throw new RunRefusal(
        "run-is-going",
        `the run "${run}" is still going: it cannot be resumed or revised until it ends`,
      );
    };

    /**
     * The grant of a new run: `narrow(caller, uses)`, and the script's own `wf.*` records.
     *
     * A script with no `uses` asks for nothing, so its run holds only its own records; a caller
     * that nothing limits (the host, a plugin) has no grant to narrow, so its run has none either,
     * unless the script names what it uses. A mask the caller does not hold refuses the run. A target
     * template of `uses` is filled from the arguments of the run first, and `allow` narrows the result.
     */
    const grantOfRun = async (asker: Caller, text: string | undefined, file: string, args: unknown, allow?: readonly string[]): Promise<Grant | undefined> => {
      const uses = text === undefined ? undefined : await scriptUses({ file, text });
      const masks = uses !== undefined && "masks" in uses ? filledUses(uses.masks.map((use) => use.mask), args) : undefined;
      if (masks === undefined && api.rights(asker) === "unlimited" && allow === undefined) return undefined;
      const narrowed = masks === undefined && api.rights(asker) === "unlimited" ? { rules: grant(allow ?? []) } : api.narrow(asker, masks ?? []);
      if ("refused" in narrowed) throw new UsesRefused(narrowed.refused.map((text) => text.replace(/^call:/, "")));
      if (allow === undefined) return grant([...specsOf(narrowed.rules), `emit:${SCRIPT_TYPES}*`]);
      // `allow` only narrows: what it names must lie within the run's rights, which it then replaces.
      const within = narrow(narrowed.rules, allow, { irreversible: (name) => api.effectOf(name) === "irreversible" });
      if ("refused" in within) {
        throw new RunRefusal("allow-wider", `allow only narrows the run: ${within.refused.map((text) => text.replace(/^call:/, "")).join(", ")} ${within.refused.length === 1 ? "is" : "are"} not the run's`);
      }
      return grant([...specsOf(within.rules), `emit:${SCRIPT_TYPES}*`]);
    };

    const latestRequest = (run: string) => {
      const row = journal().find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
      return row === undefined ? undefined : RunRequested.schema.parse(row.data);
    };

    /** A revision keeps its original authority ceiling and receives a fresh, independently closable identity. */
    const requestAgain = async (ctx: ActionContext, request: ReturnType<typeof requestedOf> & { from?: string }) => {
      const initial = journal().find({ type: AccessGranted.name, field: "principal.id", equals: request.run })
        .map(row => AccessGranted.schema.parse(row.data)).find(data => data.principal.kind === "run");
      const parent = initial?.parent === undefined ? ctx.caller : callerOf(initial.parent.principal);
      const policy = latestRequest(request.run)?.allow;
      const script = readScript(request.file);
      const intrinsic = `emit:${SCRIPT_TYPES}*`;
      const declared = await grantOfRun(parent, script?.text, request.file, request.args, policy?.rules);
      const execution = `${request.run}/${randomUUID()}`;
      let rules = declared;
      if (initial !== undefined) {
        const requested = (declared === undefined ? initial.rules : specsOf(declared)).filter(spec => spec !== intrinsic);
        const original = narrow(grant(initial.rules), requested, { irreversible: name => api.effectOf(name) === "irreversible" });
        if ("refused" in original) throw new UsesRefused(original.refused);
        const current = api.narrow(parent, specsOf(original.rules));
        if ("refused" in current) throw new UsesRefused(current.refused);
        rules = grant([...specsOf(current.rules), intrinsic]);
      }
      if (rules !== undefined) api.issueToken("run", execution, { grant: rules, parent });
      await ctx.emit(RunRequested, { ...request, execution, ...(policy === undefined ? {} : { allow: policy }) });
    };

    api.action(
      action(workflowStart, {
        // The run is asked for: a start that was cut off may have begun one, so it is
        // not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if ((input.id === undefined) === (input.file === undefined)) {
            throw new RunRefusal("start-what", "a start names the workflow to run: its id, or a script file, one of the two");
          }
          if (input.version !== undefined && input.id === undefined) throw new RunRefusal("start-what", "a version is the version of a registered workflow: name it with `id`");
          const target = input.id === undefined ? { file: resolveFile(opts.root, input.file ?? "") } : registeredTarget(workflowOf(input.id), input.version, ctx.caller);
          const run = await requestRun(ctx, {
            ...target,
            args: input.args,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.box === undefined ? {} : { box: input.box }),
            ...(input.directory === undefined ? {} : { directory: input.directory }),
            ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
            ...(input.limits === undefined ? {} : { limits: input.limits }),
            ...(input.allow === undefined ? {} : { allow: { rules: input.allow, version: createHash("sha256").update(JSON.stringify(input.allow)).digest("hex") } }),
          });
          if (input.wait !== true) return { run, finished: false };
          const status = await settle(run, input.timeoutMs);
          return { ...status, finished: status.state === "finished" };
        },
      }),
    );

    /**
     * Ask for a run: the script is checked, the arguments held to its input, the run given its grant and its id.
     * Nothing is left behind when it is refused.
     */
    async function requestRun(
      ctx: ActionContext,
      input: { file: string; args: unknown; label?: string; box?: boolean } & RunOrigin,
    ): Promise<RunId> {
      const file = input.file;
      // A child run takes the limits of its parent, and is not started deeper than they allow.
      const limits = input.limits ?? (input.parent === undefined ? undefined : factsOf(journal(), input.parent.run)?.limits);
      // The deadline of the whole run, from now; a child run's comes no later than its parent's.
      const deadline = earliest(
        limits?.deadline === undefined ? undefined : clockNow() + limits.deadline,
        input.parent === undefined ? undefined : deadlineOf(journal(), input.parent.run),
      );
      if (input.parent !== undefined && limits?.depth !== undefined) {
        // The run that started the tree is one deep; each child is one deeper than its parent.
        const depth = depthOf(journal(), input.parent.run) + 2;
        if (depth > limits.depth) {
          throw new RunRefusal("too-deep", `the run would be ${String(depth)} deep in its tree, and its limits allow ${String(limits.depth)}`);
        }
      }
      // A child run takes the concurrency of its parent unless it is given its own.
      const concurrency = input.concurrency ?? (input.parent === undefined ? undefined : factsOf(journal(), input.parent.run)?.concurrency);
      const run = runIndex.issue(ctx.operationId);
      // The script is read once: the text that is checked is the text whose hash is pinned. A
      // script that cannot be read is not refused here, the run that reads it fails as it
      // always did.
      const script = readScript(file);
      const boxed = await boxOf(input.box);
      let accepted: unknown = input.args ?? null;
      let contract: ContractHash | undefined;
      if (script !== undefined) {
        const report = await checked(ctx, { file, text: script.text }, boxed);
        if (!report.ok) throw new ScriptCheckFailed(report.errors);
        // The arguments are held to the input of the script before a run exists: a refusal leaves nothing behind.
        const on = await scriptOn({ file, text: script.text });
        const records = on !== undefined && "subscriptions" in on;
        const issues = inputIssues(report.input, records, input.args);
        if (issues.length > 0) throw new InputInvalid(issues);
        accepted = report.input === undefined || records ? (input.args ?? null) : (input.args ?? {});
        contract = report.contract;
      }
      // The run is a subject of its own: what it may do is what the caller may do, narrowed to
      // `uses` as its arguments fill it, and it keeps that grant until it ends.
      const born = await grantOfRun(ctx.caller, script?.text, file, accepted, input.allow?.rules);
      if (born !== undefined) api.issueToken("run", run, { grant: born, parent: ctx.caller });
      await ctx.emit(RunRequested, {
        run,
        file,
        args: accepted,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(script === undefined ? {} : { hash: script.hash }),
        ...(contract === undefined ? {} : { contract }),
        ...(boxed ? { box: true } : {}),
        ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.directory === undefined ? {} : { directory: input.directory }),
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(limits === undefined ? {} : { limits }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(input.allow === undefined ? {} : { allow: input.allow }),
      });
      watchDeadline(run);
      return run;
    }

    api.action(
      action(workflowWait, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          if (!runExists(journal(), run)) throw new RunRefusal("unknown-run", `unknown run "${run}"`);
          mayAct(ctx.caller, ownerOfRun(journal(), run), `wait for the run "${run}"`);
          return showing(await settle(run, input.timeoutMs), ctx);
        },
      }),
    );

    api.action(
      action(workflowInspect, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          const reader = journal();
          mayAct(ctx.caller, ownerOfRun(reader, run), `inspect the run "${run}"`);
          const inspection = inspectRun(reader, run);
          if (inspection === undefined) throw new RunRefusal("unknown-run", `unknown run "${run}"`);
          return inspection;
        },
      }),
    );

    api.action(
      action(workflowRuns, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const reader = journal();
          // The runs of whoever asks: a client that is not the owner sees the runs it started.
          const runs = runIds(reader)
            .filter((run) => isOwnerOrStarter(ctx.caller, ownerOfRun(reader, run)))
            .filter((run) => input.state === undefined || statusOf(reader, run).state === input.state);
          const shown = runs.slice(-(input.limit ?? runs.length));
          return { runs: shown.map((run) => runLine(reader, run)), entries: shown.map((run) => runEntry(reader, run)) };
        },
      }),
    );

    const stats = new StatsFold();

    api.action(
      action(workflowStats, {
        // Nothing is written: the fold catches up with the journal and answers.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          stats.catchUp(journal());
          if (input.id === undefined) {
            if (input.compare !== undefined) throw new RunRefusal("compare-what", "a comparison is of two versions of one workflow: name its id");
            return stats.answer({ ...(input.since === undefined ? {} : { since: input.since }) });
          }
          const id = workflowOf(input.id).id;
          const versionNamed = (text: string): WorkflowVersion => {
            const full = WorkflowVersion.safeParse(text);
            if (full.success) return full.data;
            const found = stats.versionsOf(id).filter((version) => version.startsWith(text));
            const [only] = found;
            if (only === undefined || found.length > 1) {
              throw new RunRefusal("unknown-version", `"${text}" names ${found.length === 0 ? "no version" : "more than one version"} of ${id} that ran`);
            }
            return only;
          };
          return stats.answer({
            id,
            ...(input.compare === undefined ? {} : { compare: [versionNamed(input.compare[0]), versionNamed(input.compare[1])] as const }),
            ...(input.since === undefined ? {} : { since: input.since }),
          });
        },
      }),
    );

    api.action(
      action(workflowCheck, {
        // The script is read and checked, and nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "local",
        run: async (input, ctx) => {
          const file = resolveFile(opts.root, input.file);
          const script = readScript(file);
          if (script === undefined) throw new RunRefusal("script-unreadable", `the script "${file}" cannot be read`);
          return checked(ctx, { file, text: script.text }, opts.box ?? false);
        },
      }),
    );

    api.action(
      action(workflowGuide, {
        // The description is read and nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (_input, ctx) => {
          const { actions, callable, blocks } = await catalogueFor(ctx, api.rights(ctx.caller));
          return guideFor(actions, callable, triggersNow(), blocks);
        },
      }),
    );

    // Serialize control changes for the same run while its journal append is in progress.
    const controls = new Map<string, Promise<unknown>>();
    const changeControl = async <T>(run: string, change: () => Promise<T>): Promise<T> => {
      const next = (controls.get(run) ?? Promise.resolve()).then(change, change);
      controls.set(run, next);
      try {
        return await next;
      } finally {
        if (controls.get(run) === next) controls.delete(run);
      }
    };

    api.action(action(workflowPause, {
      // A re-issued command while there is an outstanding pause returns its original identifier.
      recovery: "do-not-repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        const run = runOf(input.run, ctx.caller);
        mayAct(ctx.caller, ownerOfRun(journal(), run), `pause the run "${run}"`);
        if (input.effects === "deny") {
          const held = await changeControl(run, async () => {
            const status = statusOf(journal(), run);
            if (status.state !== "finished" && activeHold(journal(), run) === undefined) {
              await ctx.emit(RunHoldRequested, { run, tree: input.tree === true, effects: "deny" });
            }
            return statusOf(journal(), run);
          });
          return showing(held, ctx);
        }
        await pauseTree(run, ctx);
        return showing(statusOf(journal(), run), ctx);
      },
    }));

    /** The deadlines that are coming, by run: what stops each from coming. */
    const deadlineTimers = new Map<string, () => void>();

    /**
     * Wait for the deadline of a run: when it comes and the run has not ended, the run is paused at its next boundary
     * with a pause of the kind `deadline`, which only an extension or a cancel answers. A deadline moved later meanwhile
     * is waited for instead.
     */
    const watchDeadline = (run: string): void => {
      deadlineTimers.get(run)?.();
      deadlineTimers.delete(run);
      const at = deadlineOf(journal(), run);
      const clock = hostClock;
      if (at === undefined || clock === undefined) return;
      const stop = clock.schedule(at, () =>
        changeControl(run, async () => {
          deadlineTimers.delete(run);
          if (statusOf(journal(), run).state === "finished" || deadlineOf(journal(), run) !== at) return;
          await clock.emit(RunPauseRequested, { run: RunId.parse(run), kind: "deadline", deadline: at });
        }),
      );
      deadlineTimers.set(run, stop);
    };

    /**
     * Move the deadline of a run to `to`, and of each run it started whose deadline was its own (`from`): a child held
     * to its parent's deadline is given the parent's new one. A pause of a deadline that came is answered: the run goes on.
     */
    const extendTree = async (run: string, from: number, to: number, ctx: ActionContext): Promise<void> => {
      await changeControl(run, async () => {
        await ctx.emit(RunDeadlineExtended, { run: RunId.parse(run), deadline: to });
        const pause = activeManualPause(journal(), run);
        if (pause !== undefined && deadlineReached(pause) !== undefined) await ctx.emit(RunContinued, { run: RunId.parse(run), pause: String(pause.id) });
      });
      watchDeadline(run);
      for (const child of childrenOf(journal(), run)) {
        if (statusOf(journal(), child).state !== "finished" && deadlineOf(journal(), child) === from) await extendTree(child, from, to, ctx);
      }
    };

    api.action(action(workflowExtend, {
      // Each extension moves the deadline again: one that was cut off is not made twice.
      recovery: "do-not-repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        const run = runOf(input.run, ctx.caller);
        mayAct(ctx.caller, ownerOfRun(journal(), run), `extend the run "${run}"`);
        const extended = await changeControl(run, async () => {
          if (statusOf(journal(), run).state === "finished") throw new RunRefusal("finished", `the run "${run}" has finished`);
          const current = deadlineOf(journal(), run);
          if (current === undefined) throw new RunRefusal("no-deadline", `the run "${run}" has no deadline to extend`);
          return { from: current, to: Math.max(current, clockNow()) + input.by };
        });
        await extendTree(run, extended.from, extended.to, ctx);
        return showing(statusOf(journal(), run), ctx);
      },
    }));

    /** Pause a run and the runs it started that are going, down the tree. */
    const pauseTree = async (run: RunId, ctx: ActionContext): Promise<void> => {
      await changeControl(run, async () => {
        const status = statusOf(journal(), run);
        if (status.state === "running" && status.manualPause === undefined) await ctx.emit(RunPauseRequested, { run });
      });
      for (const child of childrenOf(journal(), run)) {
        if (statusOf(journal(), child).state !== "finished") await pauseTree(child, ctx);
      }
    };

    /** Release the manual pauses of the runs a run started, down the tree. */
    const continueChildren = async (run: RunId, ctx: ActionContext): Promise<void> => {
      for (const child of childrenOf(journal(), run)) {
        await changeControl(child, async () => {
          const pause = activeManualPause(journal(), child);
          if (pause !== undefined) await ctx.emit(RunContinued, { run: child, pause: String(pause.id) });
        });
        await continueChildren(child, ctx);
      }
    };

    api.action(action(workflowContinue, {
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        const run = runOf(input.run, ctx.caller);
        mayAct(ctx.caller, ownerOfRun(journal(), run), `continue the run "${run}"`);
        const released = await changeControl(run, async () => {
          const pause = activeManualPause(journal(), run);
          const hold = activeHold(journal(), run);
          if (hold?.id === input.pause) {
            await ctx.emit(RunContinued, { run, pause: input.pause });
            return false;
          }
          if (pause?.id !== input.pause) return false;
          if (deadlineReached(pause) !== undefined) {
            throw new RunRefusal("deadline", `the run "${run}" reached its deadline: give it more time with workflow.extend, or cancel it`);
          }
          await ctx.emit(RunContinued, { run, pause: input.pause });
          return true;
        });
        if (released) await continueChildren(run, ctx);
        return showing(statusOf(journal(), run), ctx);
      },
    }));

    api.action(
      action(workflowResume, {
        // The script runs again: a resume that was cut off may have run it, so it is not
        // made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          const facts = known(run);
          mayAct(ctx.caller, ownerOfRun(journal(), run), `resume the run "${run}"`);
          if (input.choice !== undefined) {
            // The pause of the run is answered by the run: the step is retried or skipped, or the run is cancelled.
            const paused = statusOf(journal(), run);
            if (paused.state !== "paused" || paused.invocation === undefined) {
              throw new RunRefusal("not-paused", `the run "${run}" is not paused on a step: there is nothing to ${input.choice}`);
            }
            // Only what the pause offers: a skip of a pause on no step would run the script again, as a retry does.
            if (!(paused.choices ?? []).includes(input.choice)) {
              throw new RunRefusal(
                "choice-not-offered",
                `the pause of the run "${run}" does not offer ${input.choice}: it offers ${(paused.choices ?? []).join(", ")}`,
              );
            }
            await ctx.step(RESOLVE_ACTION, { invocation: paused.invocation, choice: input.choice });
            return { run, finished: input.choice === "cancel" };
          }
          // The run may only be started again when the invocation that is going has ended. A run
          // that is still going would have two invocations writing over the same children of
          // the run, so the resume is refused instead.
          await guardResumable(run, ctx);
          // The script is the file the run was started with: an edit to it makes the resume a
          // revision, and the answer says what the new start takes from the earlier ones and what runs.
          const hash = readScript(facts.file)?.hash;
          const edited = hash !== undefined && facts.hash !== undefined && hash !== facts.hash;
          const requested = { ...requestedOf(run, facts, facts.file, hash), ...(input.from === undefined ? {} : { from: input.from }) };
          if (!edited) {
            await requestAgain(ctx, requested);
            return { run, finished: false };
          }
          const revision = await revisionOf(journal(), api.artifacts, facts, actionNameOf, boxFor(facts.box), facts.file, run, input.from);
          await requestAgain(ctx, requested);
          return { run, finished: false, revision };
        },
      }),
    );

    api.action(
      action(workflowRevise, {
        // The edited script runs again: a revise that was cut off may have run it, so it
        // is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          const facts = known(run);
          mayAct(ctx.caller, ownerOfRun(journal(), run), `revise the run "${run}"`);
          // The run may only be started again when the invocation that is going has ended.
          await guardResumable(run, ctx);
          const file = resolveFile(opts.root, input.file);
          const revision = await revisionOf(journal(), api.artifacts, facts, actionNameOf, boxFor(facts.box), file, run, input.from);
          await requestAgain(ctx, { ...requestedOf(run, facts, file, readScript(file)?.hash), ...(input.from === undefined ? {} : { from: input.from }) });
          return { run, finished: false, revision };
        },
      }),
    );

    api.action(
      action(workflowCancel, {
        // The run ends once: a cancel that was cut off may have ended it, so it is not
        // made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          known(run);
          mayAct(ctx.caller, ownerOfRun(journal(), run), `cancel the run "${run}"`);
          await cancelTree(run, ctx);
          return { run, finished: true };
        },
      }),
    );

    /**
     * End a run and the runs it started, down the tree.
     *
     * The end of the run is written first: the run of the script sees it and ends there. Its process
     * is stopped, the agents it started are interrupted, and what it asked is withdrawn.
     */
    async function cancelTree(run: RunId, ctx: ActionContext): Promise<void> {
      const facts = known(run);
      if (statusOf(journal(), run).state !== "finished") {
        await changeControl(run, async () => {
          await ctx.emit(RunFinished, { run, execution: latestRequest(run)?.execution, outcome: { status: "cancelled" } });
          const pause = activeManualPause(journal(), run);
          if (pause !== undefined) await ctx.emit(RunContinued, { run, pause: String(pause.id) });
        });
        // The child process of the run is stopped: a run that was cancelled is not running
        // any more, whatever its script was doing.
        stopRun(run);
        // The agents it started are not left working for nobody.
        for (const session of sessionsOf(journal(), facts.invocations)) {
          await ctx.step.outcome(sessionInterrupt, { session });
          await ctx.step.outcome(sessionEnd, { session, reason: `the run ${run} that started it was cancelled` });
        }
        // What the run asked is not left open: the owner is not asked about a run that ended, and a
        // session that was asked through a request is no longer waited for. The cancel is made as the
        // address the request was put to, the one that may withdraw it.
        for (const { id, to } of openRequestsOfInvocations(journal(), facts.invocations)) {
          await ctx.step.outcome(requestCancel, { id, reason: "the run was cancelled", by: to });
        }
      }
      for (const child of childrenOf(journal(), run)) await cancelTree(child, ctx);
    }

    /** The end of a child run, as a step of the run whose branch started it: the tree goes down with a cancel of the branch. */
    const cancelChild = action("workflow.run.cancel-child", {
      description: "End a run that a cancelled branch of its parent started, with the runs it started.",
      input: z.object({ run: RunId }),
      output: z.null(),
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        await cancelTree(input.run, ctx);
        return null;
      },
    });

    api.action(
      action(workflowStop, {
        // The steps are cancelled once: a stop that was cut off may have cancelled them, so it is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const run = runOf(input.run, ctx.caller);
          known(run);
          mayAct(ctx.caller, ownerOfRun(journal(), run), `stop the run "${run}"`);
          if (input.at === undefined) {
            await cancelTree(run, ctx);
            return { run, finished: true };
          }
          const latest = latestInvocationOf(journal(), run);
          if (latest === undefined || latest.state === "done") {
            throw new RunRefusal("not-going", `the run "${run}" is not going: there is nothing of it to stop`);
          }
          const at = input.at;
          // A shielded scope under what is stopped is spared, unless the stop goes through shields.
          const except = input.force === true ? [] : openShieldsOf(journal(), run).filter((open) => open !== at && keyUnder(open, at));
          const reason = input.reason ?? "stopped by the owner";
          await ctx.step(CANCEL_STEPS_ACTION, { invocation: latest.invocation, prefixes: [at], ...(except.length === 0 ? {} : { except }), reason });
          const held = heldBy(journal(), latest.invocation, [at], except);
          for (const session of held.sessions) await ctx.step.outcome(sessionEnd, { session, reason });
          for (const mark of held.marks) await ctx.step.outcome(actionName("access.grant.close"), { principal: principalOf("session", mark), reason });
          for (const child of held.children) await cancelTree(child, ctx);
          return { run, finished: false };
        },
      }),
    );

    // --- subscriptions -------------------------------------------------------------------

    /** Who an installation was made by, as the caller its runs are born from; the host when nothing limited the installer. */
    const installerOf = (installation: Installation): Caller =>
      installation.installer === undefined ? { kind: "host" } : callerOf(installation.installer);

    const emitRule = `emit:${SCRIPT_TYPES}*`;
    const notEmit = (spec: RuleSpec): boolean => !ruleText(rule(spec)).startsWith("emit:");

    /**
     * The part of `requested` that the installer holds now.
     *
     * A mask the installer holds whole is kept whole. A mask it holds only in part (`task.*` asked,
     * `task.create` held) gives the part it holds, so narrowing the installer narrows the runs born
     * after it instead of stopping them. Nothing is ever widened.
     */
    const withinInstaller = (installer: Caller, requested: readonly RuleSpec[]): RuleSpec[] => {
      const kept: RuleSpec[] = [];
      for (const spec of requested) {
        const whole = api.narrow(installer, [spec]);
        if (!("refused" in whole)) {
          kept.push(...specsOf(whole.rules));
          continue;
        }
        const rights = api.rights(installer);
        if (rights === "unlimited") continue;
        for (const held of specsOf(rights)) {
          const inside = narrow(grant([spec]), [held], { irreversible: (name) => api.effectOf(name) === "irreversible" });
          if (!("refused" in inside)) kept.push(...specsOf(inside.rules));
        }
      }
      return kept;
    };

    /** Set the profile of an installation: the record of the owner's table, and the value a later start reads. */
    const setProfile = (id: InstallationId, specs: readonly RuleSpec[], by: Caller): void => {
      api.profile(profileOf(id), () => specs);
      api.setProfile(profileOf(id), specs, by);
    };

    /**
     * The birth of the run a record starts under an installation: its grant, as a step of the handler.
     *
     * The grant is what the profile holds, held within what the installer holds now, so a run is never
     * wider than the installer is at its birth, and the runs that live are not touched by a later
     * narrowing. Nothing is born under an installation that ended, an installer whose grant was
     * closed (the installation stays listed until it is uninstalled), a workflow that is broken, or a
     * script that is not the bytes that were installed. The run's id is issued from the step, so a
     * step entered again issues the same id, and a run that was given its grant already is not given another.
     */
    const birth = action("workflow.subscription.birth", {
      description: "Issue the id of the run that a record starts under an installation, and give the run its grant.",
      input: z.object({ installation: z.number().int(), record: z.string().optional() }),
      output: z.object({ run: RunId.optional(), refused: z.string().optional() }),
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: ({ installation, record: woken }, ctx) => {
        const found = installationsOf(journal()).find((one) => one.seq === installation);
        if (found === undefined || found.removed !== undefined) return {};
        const installer = installerOf(found);
        // A closed grant, or the emergency switch, refuses with no masks at all.
        if ("refused" in api.narrow(installer, [])) return {};
        // A workflow that a change of one it calls broke does not start, and its installation stays.
        const registered = found.workflow === undefined ? undefined : workflowsOf(journal()).find((one) => one.id === found.workflow);
        if (registered?.versions.find((one) => one.version === found.version)?.broken !== undefined) return {};
        const pinned = readScript(found.file)?.hash;
        if (pinned !== found.hash || (found.version !== undefined && versionOf(found.file) !== found.version)) {
          throw new RunRefusal("script-changed", `the installed script "${found.file}" is not the one that was installed: install it again`);
        }
        // A target template is filled by the record the run starts on, and the rule it gives is held whole by the
        // installer: a value that would widen it, or a rule the installer does not hold, starts nothing.
        const templates = found.uses.filter((use) => isRuleTemplate(use));
        let filled: RuleSpec[] = [];
        if (templates.length > 0) {
          const stored = woken === undefined ? undefined : journal().get(recordId(woken));
          const args = stored === undefined ? undefined : { id: stored.id, type: stored.type, data: stored.data };
          try {
            filled = filledUses(templates, args);
          } catch (error) {
            return { refused: (error as Error).message };
          }
          const held = api.narrow(installer, filled);
          if ("refused" in held) return { refused: new UsesRefused(held.refused.map((text) => text.replace(/^call:/, ""))).message };
          filled = specsOf(held.rules);
        }
        const run = runIndex.issue(ctx.operationId);
        const issued = journal()
          .find({ type: CORE_TYPES.accessGranted, field: "principal.id", equals: run })
          .some((row) => (row.data as { principal?: { kind?: unknown } }).principal?.kind === "run");
        if (!issued) {
          const profile = profileRulesOf(journal(), found.id) ?? grant([]);
          const rules = withinInstaller(installer, specsOf(profile).filter(notEmit));
          api.issueToken("run", run, { grant: grant([...rules, ...filled, emitRule]), parent: installer });
        }
        return { run };
      },
    });

    /**
     * The start of a run of one installation on one record, started once. The handler of a record is
     * one invocation, admitted once and replayed from its steps after a restart, and the run id is a
     * function of the installation and the record.
     */
    const startRun =
      (installation: Installation): Handler<unknown> =>
      async (_data, step, stored) => {
        const { run } = await step(birth, { installation: installation.seq, record: stored.id }, { key: `birth:${installation.seq}` });
        if (run === undefined) return;
        await step.emit(
          RunRequested,
          {
            run,
            file: installation.file,
            args: { id: stored.id, type: stored.type, data: stored.data },
            hash: installation.hash,
            contract: installation.contract,
            ...(installation.box === true ? { box: true } : {}),
            ...(installation.workflow === undefined ? {} : { workflow: installation.workflow }),
            ...(installation.version === undefined ? {} : { version: installation.version }),
            installation: installation.id,
          },
          { key: `run:${installation.seq}` },
        );
      };

    /**
     * Every installation is a subscription of its own: its `on` is what wakes it, the record that
     * installed it is where it starts, and the record that ended it is where it ends. Being its own
     * subscription, it is never woken by what its own runs caused, however long the way — a script
     * that emits what it starts on, or two that start on each other, would otherwise go on for ever.
     * The installations are read again only when one is made or ended.
     */
    let read: { journal: JournalReader; upTo: Seq; subscribers: Subscriber[] } | undefined;
    api.subscribers(() => {
      const reader = api.journal?.();
      if (reader === undefined) return [];
      if (read?.journal !== reader) read = { journal: reader, upTo: seq(0), subscribers: [] };
      const fresh = reader.query({ types: [SubscriptionInstalled.name, SubscriptionUninstalled.name], from: read.upTo });
      const last = fresh.at(-1);
      if (last === undefined) return read.subscribers;
      read.upTo = last.seq;
      read.subscribers = installationsOf(reader).map(
        (installation): Subscriber => ({
          id: `workflow.on:${installation.id}`,
          queries: installation.on.map((one) => ({ types: [one.type], ...(one.filter === undefined ? {} : { filter: one.filter }) })),
          from: installation.seq,
          ...(installation.removed === undefined ? {} : { until: installation.removed }),
          handler: startRun(installation),
        }),
      );
      return read.subscribers;
    });

    /**
     * Install a registered workflow at its latest version, or a script file: the script is checked, its `on` read, and
     * the profile of the installation is narrow(caller, uses) and the script's own records.
     */
    const installScript = async (
      ctx: ActionContext,
      input: { registered?: RegisteredWorkflow; file?: string; description: EntityDescription; box?: boolean; builtin?: Builtin },
    ): Promise<{ id: InstallationId; profile: string; on: Subscription[] }> => {
      // A broken workflow is installed all the same: its runs do not start until a version passes.
      const registered = input.registered;
      if (registered?.latest.candidate === true) {
        throw new RunRefusal("candidate", `the workflow ${registered.id} has only a candidate version: it is installed once a version is promoted`);
      }
      const file = registered === undefined ? resolveFile(opts.root, input.file ?? "") : storedOf(registered.id, registered.latest.version);
      const script = readScript(file);
      if (script === undefined) throw new RunRefusal("script-unreadable", `the script "${file}" cannot be read`);
      const boxed = await boxOf(input.box);
      const report = await checked(ctx, { file, text: script.text }, boxed);
      if (!report.ok || report.contract === undefined) throw new ScriptCheckFailed(report.errors);
      const contract = report.contract;
      const on = await scriptOn({ file, text: script.text });
      if (on === undefined || "bad" in on || on.subscriptions.length === 0) {
        throw new RunRefusal("nothing-to-start-on", `the script "${file}" has no \`on\`: no record would start it`);
      }
      const uses = await scriptUses({ file, text: script.text });
      const masks = uses !== undefined && "masks" in uses ? uses.masks.map((use) => use.mask).filter(isUse) : [];
      // The profile is what the installer may give: narrow(installer, uses), and the script's own records. A target
      // template is filled by each record that starts a run, and held to the installer then.
      const asker = ctx.caller;
      const narrowed = api.narrow(asker, masks.filter((mask) => !isRuleTemplate(mask)));
      if ("refused" in narrowed) throw new UsesRefused(narrowed.refused.map((text) => text.replace(/^call:/, "")));
      const subscriptions = on.subscriptions.map(({ type, filter }) => ({ type, ...(filter === undefined ? {} : { filter }) }));
      const id = installationIndex.issue(ctx.operationId);
      setProfile(id, [...specsOf(narrowed.rules), emitRule], ctx.caller);
      await ctx.emit(SubscriptionInstalled, {
        installation: id,
        description: input.description,
        ...(registered === undefined ? {} : { workflow: registered.id, version: registered.latest.version }),
        file,
        hash: script.hash,
        on: subscriptions,
        uses: masks,
        ...(report.input === undefined ? {} : { input: report.input }),
        ...(report.output === undefined ? {} : { output: report.output }),
        contract,
        ...(asker.kind === "client" && asker.principal !== undefined ? { installer: asker.principal } : {}),
        ...(boxed ? { box: true } : {}),
        ...(input.builtin === undefined ? {} : { builtin: input.builtin }),
      });
      return { id, profile: profileOf(id), on: subscriptions };
    };

    api.action(
      action(workflowInstall, {
        // The profile and the installation are written: a cut-off install may have made them, so it is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if ((input.id === undefined) === (input.file === undefined)) {
            throw new RunRefusal("install-what", "an installation names the workflow to install: its id, or a script file, one of the two");
          }
          return installScript(ctx, {
            ...(input.id === undefined ? { file: input.file ?? "" } : { registered: workflowOf(input.id) }),
            description: input.description,
            ...(input.box === undefined ? {} : { box: input.box }),
          });
        },
      }),
    );

    /** End an installation and empty its profile. */
    const uninstallOne = async (ctx: ActionContext, id: InstallationId, reason: string): Promise<void> => {
      await ctx.emit(SubscriptionUninstalled, { installation: id, reason });
      setProfile(id, [], ctx.caller);
    };

    api.action(
      action(workflowUninstall, {
        // The installation ends once: a cut-off uninstall may have ended it, so it is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const stands = standing(journal());
          const id = installationIndex.require(input.id, (one) => stands.some((here) => here.id === one));
          const installed = stands.find((one) => one.id === id);
          mayAct(ctx.caller, installed?.installer, `uninstall ${id}`);
          if (installed?.builtin !== undefined) {
            throw new RunRefusal(
              "builtin",
              `${id} is the built-in "${installed.builtin.name}" of the plugin "${installed.builtin.plugin}": it is installed again when the host starts. Turn it off with the option of the plugin`,
            );
          }
          await uninstallOne(ctx, id, "uninstalled");
          return { id };
        },
      }),
    );

    /** An installation as `get` shows it, with why its runs do not start when its workflow is broken. */
    const installationEntry = (one: Installation) => {
      const broken =
        one.workflow === undefined ? undefined : workflowsOf(journal()).find((wf) => wf.id === one.workflow)?.versions.find((v) => v.version === one.version)?.broken;
      return {
        id: one.id,
        description: one.description,
        ...(one.workflow === undefined ? {} : { workflow: one.workflow }),
        ...(one.version === undefined ? {} : { version: one.version }),
        file: one.file,
        hash: one.hash,
        on: one.on,
        uses: one.uses,
        ...(one.input === undefined ? {} : { input: one.input }),
        ...(one.output === undefined ? {} : { output: one.output }),
        contract: one.contract,
        ...(broken === undefined ? {} : { broken }),
        ...(one.builtin === undefined ? {} : { builtin: one.builtin }),
      };
    };

    api.action(
      action(workflowInstallationList, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: () => ({
          items: standing(journal()).map((one) => ({
            id: one.id,
            description: one.description,
            ...(one.workflow === undefined ? {} : { workflow: one.workflow }),
            file: one.file,
            hash: one.hash,
            on: one.on,
            ...(one.builtin === undefined ? {} : { builtin: one.builtin }),
          })),
        }),
      }),
    );

    api.action(
      action(workflowInstallationGet, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          const all = installationsOf(journal());
          const id = installationIndex.require(input.id);
          const found = all.filter((one) => one.id === id).at(-1);
          if (found === undefined) throw new RunRefusal("unknown-installation", `no workflow installation "${input.id}"`);
          return installationEntry(found);
        },
      }),
    );

    // --- registered workflows ---------------------------------------------------------------------

    /**
     * Check again the workflows that depend on one that changed (it is called by them, or its records are waited for or
     * read by them): each check is a record, and a version whose latest check failed is broken.
     */
    const recheckDependents = async (
      ctx: ActionContext,
      changed: WorkflowId,
      dependents: readonly RegisteredWorkflow[],
    ): Promise<Array<{ id: WorkflowId; version: WorkflowVersion; ok: boolean }>> => {
      // The checks do not depend on each other, so they go together (the describer bounds the modules read at once);
      // the records are written in the order of the dependents.
      const reports = await Promise.all(
        dependents.map((dependent) => {
          const file = storedEntry(api.home(), dependent.id, dependent.latest.version);
          const script = file === undefined ? undefined : readScript(file);
          return file === undefined || script === undefined ? undefined : checked(ctx, { file, text: script.text }, opts.box ?? false);
        }),
      );
      const rechecked: Array<{ id: WorkflowId; version: WorkflowVersion; ok: boolean }> = [];
      for (const [at, dependent] of dependents.entries()) {
        const latest = dependent.latest;
        const report = reports[at];
        const errors = report?.errors ?? [{ file: latest.file, line: 0, column: 0, code: "script-unreadable", message: "the script cannot be read" }];
        const ok = report?.ok === true;
        const now = workflowsOf(journal());
        const calls = latest.calls.map((call): FlowCall => ({ workflow: call.workflow, contract: now.find((one) => one.id === call.workflow)?.latest.contract ?? call.contract }));
        await ctx.emit(WorkflowRechecked, { workflow: dependent.id, version: latest.version, because: changed, ok, errors, calls });
        rechecked.push({ id: dependent.id, version: latest.version, ok });
      }
      return rechecked;
    };

    /**
     * Register a script: a new workflow, or a new version of `existing`. A built-in is registered under the description
     * its plugin gives; any other takes the one the script declares.
     */
    const registerScript = async (
      ctx: ActionContext,
      file: string,
      existing: RegisteredWorkflow | undefined,
      builtin?: { builtin: Builtin; description: EntityDescription; candidate?: true },
    ) => {
      const script = readScript(file);
      const version = versionOf(file);
      if (script === undefined || version === undefined) throw new RunRefusal("script-unreadable", `the script "${file}" cannot be read`);
      const report = await checked(ctx, { file, text: script.text }, opts.box ?? false);
      if (!report.ok || report.contract === undefined) throw new ScriptCheckFailed(report.errors);
      const described = EntityDescription.safeParse(builtin?.description ?? report.description);
      if (!described.success) {
        throw new RunRefusal(
          "no-description",
          `a registered workflow says what it is: give workflow({ description }) a few words, ${String(DESCRIPTION_MIN)} to ${String(DESCRIPTION_MAX)} characters on one line`,
        );
      }
      const description = described.data;
      // The records of a script are written under its name: two workflows with one name would be one in the record catalogue.
      // What the module declares is read once for this version: the check above has just kept it.
      const declared = await describe(file, boxFor(opts.box ?? false));
      const name = "described" in declared ? declared.described.name : undefined;
      const holder = name === undefined ? undefined : workflowsOf(journal()).find((one) => one.id !== existing?.id && one.latest.name === name);
      if (holder !== undefined) {
        throw new RunRefusal("name-taken", `the name "${String(name)}" is used by the workflow ${holder.id}: a workflow takes a name of its own, its records are written under it`);
      }
      if (existing !== undefined && existing.latest.version === version && existing.latest.description === description) {
        storeVersion(api.home(), existing.id, version, file);
        linkOfferedPackages(api.home(), scriptPackages().packages);
        return { id: existing.id, version, description: existing.latest.description, added: false, rechecked: [] };
      }
      const id = existing?.id ?? workflowIndex.issue(ctx.operationId);
      // The code of the version is kept in the home before it is registered: a registered version always has its copy.
      storeVersion(api.home(), id, version, file);
      linkOfferedPackages(api.home(), scriptPackages().packages);
      const uses = await scriptUses({ file, text: script.text });
      const reads = await scriptReads({ file, text: script.text });
      const on = await scriptOn({ file, text: script.text });
      const subscriptions = on === undefined || "bad" in on ? [] : on.subscriptions.map(({ type, filter }) => ({ type, ...(filter === undefined ? {} : { filter }) }));
      const masks = uses !== undefined && "masks" in uses ? uses.masks.map((use) => use.mask).filter(isUse) : [];
      const workflows = workflowsOf(journal());
      const calls = masks.flatMap((mask): FlowCall[] => {
        const called = workflows.find((one) => flowActionName(one.id) === useName(mask));
        return called === undefined ? [] : [{ workflow: called.id, contract: called.latest.contract }];
      });
      await ctx.emit(WorkflowRegistered, {
        workflow: id,
        version,
        file,
        description,
        ...(report.input === undefined ? {} : { input: report.input }),
        ...(report.output === undefined ? {} : { output: report.output }),
        contract: report.contract,
        uses: masks,
        calls,
        ...(name === undefined ? {} : { name }),
        reads,
        ...(report.emits === undefined ? {} : { emits: report.emits }),
        ...(subscriptions.length === 0 ? {} : { on: subscriptions }),
        ...(report.phases === undefined ? {} : { phases: report.phases }),
        ...(builtin === undefined ? {} : { builtin: builtin.builtin }),
        ...(builtin?.candidate === true ? { candidate: true } : {}),
      });
      // A candidate is not what the workflow is yet: the workflows that call it or read its records are not checked against it.
      if (builtin?.candidate === true) return { id, version, description, added: true, rechecked: [] };
      // The workflows that call it, when its contract changed, and the ones that wait for or read the records it
      // writes, when what it writes changed (a new name changes the types as well): each is checked again, once.
      const before = existing?.latest;
      const typesOf = (emitted: readonly EmittedRecord[] | undefined): string[] => (emitted ?? []).map((one) => one.type);
      const sameTypes = before !== undefined && typesOf(before.emits).join() === typesOf(report.emits).join();
      const contractChanged = before !== undefined && before.contract !== report.contract;
      const writes = new Set([...typesOf(before?.emits), ...typesOf(report.emits)]);
      const now = workflowsOf(journal());
      const dependents = new Map<WorkflowId, RegisteredWorkflow>();
      if (contractChanged) for (const one of dependentsOf(now, id)) dependents.set(one.id, one);
      if (contractChanged || !sameTypes) for (const one of readersOf(now, id, writes)) dependents.set(one.id, one);
      const rechecked = await recheckDependents(ctx, id, [...dependents.values()]);
      return { id, version, description, added: true, rechecked };
    };

    api.action(
      action(workflowRegister, {
        // A registration is written once: a cut-off one may have made the workflow, so it is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const existing = input.id === undefined ? undefined : workflowOf(input.id);
          if (existing?.builtin !== undefined) {
            throw new RunRefusal(
              "builtin",
              `${existing.id} is the built-in "${existing.builtin.name}" of the plugin "${existing.builtin.plugin}": its versions come with the plugin, a file is not registered under it. Register the file as a workflow of its own`,
            );
          }
          // A new version moves the latest of a workflow: only whoever made it, or the owner, may move it.
          if (existing !== undefined) mayAct(ctx.caller, makerOf(existing), `register a version of the workflow ${existing.id}`);
          return registerScript(ctx, resolveFile(opts.root, input.file), existing);
        },
      }),
    );

    /** Who made a workflow: the principal its first registration was written by; none when the host or a handler made it. */
    const makerOf = (registered: RegisteredWorkflow): Principal | undefined => {
      const actor = journal().get(registered.record)?.actor;
      return actor?.kind === "client" ? actor.principal : undefined;
    };

    /** The installations of a workflow that stand. */
    const installationsOfWorkflow = (id: WorkflowId): InstallationId[] =>
      standing(journal()).flatMap((one) => (one.workflow === id ? [one.id] : []));

    api.action(
      action(workflowList, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: () => ({
          items: workflowsOf(journal()).map((one) => ({
            id: one.id,
            description: one.latest.description,
            version: one.latest.version,
            versions: one.versions.length,
            broken: one.latest.broken !== undefined,
            installations: installationsOfWorkflow(one.id),
            ...(one.latest.phases === undefined ? {} : { phases: one.latest.phases }),
            ...(one.builtin === undefined ? {} : { builtin: one.builtin }),
          })),
        }),
      }),
    );

    api.action(
      action(workflowGet, {
        // Nothing is written: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          const found = workflowOf(input.id);
          const versions = found.versions.map((one) => {
            const stored = storedEntry(api.home(), found.id, one.version);
            return stored === undefined ? one : { ...one, stored };
          });
          return {
            id: found.id,
            description: found.latest.description,
            versions,
            installations: installationsOfWorkflow(found.id),
            ...(found.builtin === undefined ? {} : { builtin: found.builtin }),
          };
        },
      }),
    );

    // --- built-in workflows -----------------------------------------------------------------

    /** The handler that registers and installs the built-ins: the one caller the sync answers. */
    const BUILTINS_HANDLER = "builtins";

    /** The built-ins the plugins offer, as the host wants them now: each file read for its version. */
    const wantedBuiltins = (): WantedBuiltin[] => {
      const wanted: WantedBuiltin[] = [];
      for (const { plugin: by, value } of api.offers(BUILTIN_WORKFLOW)) {
        if (wanted.some((one) => one.plugin === by && one.name === value.name)) {
          throw new Error(`the plugin "${by}" offers two built-in workflows named "${value.name}": a name names one`);
        }
        const version = versionOf(value.file);
        if (version === undefined) throw new Error(`the built-in workflow "${value.name}" of "${by}" has no script at "${value.file}"`);
        wanted.push(WantedBuiltin.parse({ plugin: by, name: value.name, file: value.file, description: value.description, version, ...(value.gated === true ? { gated: true } : {}) }));
      }
      return wanted;
    };

    const sameBuiltin = (one: Builtin | undefined, other: Builtin): boolean => one?.plugin === other.plugin && one.name === other.name;

    /** The installation that is this built-in as it stands: of its workflow, at its accepted latest version, under its description. */
    const isCurrent = (one: Installation, registered: RegisteredWorkflow, item: Builtin): boolean =>
      sameBuiltin(one.builtin, item) &&
      one.workflow === registered.id &&
      one.version === registered.latest.version &&
      one.description === registered.latest.description;

    /** Whether a built-in stands installed: its latest version is accepted and has records to start on. */
    const installable = (registered: RegisteredWorkflow): boolean => registered.latest.candidate !== true && (registered.latest.on?.length ?? 0) > 0;

    /**
     * Whether a wanted built-in is registered as it is wanted: its version is the latest one, or, for a gated built-in,
     * one of its versions, a candidate until it is promoted.
     */
    const isRegistered = (registered: RegisteredWorkflow, item: WantedBuiltin): boolean => {
      if (item.gated !== true) return registered.latest.version === item.version && registered.latest.description === item.description;
      return registered.versions.some((one) => one.version === item.version && one.description === item.description);
    };

    /**
     * Whether the built-ins that stand are exactly the wanted ones: each registered as it is wanted and installed once at
     * its accepted latest version, a built-in with no accepted version not at all, and no other built-in installed. A host
     * that starts again with nothing changed writes nothing.
     */
    const builtinsSettled = (reader: JournalReader, wanted: readonly WantedBuiltin[]): boolean => {
      const workflows = workflowsOf(reader);
      const stands = standing(reader).filter((one) => one.builtin !== undefined);
      let installed = 0;
      const each = wanted.every((item) => {
        const registered = builtinOf(workflows, item);
        if (registered === undefined || !isRegistered(registered, item)) return false;
        if (!installable(registered)) return !stands.some((one) => sameBuiltin(one.builtin, item));
        installed += 1;
        return stands.some((one) => isCurrent(one, registered, item));
      });
      return each && stands.length === installed;
    };

    // When the host starts, the built-ins are compared with what stands, and asked for when they differ: a new build of
    // niwa with a changed script, a plugin that offers a new one or no longer offers one.
    api.service((ctx) => {
      hostClock = ctx;
      // The packages offered now are the ones a stored copy finds: a package no plugin offers any more is not found.
      const scripts = scriptPackages();
      for (const problem of scripts.refused) console.error(`niwa: ${problem}`);
      linkOfferedPackages(api.home(), scripts.packages);
      // The deadlines of the runs that are going are waited for again: one that passed while the host was away comes now.
      for (const run of new Set(journal().find({ type: RunRequested.name }).map((row) => RunRequested.schema.parse(row.data).run))) {
        if (statusOf(journal(), run).state !== "finished") watchDeadline(run);
      }
      void (async () => {
        const wanted = wantedBuiltins();
        if (!builtinsSettled(journal(), wanted)) await ctx.emit(BuiltinsWanted, { items: wanted });
      })().catch((error: unknown) => {
        console.error(`niwa: the built-in workflows could not be installed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return () => {
        for (const stop of deadlineTimers.values()) stop();
        deadlineTimers.clear();
      };
    });

    /**
     * The installation of a built-in made what its registration says: one at its accepted latest version, and none while
     * it has only a candidate or nothing to start on (a suite is started by hand). An installation of another version is ended.
     */
    const installBuiltin = async (ctx: ActionContext, registered: RegisteredWorkflow, builtin: Builtin): Promise<{ installation?: string }> => {
      const stands = standing(journal()).filter((one) => sameBuiltin(one.builtin, builtin));
      const current = installable(registered) ? stands.find((one) => isCurrent(one, registered, builtin)) : undefined;
      for (const stale of stands) if (stale !== current) await uninstallOne(ctx, stale.id, "replaced by another version of the built-in");
      if (!installable(registered)) return {};
      if (current !== undefined) return { installation: current.id };
      const installed = await installScript(ctx, { registered, description: registered.latest.description, builtin });
      return { installation: installed.id };
    };

    /**
     * One built-in made what it is wanted to be: registered from the file its plugin ships (its id found by the plugin and
     * the name), and installed once at its latest version; an installation of an earlier version is ended. Each part looks
     * at what stands first, so a sync made again after a cut makes nothing twice.
     */
    const builtinSync = action("workflow.builtin.sync", {
      description: "Register a built-in workflow from the file its plugin ships and install it at its latest version. For the workflow module itself, when the host starts.",
      input: WantedBuiltin,
      output: BuiltinSynced,
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (item, ctx) => {
        const caller = ctx.caller;
        if (caller.kind !== "handler" || String(caller.handler) !== `workflow/${BUILTINS_HANDLER}`) {
          throw new DeniedError("only the workflow module installs its built-ins");
        }
        const builtin: Builtin = { plugin: item.plugin, name: item.name };
        const existing = builtinOf(workflowsOf(journal()), builtin);
        // A gated built-in registers a version it does not know as a candidate; one it knows, accepted or not, stays as it is.
        const id =
          item.gated === true && existing !== undefined && isRegistered(existing, item)
            ? existing.id
            : (await registerScript(ctx, item.file, existing, { builtin, description: item.description, ...(item.gated === true ? { candidate: true as const } : {}) })).id;
        return { workflow: id, ...(await installBuiltin(ctx, workflowOf(id), builtin)) };
      },
    });
    api.action(builtinSync);

    /** A built-in no plugin offers any more is uninstalled; its registration stays, with its runs. */
    const builtinRetire = action("workflow.builtin.retire", {
      description: "Uninstall the built-in workflows no plugin offers any more. For the workflow module itself, when the host starts.",
      input: BuiltinRetireInput,
      output: BuiltinRetired,
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async ({ keep }, ctx) => {
        const caller = ctx.caller;
        if (caller.kind !== "handler" || String(caller.handler) !== `workflow/${BUILTINS_HANDLER}`) {
          throw new DeniedError("only the workflow module uninstalls its built-ins");
        }
        const gone = standing(journal()).filter((one) => one.builtin !== undefined && !keep.some((kept) => sameBuiltin(one.builtin, kept)));
        for (const one of gone) await uninstallOne(ctx, one.id, "its plugin no longer offers it");
        return { uninstalled: gone.map((one) => one.id) };
      },
    });
    api.action(builtinRetire);

    /**
     * Candidates of gated built-ins accepted together by the run of a built-in of the same plugin that tried them: one
     * record with the run. The built-ins are then asked for again, so the module's own handler installs each at its new
     * latest version, as it installs every built-in: not the run, whose grant is not the built-in's. A set already
     * accepted writes nothing.
     */
    api.action(
      action(workflowBuiltinPromote, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const caller = ctx.caller;
          const plugin = builtinPluginOf(caller);
          if (plugin === undefined || caller.kind !== "client" || caller.principal === undefined) {
            throw new DeniedError("only a run of a built-in workflow promotes the candidates of its plugin");
          }
          const workflows = workflowsOf(journal());
          // Every version must be one of the plugin's built-ins, a candidate or accepted already: one that is not refuses the set.
          const named = input.versions.map(({ workflow: id, version }) => {
            const registered = workflows.find((one) => one.id === id);
            const found = registered?.versions.find((one) => one.version === version);
            if (registered?.builtin?.plugin !== plugin || found === undefined) {
              throw new RunRefusal("not-a-candidate", `${id} at ${version} is no version of a built-in of the plugin "${plugin}": nothing is promoted`);
            }
            return { registered, found };
          });
          const run = RunId.parse(runIdOfPrincipal(caller.principal.id));
          if (named.some(({ found }) => found.candidate === true)) {
            await ctx.emit(BuiltinPromoted, { run, versions: input.versions.map(({ workflow: id, version }) => ({ workflow: id, version })) });
            await ctx.emit(BuiltinsWanted, { items: wantedBuiltins() });
          }
          return { run, versions: input.versions };
        },
      }),
    );

    api.on(BuiltinsWanted, { id: BUILTINS_HANDLER }, async (data, step) => {
      await step(builtinRetire, { keep: data.items.map(({ plugin, name }) => ({ plugin, name })) }, { key: "retire" });
      // The built-ins do not wait on each other, and each script is read in a process of its own: they go together. The
      // steps are keyed by the built-in, so a replay meets each one whatever the order they ran in.
      await Promise.all(data.items.map((item) => step(builtinSync, item, { key: `sync:${item.plugin}:${item.name}` })));
    });

    /** The action of a version of a workflow, made once: its schemas are read from the registration, not the script. */
    const flows = new Map<string, Action<any, any>>();
    const flowOf = (registered: RegisteredWorkflow): Action<any, any> => {
      const key = `${registered.id}@${registered.latest.version}@${registered.latest.broken ?? ""}`;
      const made = flows.get(key);
      if (made !== undefined) return made;
      const latest = registered.latest;
      const flow = action(flowActionName(registered.id), {
        description: `${latest.description}. Runs the workflow ${registered.id} to its end and answers what it returns.${latest.broken === undefined ? "" : ` Broken, it does not start: ${latest.broken}`}`,
        input: latest.input === undefined ? z.object({}) : schemaOf(latest.input),
        output: latest.output === undefined ? z.null() : schemaOf(latest.output),
        // The run is asked for: a call that was cut off may have begun one, so it is not made again.
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input: unknown, ctx: ActionContext) => {
          const current = workflowOf(registered.id);
          // A run that calls a workflow is the parent of the run it starts: a cancel and a pause go down to it.
          const caller = ctx.caller.kind === "client" && ctx.caller.principal?.kind === "run" ? runIdOfPrincipal(ctx.caller.principal.id) : undefined;
          const parent = caller === undefined ? undefined : { run: caller, step: String(ctx.operationId) };
          // A workflow that takes no input is called with an empty object, and its run is given nothing.
          const args = current.latest.input === undefined ? undefined : input;
          const run = await requestRun(ctx, { ...registeredTarget(current), args, ...(parent === undefined ? {} : { parent }) });
          const status = await settleFully(run);
          const outcome = status.outcome;
          if (outcome?.status === "done") return outcome.result;
          if (outcome?.status === "failed") throw new RunRefusal("flow-failed", `the run ${run} of ${registered.id} failed: ${outcome.error.message}`);
          if (outcome?.status === "cancelled") throw new RunRefusal("flow-cancelled", `the run ${run} of ${registered.id} was cancelled`);
          throw new RunRefusal("flow-paused", `the run ${run} of ${registered.id} paused: ${status.reason ?? "a decision is needed"}. Answer it with workflow.resume`);
        },
      });
      flows.set(key, flow);
      return flow;
    };
    // Every registered workflow is an action: the catalog grows from the journal.
    api.catalog(() => (api.journal?.() === undefined ? [] : workflowsOf(journal()).map(flowOf)));

    /** A calling workflow keeps waiting through a manual pause of its child. */
    const settleFully = async (run: RunId): Promise<RunStatus> => {
      for (;;) {
        const status = await settle(run, DEFAULT_WAIT_MS, false);
        if (settled(status, false)) return status;
      }
    };

    // A session started by an MCP helper has no step in the script's invocation.
    // The durable ownership record includes these sessions even after a restart.
    const finishedExecution = (run: string, execution = run) =>
      journal().find({ type: RunFinished.name, field: "run", equals: run }).some(row => {
        const finish = RunFinished.schema.parse(row.data);
        return (finish.execution ?? run) === execution;
      }) || (latestRequest(run)?.execution ?? run) !== execution;

    const closeExecution = async (run: string, execution: string, step: Parameters<Handler<unknown>>[1], cancelled = false) => {
      const reason = cancelled ? `the run ${run} that started it was cancelled` : `the run ${run} finished`;
      for (const row of journal().find({ type: SessionStarted.name, field: "run", equals: run })) {
        const started = SessionStarted.schema.parse(row.data);
        if ((started.execution ?? run) === execution) await step.outcome(sessionEnd, { session: started.session, reason }, { key: `end:${digestOf(started.session)}` });
      }
      const hasGrant = journal().find({ type: AccessGranted.name, field: "principal.id", equals: execution })
        .some(row => AccessGranted.schema.parse(row.data).principal.kind === "run");
      if (hasGrant) {
        await step.outcome(actionName("access.grant.close"), { principal: principalOf("run", execution), reason }, { key: "close-grant" });
      } else {
        for (const row of journal().find({ type: SessionStartReserved.name, field: "run", equals: run })) {
          const reserved = SessionStartReserved.schema.parse(row.data);
          if ((reserved.execution ?? run) === execution && reserved.mark !== undefined) await step.outcome(actionName("access.grant.close"), {
            principal: principalOf("session", reserved.mark), reason,
          }, { key: `close:${reserved.mark}` });
        }
      }
    };
    api.on(RunFinished, { id: "end-run-sessions", concurrency: Infinity }, async ({ run, execution, outcome }, step) => {
      await closeExecution(run, execution ?? run, step, outcome.status === "cancelled");
    });
    api.on(RunRequested, { id: "end-superseded-execution", concurrency: Infinity }, async ({ run, execution }, step, stored) => {
      if (execution === undefined) return;
      const previous = journal().find({ type: RunRequested.name, field: "run", equals: run }).filter(row => row.seq < stored.seq).at(-1);
      if (previous === undefined) return;
      const prior = RunRequested.schema.parse(previous.data).execution ?? run;
      const finished = journal().find({ type: RunFinished.name, field: "run", equals: run })
        .some(row => (RunFinished.schema.parse(row.data).execution ?? run) === prior);
      if (!finished) await closeExecution(run, prior, step);
    });
    api.on(SessionStartReserved, { id: "close-late-session-grant", concurrency: Infinity }, async ({ run, execution, mark }, step, stored) => {
      if (run === undefined || mark === undefined) return;
      const cancelled = journal().find({ type: CORE_TYPES.stepCancelled }).some(row => {
        const cancel = row.data as StepsCancelled;
        const key = sessionStep(stored, cancel.invocation);
        return key !== undefined && cancelHolds(cancel, key);
      });
      const scopeEnded = journal().find({ type: ScopeClosed.name, field: "run", equals: run }).some(row => {
        if (row.actor.kind !== "handler") return false;
        const key = sessionStep(stored, row.actor.invocation);
        return key !== undefined && keyUnder(key, ScopeClosed.schema.parse(row.data).scope);
      });
      if (cancelled || scopeEnded || finishedExecution(run, execution)) {
        await step.outcome(actionName("access.grant.close"), { principal: principalOf("session", mark), reason: cancelled || scopeEnded ? "the workflow scope ended" : `the run ${run} finished` });
      }
    });
    api.on(SessionStarted, { id: "end-late-run-session", concurrency: Infinity }, async ({ run, execution, session }, step) => {
      if (run !== undefined && finishedExecution(run, execution)) {
        await step(sessionEnd, { session, reason: `the run ${run} finished` });
      }
    });

    // Runs are independent of each other: one that waits for an answer holds no other. A run that calls
    // another workflow requests a run from inside its own: the chain of calls goes as deep as CALL_DEPTH.
    api.on(
      RunRequested,
      { concurrency: Number.POSITIVE_INFINITY, reentrant: { depth: CALL_DEPTH } },
      async (data, step) => {
      const { run, file } = data;
      // The run acts as its own principal: its grant is what the script is held to.
      const principal = principalOf("run", data.execution ?? run);
      const runCaller = callerOf(principal);
      const args = data.args ?? null;
      const script = readScript(file);
      // The hash of the script as it is now: a later resume that finds another hash knows the
      // script was edited, and the run it continues is a revision.
      const hash = data.hash ?? script?.hash;
      // What the module declares as it is now: the version of the script, with the files it imports, says whether it was read.
      const read = script === undefined ? undefined : await describe(file, boxFor(data.box), `describe:${run}`);
      const described = read !== undefined && "described" in read && read.described.problems.length === 0 ? read.described : undefined;
      const contract = described === undefined ? undefined : contractOf(described);
      const records = script !== undefined && (await scriptOn({ file, text: script.text })) !== undefined;
      // A contract that is not the one the run was asked under: the arguments it recorded must pass the input it has now.
      const changed =
        described !== undefined && data.contract !== undefined && contract !== data.contract ? inputIssues(described.input, records, args) : [];
      const started = await step.emit(
        RunStarted,
        {
          run,
          file,
          args,
          ...(data.label === undefined ? {} : { label: data.label }),
          ...(hash === undefined ? {} : { hash }),
          // A run that stops on a changed contract keeps the contract it began under: a resume meets the same change.
          ...((changed.length > 0 ? data.contract : contract) === undefined ? {} : { contract: changed.length > 0 ? data.contract : contract }),
          ...(data.box === true ? { box: true } : {}),
          ...(described?.phases === undefined ? {} : { phases: described.phases }),
          ...originOf(data),
        },
        { key: "started" },
      );
      const current = started.actor.kind === "handler" ? started.actor.invocation : undefined;
      /** The titles of the phases the script declares: what `phase(title)` may name. */
      const titles = (described?.phases ?? []).map((phase) => phase.title);
      // The calls the earlier starts of this run finished: a call with the same key and input is
      // taken from them along the longest unchanged prefix (see revise.ts).
      const before = factsOf(journal(), run)?.invocations.filter((invocation) => invocation !== current) ?? [];
      const earlier = recordedCalls(journal(), api.artifacts, before);

      // The notes of the script are emitted one after another, so a replay finds them in order.
      // Each note has a key of its own, and the key says what the note is about: a run that is
      // answered and goes on ends differently than the run that paused, and the two must not
      // write over each other. Every kind counts its own notes, so one kind does not move the
      // keys of another.
      let notes: Promise<unknown> = Promise.resolve();
      const ordinals = new Map<string, number>();
      const noteAt = <T>(type: Parameters<typeof step.emit<T>>[0], body: T, key: string): void => {
        notes = notes.then(() => step.emit(type, body, { key }));
      };
      const note = <T>(type: Parameters<typeof step.emit<T>>[0], body: T, kind: string): void => {
        const ordinal = (ordinals.get(kind) ?? 0) + 1;
        ordinals.set(kind, ordinal);
        noteAt(type, body, `${kind}:${String(ordinal)}`);
      };

      // Whether a step of the script did not complete: the core paused the invocation on that
      // step, and the invocation ends as paused by itself.
      let stepFailed = false;

      const call = bridge({
        step,
        run: principal,
        runId: run,
        ...(data.concurrency === undefined ? {} : { concurrency: data.concurrency }),
        schedule: scheduleAt,
        cancelChild,
        heldBy: (invocation, prefixes, except) => heldBy(journal(), invocation, prefixes, except),
        journal,
        agentAction: actionFor,
        agentName: actionNameOf,
        emits: emitTypesOf(described),
        recordType: (name) => emits.get(name) ?? api.recordType(name),
        earlier,
        ...(data.from === undefined ? {} : { from: data.from }),
        emitted: (key) => {
          // The records an emit writes have the id `<invocation>/emit/<key>`: the latest start that wrote one is the one that counts.
          const found = before.flatMap((invocation) => {
            const row = journal().get(recordId(`${invocation}/emit/${key}`));
            return row === undefined ? [] : [{ invocation, row }];
          });
          const last = found.at(-1);
          return last === undefined ? undefined : { type: last.row.type, data: last.row.data, invocation: last.invocation };
        },
        failed: () => {
          stepFailed = true;
        },
        authorize: async (verb, name, how) => {
          // A hold refuses what would change something: reads and niwa's own records go on.
          const effect = verb === "call" ? api.effectOf(name) : undefined;
          if (effect === "write" || effect === "irreversible") {
            const hold = holdOver(journal(), run);
            if (hold !== undefined) {
              throw new DeniedError(`the run is on hold (${String(hold.id)}): "${name}" ${effect === "write" ? "writes" : "cannot be undone"}, and is refused until the hold is released`);
            }
          }
          // A decision under an `allow` names the version of it, as the start of the run kept it.
          await api.authorize(runCaller, verb, name, { ...how, ...(data.allow === undefined ? {} : { policy: data.allow.version }) });
        },
        visible: (masks) => {
          const narrowed = api.narrow(runCaller, masks);
          if ("refused" in narrowed) throw new UsesRefused(narrowed.refused.map((text) => text.replace(/^call:/, "")), "a session of the run");
        },
      });

      // A run that was cancelled stays cancelled: a replay after a restart finds the end of the
      // run in the journal and does not start the script (or its calls) again. Nothing is awaited
      // between this check and the spawn of the child, so a cancel cannot slip between them.
      const cancelled = journal()
        .find({ type: RunFinished.name, field: "run", equals: run })
        .some((record) => {
          const finish = RunFinished.schema.parse(record.data);
          return (finish.execution ?? run) === (data.execution ?? run) && finish.outcome.status === "cancelled";
        });
      if (cancelled) return;

      // A pause is a journal-backed wait within the same invocation. Keep one waiter per pause
      // when several script branches reach the boundary together.
      const pauseWaits = new Map<string, Promise<unknown>>();
      const pauseKey = (pause: StoredRecord) => `manual-pause:${pause.seq}`;
      const waitForContinue = (pause: StoredRecord): Promise<unknown> => {
        const key = pauseKey(pause);
        let waiting = pauseWaits.get(key);
        if (waiting === undefined) {
          waiting = step.wait(RunContinued, { filter: { run, pause: pause.id }, key });
          pauseWaits.set(key, waiting);
        }
        return waiting;
      };
      const atBoundary = async <T>(enter: () => T | Promise<T>): Promise<T> => {
        for (;;) {
          const pause = activeManualPause(journal(), run);
          if (pause === undefined) return enter();
          await waitForContinue(pause);
        }
      };
      // Settle old waits on replay before checking for a new pause. Otherwise an obsolete intent
      // would stay open in the host's index when the script subsequently waits for something else.
      for (const pause of manualPausesOf(journal(), run)) {
        if (current !== undefined && journal().get(recordId(`${current}/step/${pauseKey(pause)}/intent`)) !== undefined) {
          await waitForContinue(pause);
        }
      }
      await atBoundary(() => undefined);

      // The script is pinned by the hash the run began with: a file that was edited since, while the
      // run was away, is not run under the old calls. The run waits for the owner, who revises it.
      const onDisk = readScript(file)?.hash;
      if (data.hash !== undefined && onDisk !== undefined && onDisk !== data.hash) {
        const reason = "the script was edited since the run began: the run needs a revision";
        await step.emit(RunPaused, { run, reason, choices: ["cancel"] }, { key: `paused:${digestOf(reason)}` });
        return;
      }

      // The copy of a registered version runs only as its manifest says it is: the run is read through the same manifest as its start.
      const stored = data.workflow === undefined || data.version === undefined ? undefined : storedVersion(api.home(), data.workflow, data.version);
      // The module cannot be read for its schemas, or its contract changed so that what the run recorded is no longer its input:
      // the run waits for the owner, who revises it or cancels it.
      const stopped =
        stored !== undefined && "problem" in stored
          ? stored.problem
          : script !== undefined && described === undefined
          ? `the module cannot be read for its schemas: ${read !== undefined && "failed" in read ? read.failed : (read?.described.problems.map((problem) => problem.message).join("; ") ?? "no reading")}`
          : changed.length > 0
            ? `contract-changed: the arguments of the run no longer pass the input of the script (${changed.map((issue) => `${issue.path === "" ? "input" : issue.path}: ${issue.message}`).join("; ")})`
            : undefined;
      if (stopped !== undefined) {
        await step.emit(RunPaused, { run, reason: stopped, choices: ["cancel"] }, { key: `paused:${digestOf(stopped)}` });
        return;
      }

      const ended = await runScript(
        {
          // Commit the preceding phases and log lines before a synchronous call such as now() writes its intent.
          call: async (request) => {
            await notes;
            return atBoundary(async () => {
              const { phase } = request;
              // The phase the branch of the step is in, under the key of the step: a replay writes the same record.
              if (phase !== undefined && titles.includes(phase)) {
                await step.emit(StepPhase, { run, key: request.key, phase }, { key: `phase:${request.key}` });
              }
              return call(request);
            });
          },
          // The child holds the title to the declared ones; a line that is not one of them is not the child's and is not recorded.
          // Keyed by the branch and the number of the change within it, so a replay writes the same records whatever the
          // order the branches ran in.
          phase: ({ branch, ordinal, phase }) => {
            if (titles.includes(phase)) noteAt(PhaseEntered, { run, branch, phase }, `phase-entered:${branch === "" ? "script" : branch}:${String(ordinal)}`);
          },
          left: (branch) => noteAt(PhaseLeft, { run, branch }, `phase-left:${branch}`),
          branched: ({ scope, key }) => noteAt(ScopeBranched, { run, scope, key }, `scope-branch:${scope}.${key}`),
          gone: () => call.gone(),
          log: (text) => note(RunLog, { run, text }, "log"),
          // A cancelled run's calls that are in flight fail because of the cancel: they pause nothing.
          stopped: () => step.abandon(),
          fresh: (key) => call.fresh(key),
        },
        file,
        args,
        run,
        boxFor(data.box),
        // A run that suspends (a wait, a sleep) still writes what its branches said before it stopped: a branch that ended
        // is not shown in its phase while the run waits.
      ).finally(() => notes.catch(() => undefined));
      await notes;

      // The run was cancelled while it was going: it ends there, and the child is stopped.
      // The cancel wrote the end of the run, so nothing else is written here.
      if (ended.cancelled === true) return;

      // The end of the run is written under a key of its own. The key says how the run ended, so
      // a run that is answered and goes on does not write over the run that paused, and a retry
      // that fails another way does not write over the pause before it.
      if (ended.ok) {
        await atBoundary(() => step.emit(RunFinished, { run, execution: data.execution, outcome: outcomeOf(described?.output, ended.result) }, { key: "finished" }));
        // The sessions its agent calls started were kept up for it while it ran: they go with it.
        for (const session of sessionsOf(journal(), current === undefined ? [] : [current])) {
          await step.outcome(sessionEnd, { session, reason: `the run ${run} that started it finished` }, { key: `end-session:${digestOf(String(session))}` });
        }
        return;
      }
      // The script did not catch the end of an `ask` the owner cancelled or nobody answered. A retry
      // replays the run, and the replay throws the same error again (the end is recorded under
      // `<key>~ended`): there is nothing to retry or skip. The run waits for the owner, who revises
      // the script to catch it or cancels the run, as it does for an edited script.
      const unanswered = stepFailed ? undefined : ASK_ENDINGS.get(ended.errorName ?? "");
      if (unanswered !== undefined) {
        await step.emit(RunPaused, { run, reason: unanswered, choices: ["cancel"] }, { key: `paused:${digestOf(unanswered)}` });
        return;
      }
      const reason = ended.error ?? "the script failed";
      // A step that failed is retried or skipped; an error of the script outside any step has no step
      // to skip, and its key says so, so a run paused before it was told apart replays without a mismatch.
      const outside = !stepFailed;
      await step.emit(
        RunPaused,
        { run, reason, choices: outside ? ["retry", "cancel"] : ["retry", "skip", "cancel"] },
        { key: `paused:${digestOf(reason)}${outside ? ":script" : ""}` },
      );
      // A script error that no step caused is a failure of the handler, and the core pauses an
      // invocation whose handler fails: the pause is a request (the run offers retry and cancel), and
      // the run waits on it. Without it the invocation would end as done, with the run said to be
      // paused and nobody to answer. A step that did not complete has paused the invocation already.
      if (!stepFailed) throw new Error(reason);
    });
  });
}

/**
 * Why a run waits when its script did not catch the end of an \`ask\`: by the name of the error the script ended with.
 *
 * A replay throws the same error, so the run offers only cancel; the script is revised to catch it.
 */
const ASK_ENDINGS: ReadonlyMap<string, string> = new Map([
  [AskCancelled.name, "the owner cancelled the question, and the script does not catch AskCancelled: a retry would get the same cancel, so revise the script or cancel the run"],
  [AskExpired.name, "nobody answered the question in time, and the script does not catch AskExpired: a retry would get the same end, so revise the script or cancel the run"],
]);

/**
 * A run cannot do what was asked of it, and the caller is told why.
 *
 * The code says what was refused, so a caller can tell one refusal from another.
 */
export class RunRefusal extends Error {
  override name = "RunRefusal";
  /** The code of the refusal, so a caller can tell one from another. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The rules `uses` asks for with these arguments: every entry as it is written, a target template
 * filled from the arguments. A value that would widen a rule, or a placeholder with no value,
 * refuses the run.
 */
export function filledUses(uses: readonly string[], args: unknown): string[] {
  return uses.filter(isUse).map((use) => {
    if (!isRuleTemplate(use)) return use;
    try {
      return fillRule(use, args);
    } catch (error) {
      throw new RunRefusal("uses-template", `uses "${use}" cannot be filled from the input: ${(error as Error).message}`);
    }
  });
}

/** A run asked for more than whoever starts it holds: nothing is created, and the masks say what was refused. */
export class UsesRefused extends RunRefusal {
  override name = "UsesRefused";
  /** The masks that are not the caller's. */
  readonly refused: readonly string[];

  constructor(refused: readonly string[], who = "a script") {
    super(
      "wider-than-caller",
      `${who} cannot have more than whoever starts it: ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not held`,
    );
    this.refused = refused;
  }
}

/** A script did not pass its check: `workflow.start` does not run it, and the errors say why. */
export class ScriptCheckFailed extends RunRefusal {
  override name = "ScriptCheckFailed";
  /** The errors of the check, with their places. */
  readonly errors: readonly CheckError[];

  constructor(errors: readonly CheckError[]) {
    super(
      "script-check-failed",
      `the script does not pass its check (the script was not run):\n${errors.map((e) => `${e.file}:${String(e.line)}:${String(e.column)} ${e.code} ${e.message}`).join("\n")}`,
    );
    this.errors = errors;
  }
}

/** The arguments of a start do not pass the input of the script: nothing is created, and the issues say which fields. */
export class InputInvalid extends RunRefusal {
  override name = "InputInvalid";
  /** The fields that did not pass, with the path of each. */
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(
      "input-invalid",
      `the arguments do not pass the input of the script:\n${issues.map((issue) => `${issue.path === "" ? "(input)" : issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.issues = issues;
  }
}

/** A JSON Schema as data, as a zod schema again. */
function schemaOf(schema: JsonSchemaValue): z.ZodType {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** What a value does not hold of a JSON Schema as data: the fields that did not pass, none when it passes. */
function issuesOf(schema: JsonSchemaValue, value: unknown): Issue[] {
  const parsed = schemaOf(schema).safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * What the arguments of a run do not hold of the input of its script.
 *
 * A script with no `input` takes none; a script that starts on records takes the record, which the
 * core already holds to the schema of its type; any other takes the fields of its `input`, and an
 * absent argument is an empty object, so a script whose fields all have defaults needs none.
 */
function inputIssues(input: JsonSchemaValue | undefined, startsOnRecords: boolean, args: unknown): Issue[] {
  if (startsOnRecords) return [];
  if (input === undefined) return args === null || args === undefined ? [] : [{ path: "", message: "this script takes no input" }];
  return issuesOf(input, args ?? {});
}

/** How a run ends with what its script returned: held to the `output` of the script, which is nothing when it declares none. */
function outcomeOf(output: Described["output"], returned: unknown): RunOutcome {
  const result = z.json().parse(returned ?? null);
  const issues = output === undefined ? (result === null ? [] : [{ path: "", message: "the script declares no output, and returned a value" }]) : issuesOf(output, result);
  if (issues.length === 0) return { status: "done", result };
  const message = `the result does not pass the output of the script: ${issues.map((issue) => `${issue.path === "" ? "(result)" : issue.path}: ${issue.message}`).join("; ")}`;
  return { status: "failed", error: { code: "output-invalid", message, issues } };
}

function resolveFile(root: string | undefined, file: string): string {
  return root === undefined || file.startsWith("/") ? file : `${root.replace(/\/$/, "")}/${file}`;
}

/** The run as its start records hold it; the latest start gives the file and the arguments. */
function factsOf(journal: JournalReader, run: string): RunFacts | undefined {
  const starts = journal.find({ type: RunStarted.name, field: "run", equals: run });
  const last = starts.at(-1);
  if (last === undefined) return undefined;
  const data = RunStarted.schema.parse(last.data);
  return {
    file: data.file,
    args: data.args ?? null,
    ...(data.label === undefined ? {} : { label: data.label }),
    ...(data.hash === undefined ? {} : { hash: data.hash }),
    ...(data.contract === undefined ? {} : { contract: data.contract }),
    ...(data.box === true ? { box: true } : {}),
    ...originOf(data),
    invocations: starts.flatMap((start) => (start.actor.kind === "handler" ? [String(start.actor.invocation)] : [])),
  };
}

/** The run ids that were issued, each with the first record that asked for its run. */
function runsIssuedOf(journal: JournalReader): IssuedId[] {
  const issued = new Map<string, IssuedId>();
  for (const row of journal.find({ type: RunRequested.name })) {
    const run = RunRequested.schema.parse(row.data).run;
    if (!issued.has(run)) issued.set(run, { id: run, seed: row.id });
  }
  return [...issued.values()];
}

/** Who started a run: the principal its grant came from. Absent when nothing limited whoever started it. */
function ownerOfRun(journal: JournalReader, run: string): Principal | undefined {
  for (const row of journal.find({ type: CORE_TYPES.accessGranted, field: "principal.id", equals: run })) {
    const granted = AccessGranted.schema.parse(row.data);
    if (granted.principal.kind === "run") return granted.parent?.principal;
  }
  return undefined;
}

/**
 * A run, or an installation, is for whoever started it, and for the owner. A caller nothing limits
 * (the host, a handler) is the module's own business and passes.
 */
function mayAct(caller: Caller, started: Principal | undefined, what: string): void {
  if (!isOwnerOrStarter(caller, started)) throw new DeniedError(`only the owner or whoever made it may ${what}`);
}

function isOwnerOrStarter(caller: Caller, started: Principal | undefined): boolean {
  if (caller.kind !== "client") return true;
  const who = caller.principal;
  if (who?.kind === "owner") return true;
  return who !== undefined && who.kind === started?.kind && who.id === started.id;
}

/** The earlier of two moments, either of which may be absent. */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/** The sessions the invocations of a run started, that have not ended. */
function sessionsOf(journal: JournalReader, invocations: readonly string[]) {
  const ended = new Set(journal.find({ type: SessionEnded.name }).map((row) => SessionEnded.schema.parse(row.data).session));
  return journal
    .find({ type: SessionMarked.name })
    .filter((row) => row.actor.kind === "handler" && invocations.includes(String(row.actor.invocation)))
    .map((row) => SessionMarked.schema.parse(row.data).session)
    .filter((session) => !ended.has(session));
}

/** The runs a run started, by the parent they name. */
function childrenOf(journal: JournalReader, run: string): RunId[] {
  return [
    ...new Set(
      journal
        .find({ type: RunRequested.name })
        .map((row) => RunRequested.schema.parse(row.data))
        .filter((data) => data.parent?.run === run)
        .map((data) => data.run),
    ),
  ];
}

/** How deep a run is in its tree: 0 for a run no run started. */
function depthOf(journal: JournalReader, run: string): number {
  let depth = 0;
  for (let at = factsOf(journal, run)?.parent?.run; at !== undefined && depth < 1_000; at = factsOf(journal, at)?.parent?.run) depth += 1;
  return depth;
}

/** The shielded scopes of a run that are open: opened and not closed. */
function openShieldsOf(journal: JournalReader, run: string): string[] {
  const after = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1)?.seq;
  const closed = new Set(journal.find({ type: ScopeClosed.name, field: "run", equals: run, after }).map((row) => ScopeClosed.schema.parse(row.data).scope));
  return [
    ...new Set(
      journal
        .find({ type: ScopeOpened.name, field: "run", equals: run, after })
        .map((row) => ScopeOpened.schema.parse(row.data))
        .filter((opened) => opened.shield === true && !closed.has(opened.scope))
        .map((opened) => opened.scope),
    ),
  ];
}

/** Session events emitted by an action retain its host-generated operation in the record ID. */
function sessionStep(row: StoredRecord, invocation: string): string | undefined {
  const id = String(row.id);
  const operation = id.slice(0, id.lastIndexOf("/emit/"));
  return operation.startsWith(invocation + "/") ? operation.slice(invocation.length + 1).replace(/#\d+$/, "") : undefined;
}

/**
 * The sessions and the child runs that steps of an invocation under the prefixes started, and that
 * are still going: what a cancel of those steps interrupts and ends with them.
 */
function heldBy(journal: JournalReader, invocation: string, prefixes: readonly string[], except: readonly string[]): { sessions: Array<z.infer<typeof SessionMarked.schema>["session"]>; marks: string[]; children: RunId[] } {
  const held = (key: string): boolean => prefixes.some((prefix) => keyUnder(key, prefix)) && !except.some((spared) => keyUnder(key, spared));
  // An operation is `<invocation>/<key>`, with `#<n>` for a later attempt.
  const keyOf = (operation: string): string | undefined =>
    operation.startsWith(`${invocation}/`) ? operation.slice(invocation.length + 1).replace(/#\d+$/, "") : undefined;
  const ended = new Set(journal.find({ type: SessionEnded.name }).map((row) => SessionEnded.schema.parse(row.data).session));
  const underBranch = (row: StoredRecord): boolean => {
    const key = sessionStep(row, invocation);
    return key !== undefined && held(key);
  };
  const sessions = journal.find({ type: SessionMarked.name }).filter(underBranch)
    .map(row => SessionMarked.schema.parse(row.data).session).filter(session => !ended.has(session));
  const marks = journal.find({ type: SessionStartReserved.name }).filter(underBranch)
    .flatMap(row => SessionStartReserved.schema.parse(row.data).mark ?? []);
  const children = [
    ...new Set(
      journal
        .find({ type: RunRequested.name })
        .map((row) => RunRequested.schema.parse(row.data))
        .filter((data) => {
          const key = data.parent === undefined ? undefined : keyOf(data.parent.step);
          return key !== undefined && held(key) && statusOf(journal, data.run).state !== "finished";
        })
        .map((data) => data.run),
    ),
  ];
  return { sessions: [...new Set(sessions)], marks, children };
}

/**
 * The script file as it is now: its text, and the sha256 of its bytes.
 *
 * The hash is what tells a replay from a revision: the same bytes are a replay, other bytes are an
 * edited script. A file saved again with the same content is not an edit. Absent when the file
 * cannot be read.
 */
function readScript(file: string): { text: string; hash: string } | undefined {
  try {
    const bytes = readFileSync(file);
    return { text: bytes.toString("utf8"), hash: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return undefined;
  }
}

/**
 * The state of the latest invocation of a run.
 *
 * The state of an invocation is written by the core as it goes, and the latest one is what it is
 * now: a run whose invocation is running is still going, one that is paused waits for a
 * decision, and one that is done has ended. An invocation that never wrote a state is running:
 * it has just been admitted.
 */
function stateOfInvocation(journal: JournalReader, invocation: string): RunState {
  const rows = journal.find({ type: CORE_TYPES.invocationState, field: "invocation", equals: invocation });
  const last = rows.at(-1);
  if (last === undefined) return "running";
  const state = (last.data as { state?: unknown }).state;
  if (state === "waiting" || state === "paused" || state === "done") return state;
  return "running";
}

/**
 * The state of the latest invocation of a run, and the invocation itself.
 *
 * The latest start of a run is the one that is going, if any is: an earlier invocation of the
 * same run ended before it, or it would not be the latest.
 */
function latestInvocationOf(journal: JournalReader, run: string): { invocation: string; state: RunState } | undefined {
  const starts = journal.find({ type: RunStarted.name, field: "run", equals: run });
  const last = starts.at(-1);
  if (last === undefined) return undefined;
  if (last.actor.kind !== "handler") return undefined;
  const invocation = String(last.actor.invocation);
  return { invocation, state: stateOfInvocation(journal, invocation) };
}

/**
 * A short digest of a text: what an emit key is made of when the text may hold anything.
 *
 * A key is part of a record id, so it may not hold whitespace or a separator. The digest is
 * short and holds neither.
 */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The request that starts the run again, with the file and the arguments it was started with. */
function requestedOf(
  run: RunId,
  facts: RunFacts,
  file: string,
  hash: string | undefined,
): { run: RunId; file: string; args: unknown; label?: string; hash?: string; contract?: ContractHash; box?: boolean } & RunOrigin {
  return {
    run,
    file,
    args: facts.args,
    ...(facts.label === undefined ? {} : { label: facts.label }),
    ...(hash === undefined ? {} : { hash }),
    ...(facts.contract === undefined ? {} : { contract: facts.contract }),
    ...(facts.box === true ? { box: true } : {}),
    ...originOf(facts),
  };
}

/** The origin a record or the facts of a run carry, the fields that are there. */
function originOf(from: RunOrigin): RunOrigin {
  return {
    ...(from.workflow === undefined ? {} : { workflow: from.workflow }),
    ...(from.version === undefined ? {} : { version: from.version }),
    ...(from.installation === undefined ? {} : { installation: from.installation }),
    ...(from.directory === undefined ? {} : { directory: from.directory }),
    ...(from.parent === undefined ? {} : { parent: from.parent }),
    ...(from.concurrency === undefined ? {} : { concurrency: from.concurrency }),
    ...(from.limits === undefined ? {} : { limits: from.limits }),
  };
}

/**
 * What the script as it is now means for the calls the run recorded.
 *
 * The script is read by running it in a disposable process with nothing reaching the outside, so
 * the calls it makes are known before any of them runs.
 */
async function revisionOf(
  journal: JournalReader,
  artifacts: ArtifactStore,
  facts: RunFacts,
  actionNameOf: (harness: string | undefined) => string,
  box: ScriptBox | undefined,
  file: string = facts.file,
  run: string = "unknown",
  from?: string,
): Promise<RevisionReport & { unresolved?: string }> {
  const recorded = recordedCalls(journal, artifacts, facts.invocations);
  const plan = await planCalls(file, facts.args, recorded, actionNameOf, run, box, from);
  return { ...plan.report, ...(plan.error === undefined ? {} : { unresolved: plan.error }) };
}

/** What a step intent holds that a revision compares. */
const RecordedIntent = z.object({
  key: z.string(),
  action: z.string(),
  input: JsonValueSchema.optional(),
  recovery: z.enum(["repeat", "repeat-with-key", "do-not-repeat"]).optional(),
  invocation: z.string(),
});

/** What a step outcome holds that a revision reads: a value kept as an artifact is read back first. */
const RecordedOutcome = z.object({
  key: z.string(),
  outcome: z.object({ status: z.string(), value: JsonValueSchema.optional() }),
});

/** The calls the given invocations made, by key: the latest call under a key, finished if any attempt answered. */
function recordedCalls(journal: JournalReader, artifacts: ArtifactStore, invocations: string[]): Map<string, RecordedCall> {
  const calls = new Map<string, RecordedCall>();
  const wanted = new Set(invocations);
  const sources = (type: string): StoredRecord[] =>
    journal.find({ type: type as never }).filter((row) => wanted.has(String((row.data as { invocation?: unknown }).invocation)));
  for (const row of sources("niwa.step.intent")) {
    const data = RecordedIntent.parse(row.data);
    calls.set(data.key, {
      key: data.key,
      action: data.action,
      input: data.input ?? null,
      finished: false,
      ...(data.recovery === undefined ? {} : { recovery: data.recovery }),
      invocation: data.invocation,
    });
  }
  for (const row of sources("niwa.step.outcome")) {
    const stored = row.data as { outcome: unknown };
    const data = RecordedOutcome.parse({ ...stored, outcome: storedOutcome(stored.outcome, artifacts) });
    const call = calls.get(data.key);
    if (call !== undefined && data.outcome.status === "completed") {
      call.finished = true;
      call.outcome = data.outcome.value;
    }
  }
  return calls;
}

/**
 * The calls the edited script makes, read by running it in a disposable process with nothing
 * reaching the outside. Each call of an action is decided as a run decides it (see revise.ts): one
 * that is taken gets its recorded answer, any other gets null, and what comes after it runs too.
 */
async function planCalls(
  file: string,
  args: unknown,
  recorded: Map<string, RecordedCall>,
  actionNameOf: (harness: string | undefined) => string,
  run: string,
  box: ScriptBox | undefined,
  from: string | undefined,
): Promise<{ report: RevisionReport; error?: string }> {
  const report: RevisionReport = { reused: [], rerun: [] };
  const fresh = new Set<string>();
  let orders = 0;
  const ended = await runScript(
    {
      fresh: (key) => fresh.has(key),
      call: async ({ key, request, phase, after }) => {
        // Only the calls of actions are read: the other requests carry moments the script cannot
        // know before it runs, and they answer as if nothing had come.
        switch (request.op) {
          case "agent":
          case "call": {
            const call: CurrentCall =
              request.op === "agent"
                ? { key, action: actionNameOf(request.input.harness), input: jsonOf(request.input), agent: request.input.prompt !== undefined }
                : { key, action: request.action, input: request.input ?? null };
            const decided = decide(recorded.get(key), call, {
              after: after === true,
              recompute: from !== undefined && (keyUnder(key, from) || phase === from),
            });
            if (decided.taken) {
              report.reused.push({ key, action: call.action, input: call.input, outcome: decided.outcome });
              return decided.outcome;
            }
            report.rerun.push({ key, action: call.action, input: call.input, reason: decided.reason });
            fresh.add(key);
            return null;
          }
          case "wait":
            return { timedOut: true };
          case "ask":
            return neutralValue(request.question);
          case "read-state":
            return {};
          case "read-records":
            return [];
          case "sleep":
          case "emit":
            return null;
          case "now":
          case "random":
            return 0;
          case "scope-open":
            return { known: [] };
          case "scope-settled":
            return { order: (orders += 1) - 1 };
          case "scope-cancel":
          case "scope-close":
            return null;
          case "scope-snapshot":
            return request.keys;
          case "scope-deadline":
            // The reading runs with no clock: a deadline never comes.
            return new Promise(() => undefined);
        }
      },
      phase: () => undefined,
      left: () => undefined,
      log: () => undefined,
    },
    file,
    args,
    `plan:${run}`,
    box,
  );
  return ended.ok ? { report } : { report, error: ended.error ?? "the script failed" };
}

export {
  Builtin,
  BuiltinPromoted,
  BuiltinsWanted,
  InstallationId,
  RunFinished,
  RunId,
  RunLog,
  RunPaused,
  RunPauseRequested,
  RunHoldRequested,
  RunContinued,
  PhaseEntered,
  PhaseLeft,
  StepPhase,
  RunRequested,
  RunStarted,
  Subscription,
  SubscriptionInstalled,
  SubscriptionUninstalled,
  WORKFLOW_TYPES,
  WorkflowId,
  WorkflowRechecked,
  WorkflowRegistered,
  WorkflowVersion,
} from "./records.ts";
export { installationsOf, profileOf, standing, standingAt } from "./subscriptions.ts";
export type { Installation } from "./subscriptions.ts";
export { versionOf, workflowsOf } from "./registry.ts";
export { InFlight, RunHold, RunStatus } from "./status.ts";
export type { RevisionReport } from "./revise.ts";

export { durationMs } from "./language.ts";
export type { ActionGroup, CallOptions, Duration, ScriptApi, TimedOut } from "@niwa-labs/script";
export { sessionAgent } from "./agent.ts";
export type { HarnessLaunch } from "./agent.ts";
export {
  workflowBuiltinPromote,
  workflowCancel,
  workflowStop,
  workflowCheck,
  workflowContinue,
  workflowPause,
  workflowGet,
  workflowGuide,
  workflowInspect,
  workflowInstall,
  workflowInstallationGet,
  workflowInstallationList,
  workflowList,
  workflowRegister,
  workflowResume,
  workflowRevise,
  workflowRuns,
  workflowStart,
  workflowUninstall,
  workflowWait,
} from "./actions.ts";
export { WorkflowInspection, WorkflowStep } from "./inspect.ts";
export { Measures, StatsFold, StatsInput, StatsOutput, VersionStats, workflowStats } from "./stats.ts";
export type { CheckError, CheckReport } from "./check.ts";
