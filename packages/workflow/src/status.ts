/**
 * What a run is now, read from the journal: the state a caller waits
 * for and the line a list of runs shows. Nothing here is stored: the facts are the records of the
 * run and of its invocation.
 */

import { CORE_TYPES, runIdOfPrincipal, offeredChoices, seq, shortRun } from "@niwa-labs/core";
import type { JournalReader, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import { RequestAnswered, RequestCancelledRecord, RequestCreated, RequestExpiredRecord, fold } from "@niwa-labs/requests/records";
import type { Address } from "@niwa-labs/core";
import type { RequestId } from "@niwa-labs/requests/records";
import { PendingExternalItemSchema } from "@niwa-labs/plugin";
import { z } from "zod";

import { WorkflowPhase } from "./language.ts";
import { PhaseEntered, PhaseLeft, RunContinued, RunDeadlineExtended, RunFinished, RunHoldRequested, RunOutcome, RunPaused, RunPauseRequested, RunRequested, RunStarted } from "./records.ts";
import { waitingFor } from "./waiting.ts";

/** What a run is: it goes on, it waits for a decision, or it ended. */
export const RunState = z.enum(["running", "paused", "finished"]);
export type RunState = z.infer<typeof RunState>;

/** Where a run is in a declared phase: a branch is in it now, it was passed, or it is still to come. */
export const PhaseState = z.enum(["done", "current", "ahead"]);
export type PhaseState = z.infer<typeof PhaseState>;

/** A declared phase of a run, with where the run is in it: derived from the phases its branches entered, stored nowhere. */
export const PhaseProgress = WorkflowPhase.extend({ state: PhaseState });
export type PhaseProgress = z.infer<typeof PhaseProgress>;

/** A run, as a caller waiting for it sees it. */
/** An operation a run began that has not ended: what a hold waits for before it is `held`. */
export const InFlight = z.object({
  run: z.string(),
  key: z.string(),
  action: z.string(),
  effect: z.enum(["write", "irreversible"]),
  operationId: z.string().optional(),
});
export type InFlight = z.infer<typeof InFlight>;

/** What one plugin has begun outside niwa and not ended while a run is held, as the plugin lists it. */
export const PendingOperations = z.object({
  plugin: z.string(),
  /** What the operations are: "armed merges". */
  label: z.string(),
  items: z.array(PendingExternalItemSchema),
  /** Why the plugin could not be asked, when it could not: its operations are then unknown, not none. */
  unavailable: z.string().optional(),
});
export type PendingOperations = z.infer<typeof PendingOperations>;

/**
 * A hold of a run: `holding` while operations that write are still going, listed in `inFlight`,
 * and `held` once every one of them has ended. New writes are refused in both.
 */
export const RunHold = z.object({
  id: z.string(),
  state: z.enum(["holding", "held"]),
  /** The hold covers the runs this run started, at any depth. */
  tree: z.boolean(),
  inFlight: z.array(InFlight),
  /**
   * What plugins began outside niwa that is still pending, by plugin (`PENDING_EXTERNAL`): the hold
   * stops the run's writes, not these. Absent when no plugin offers any.
   */
  pending: z.array(PendingOperations).optional(),
});
export type RunHold = z.infer<typeof RunHold>;

export const RunStatus = z.object({
  run: z.string(),
  state: RunState,
  /** A pause that holds the run at its next boundary: one asked for, or (`kind: "deadline"`) the run's deadline that came. */
  manualPause: z.object({ id: z.string(), state: z.enum(["requested", "paused"]), kind: z.literal("deadline").optional() }).optional(),
  /** The hold of the run, while one stands. */
  hold: RunHold.optional(),
  /** How the run ended, for a run that finished. */
  outcome: RunOutcome.optional(),
  /** Why the run paused. */
  reason: z.string().optional(),
  /**
   * What may be answered to the pause: `niwa.invocation.resolve` with the invocation and one of these; at a deadline,
   * `extend` (`workflow.extend`) or `cancel` (`workflow.cancel`).
   */
  choices: z.array(z.string()).optional(),
  /** The invocation that is paused, the one to resolve. */
  invocation: z.string().optional(),
  /** The questions the run asked that nobody has answered yet. */
  requests: z.array(z.string()),
  /** The phases the run is in now, in the declared order: one per branch that is going, several while branches of a `parallel` are in different ones. Absent when the script declares none. */
  currentPhases: z.array(z.string()).optional(),
  /** The phases the script declares, in order, each done, current or ahead. Absent when it declares none. */
  phases: z.array(PhaseProgress).optional(),
  /** What a run that is going waits for: `sleep nap until 14:30:00`, `ask …label:ship`, `session claude-haiku … turn 1`, `wait <type>`. */
  waiting: z.string().optional(),
});
export type RunStatus = z.infer<typeof RunStatus>;

/** The state of one invocation, as the core wrote it last. */
const InvocationState = z.object({
  state: z.string(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
  /** The step the invocation paused on; absent for a pause on no step (the handler threw). */
  key: z.string().optional(),
});

const REQUEST_RECORDS: RecordTypeName[] = [
  RequestCreated.name,
  RequestAnswered.name,
  RequestCancelledRecord.name,
  RequestExpiredRecord.name,
];

/** The requests of a run that are still open: the run asked them, and nobody answered, cancelled or let them expire. */
function openRequestsOf(journal: JournalReader, run: string): string[] {
  const states = fold(journal.since(seq(0), REQUEST_RECORDS));
  return [...states.values()]
    .filter((state) => state.status === "open" && state.created.from?.kind === "client" && state.created.from.id === `run:${run}`)
    .map((state) => state.created.id);
}

/**
 * The requests that invocations created (what a run's script asked, and what its sessions were
 * asked) and that are still open, with the address each was put to: the party that may withdraw it.
 */
export function openRequestsOfInvocations(journal: JournalReader, invocations: readonly string[]): Array<{ id: RequestId; to: Address }> {
  const mine = new Set(
    journal
      .find({ type: RequestCreated.name })
      .filter((row) => row.actor.kind === "handler" && invocations.includes(String(row.actor.invocation)))
      .map((row) => RequestCreated.schema.parse(row.data).id),
  );
  return [...fold(journal.since(seq(0), REQUEST_RECORDS)).values()]
    .filter((state) => state.status === "open" && mine.has(state.created.id))
    .map((state) => ({ id: state.created.id, to: state.created.to }));
}

/** Was the run ever asked for? */
export function runExists(journal: JournalReader, run: string): boolean {
  return journal.find({ type: RunRequested.name, field: "run", equals: run }).length > 0;
}

/** Every run, in the order it was first asked for. */
export function runIds(journal: JournalReader): string[] {
  return [...new Set(journal.find({ type: RunRequested.name }).map((row) => RunRequested.schema.parse(row.data).run))];
}

/**
 * The state of a run: finished once its latest start ended (a run cancelled while paused ends with
 * no result of its own), paused while its invocation waits for a decision, running otherwise.
 */
export function manualPausesOf(journal: JournalReader, run: string): StoredRecord[] {
  const after = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1)?.seq ?? seq(0);
  return journal.find({ type: RunPauseRequested.name, field: "run", equals: run, after });
}

/** The hold of a run that stands: asked for since the run's latest start and not released. */
export function activeHold(journal: JournalReader, run: string): StoredRecord | undefined {
  const after = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1)?.seq ?? seq(0);
  const hold = journal.find({ type: RunHoldRequested.name, field: "run", equals: run, after }).at(-1);
  if (hold === undefined) return undefined;
  return journal.find({ type: RunContinued.name, field: "pause", equals: hold.id, after: hold.seq }).length === 0 ? hold : undefined;
}

/**
 * The runs a run started: those whose request names it as their parent (a workflow it calls),
 * and those whose grant it is the parent of (a run it started with workflow.start).
 */
export function childRunsOf(journal: JournalReader, run: string): string[] {
  const named = journal
    .find({ type: RunRequested.name })
    .map((row) => RunRequested.schema.parse(row.data))
    .filter((data) => data.parent?.run === run)
    .map((data) => String(data.run));
  const executions = journal.find({ type: RunRequested.name, field: "run", equals: run })
    .map(row => RunRequested.schema.parse(row.data).execution ?? run);
  const granted = [...new Set([run, ...executions])].flatMap(id =>
    journal.find({ type: CORE_TYPES.accessGranted, field: "parent.principal.id", equals: id }).flatMap(row => {
      const data = row.data as { principal?: { kind?: string; id?: string }; parent?: { principal?: { kind?: string } } };
      return data.principal?.kind === "run" && data.parent?.principal?.kind === "run" && data.principal.id !== undefined ? [runIdOfPrincipal(data.principal.id)] : [];
    }));
  return [...new Set([...named, ...granted])];
}

/** The run that started a run, when a run did: the parent its request names, or the run its grant came from. */
export function parentRunOf(journal: JournalReader, run: string): string | undefined {
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const named = requested === undefined ? undefined : RunRequested.schema.parse(requested.data).parent?.run;
  if (named !== undefined) return named;
  for (const row of journal.find({ type: CORE_TYPES.accessGranted, field: "principal.id", equals: run })) {
    const data = row.data as { principal?: { kind?: string }; parent?: { principal?: { kind?: string; id?: string } } };
    if (data.principal?.kind === "run") return data.parent?.principal?.kind === "run" ? runIdOfPrincipal(data.parent.principal.id!) : undefined;
  }
  return undefined;
}

/** The hold that holds a run: its own, or a hold of the tree of a run above it. */
export function holdOver(journal: JournalReader, run: string): StoredRecord | undefined {
  const own = activeHold(journal, run);
  if (own !== undefined) return own;
  const seen = new Set([run]);
  for (let above = parentRunOf(journal, run); above !== undefined && !seen.has(above); above = parentRunOf(journal, above)) {
    seen.add(above);
    const hold = activeHold(journal, above);
    if (hold !== undefined && RunHoldRequested.schema.parse(hold.data).tree) return hold;
  }
  return undefined;
}

/** The operations that write, begun in the invocations of a run, that have no outcome yet. */
function inFlightOf(journal: JournalReader, run: string): InFlight[] {
  const invocations = new Set(
    journal.find({ type: RunStarted.name, field: "run", equals: run }).flatMap((row) => (row.actor.kind === "handler" ? [String(row.actor.invocation)] : [])),
  );
  const going = new Map<string, InFlight>();
  for (const invocation of invocations) {
    for (const row of journal.find({ type: CORE_TYPES.stepIntent, field: "invocation", equals: invocation })) {
      const data = row.data as { key: string; action: string; effect?: string; operationId?: string };
      if (data.effect !== "write" && data.effect !== "irreversible") continue;
      going.set(`${invocation}\n${data.key}`, {
        run,
        key: data.key,
        action: data.action,
        effect: data.effect,
        ...(data.operationId === undefined ? {} : { operationId: data.operationId }),
      });
    }
    for (const row of journal.find({ type: CORE_TYPES.stepOutcome, field: "invocation", equals: invocation })) {
      going.delete(`${invocation}\n${(row.data as { key: string }).key}`);
    }
  }
  return [...going.values()];
}

/** The hold of a run as its status shows it: what is still going in it and, for a tree, in the runs below it. */
function holdStatusOf(journal: JournalReader, run: string): RunHold | undefined {
  const hold = activeHold(journal, run);
  if (hold === undefined) return undefined;
  const { tree } = RunHoldRequested.schema.parse(hold.data);
  const runs = [run];
  for (let at = 0; tree && at < runs.length; at++) {
    for (const child of childRunsOf(journal, runs[at] ?? "")) if (!runs.includes(child)) runs.push(child);
  }
  const inFlight = runs.flatMap((one) => inFlightOf(journal, one));
  return { id: String(hold.id), state: inFlight.length === 0 ? "held" : "holding", tree, inFlight };
}

export function activeManualPause(journal: JournalReader, run: string): StoredRecord | undefined {
  const pause = manualPausesOf(journal, run).at(-1);
  if (pause === undefined) return;
  return journal.find({ type: RunContinued.name, field: "pause", equals: pause.id, after: pause.seq }).length === 0
    ? pause : undefined;
}

/** A run paused at its deadline: only more time or a cancel answers it. */
function atDeadline(run: string, reached: number, manualPause: NonNullable<RunStatus["manualPause"]>, requests: string[]): RunStatus {
  const reason = `the run reached its deadline at ${new Date(reached).toISOString()}`;
  return { run, state: "paused", reason, choices: ["extend", "cancel"], manualPause, requests };
}

/** The deadline a pause says the run reached, when it is the pause of a deadline. */
export function deadlineReached(pause: StoredRecord): number | undefined {
  const data = RunPauseRequested.schema.parse(pause.data);
  return data.kind === "deadline" ? data.deadline : undefined;
}

/** The moment the deadline of a run comes now: the latest extension, else the one it started with. Absent when it has none. */
export function deadlineOf(journal: JournalReader, run: string): number | undefined {
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  if (requested === undefined) return undefined;
  const extended = journal.find({ type: RunDeadlineExtended.name, field: "run", equals: run, after: requested.seq }).at(-1);
  return extended !== undefined ? RunDeadlineExtended.schema.parse(extended.data).deadline : RunRequested.schema.parse(requested.data).deadline;
}

/** Is `branch` inside `outer`: a branch made (at any depth) by a group `outer` started? `""` is the script itself. */
const inside = (branch: string, outer: string): boolean => branch !== outer && (outer === "" || branch.startsWith(`${outer}.`));

/**
 * The phase plan of a run: the phases declared by the script, all ahead until it starts. Once started, the state of
 * each phase is read from the phases its branches entered (`workflow.phase.entered`) and the branches
 * that ended (`workflow.phase.left`).
 *
 * - A branch (the script itself, or a branch of `parallel`/`pipeline`) is in the phase it entered last. It is going
 *   until it ended, and it waits, not goes, while a branch it made is going: the script is not in its own phase while
 *   its `parallel` runs, its branches are. Only the latest start of the run counts here: an earlier one was stopped
 *   with its branches unfinished.
 * - **current**: the phase of a branch that is going. A run that finished with its result has none.
 * - **done**: a phase some branch entered (in any start of the run), that is not current, and that is declared before
 *   every current one; with no current phase, every phase entered is done.
 * - **ahead**: the rest: not entered yet, or entered and left by a branch while another branch has not reached it
 *   (it is declared after a current phase).
 *
 * Undefined for a run whose script declares none.
 */
export function phasesOf(journal: JournalReader, run: string, status: Pick<RunStatus, "state" | "outcome">): PhaseProgress[] | undefined {
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const after = requested?.seq ?? seq(0);
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run, after }).at(-1);
  const pinned = requested === undefined ? undefined : RunRequested.schema.parse(requested.data).phases;
  if (started === undefined) return pinned?.map((phase) => ({ ...phase, state: "ahead" }));
  const declared = pinned ?? RunStarted.schema.parse(started.data).phases;
  if (declared === undefined) return undefined;
  const indexOf = (title: string): number => declared.findIndex((phase) => phase.title === title);
  const entered = journal.find({ type: PhaseEntered.name, field: "run", equals: run, after });
  const reached = new Set(entered.map((row) => indexOf(PhaseEntered.schema.parse(row.data).phase)).filter((index) => index >= 0));
  const done = status.state === "finished" && status.outcome?.status === "done";
  const current = new Set<number>();
  const invocation = started.actor.kind === "handler" ? started.actor.invocation : undefined;
  if (!done && invocation !== undefined) {
    const own = (row: StoredRecord): boolean => row.actor.kind === "handler" && row.actor.invocation === invocation;
    // The phase each branch of the latest start is in, and the branches that ended.
    const branches = new Map<string, number>();
    for (const row of entered.filter(own)) {
      const data = PhaseEntered.schema.parse(row.data);
      branches.set(data.branch, indexOf(data.phase));
    }
    for (const row of journal.find({ type: PhaseLeft.name, field: "run", equals: run, after: started.seq }).filter(own)) {
      branches.delete(PhaseLeft.schema.parse(row.data).branch);
    }
    for (const [branch, index] of branches) {
      if (index >= 0 && ![...branches.keys()].some((other) => inside(other, branch))) current.add(index);
    }
  }
  const first = Math.min(...current);
  return declared.map((phase, index): PhaseProgress => ({
    ...phase,
    state: current.has(index) ? "current" : reached.has(index) && index < first ? "done" : "ahead",
  }));
}

/** Project the current invocation outcome and any outstanding manual pause. */
export function statusOf(journal: JournalReader, run: string): RunStatus {
  const own = stateOf(journal, run);
  const hold = holdStatusOf(journal, run);
  const status = hold === undefined ? own : { ...own, hold };
  const phases = phasesOf(journal, run, status);
  const plan = phases === undefined ? {} : { currentPhases: phases.filter((phase) => phase.state === "current").map((phase) => phase.title), phases };
  if (status.state !== "running") return { ...status, ...plan };
  const waiting = waitingFor(journal, run, status.requests);
  return {
    ...status,
    ...plan,
    ...(waiting === undefined ? {} : { waiting }),
  };
}

function stateOf(journal: JournalReader, run: string): RunStatus {
  const requests = openRequestsOf(journal, run);
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const after = requested?.seq ?? seq(0);
  const execution = requested === undefined ? run : RunRequested.schema.parse(requested.data).execution ?? run;
  const finished = journal.find({ type: RunFinished.name, field: "run", equals: run, after })
    .findLast(row => (RunFinished.schema.parse(row.data).execution ?? run) === execution);
  if (finished !== undefined) {
    const data = RunFinished.schema.parse(finished.data);
    return { run, state: "finished", outcome: data.outcome, requests };
  }
  const started = journal.find({ type: RunStarted.name, field: "run", equals: run, after }).at(-1);
  const invocation = started?.actor.kind === "handler" ? String(started.actor.invocation) : undefined;
  const last = invocation === undefined ? undefined : journal.find({ type: CORE_TYPES.invocationState, field: "invocation", equals: invocation }).at(-1);
  const state = last === undefined ? undefined : InvocationState.safeParse(last.data);
  if (state?.success !== true || invocation === undefined) {
    const manual = activeManualPause(journal, run);
    if (manual === undefined) return { run, state: "running", requests };
    const reached = deadlineReached(manual);
    const manualPause = { id: String(manual.id), state: "requested" as const, ...(reached === undefined ? {} : { kind: "deadline" as const }) };
    return reached === undefined ? { run, state: "running", requests, manualPause } : atDeadline(run, reached, manualPause, requests);
  }
  const paused = journal.find({ type: RunPaused.name, field: "run", equals: run, after }).at(-1);
  if (state.data.state === "done") {
    // A pause that offers only `cancel` is not one the invocation waits on (an edited script, a
    // call the revision shows): the run waits for the owner to revise or cancel it, and has not ended.
    const data = paused === undefined ? undefined : RunPaused.schema.parse(paused.data);
    if (data?.choices?.join() === "cancel") return { run, state: "paused", reason: data.reason, choices: ["cancel"], requests };
    return { run, state: "finished", outcome: { status: "cancelled" }, requests };
  }
  const manual = activeManualPause(journal, run);
  const reached = manual === undefined ? undefined : deadlineReached(manual);
  const manualPause =
    manual === undefined ? undefined : {
      id: String(manual.id),
      state: state.data.state === "waiting" || state.data.state === "paused" ? "paused" as const : "requested" as const,
      ...(reached === undefined ? {} : { kind: "deadline" as const }),
    };
  if (state.data.state === "waiting" && manualPause !== undefined) {
    if (reached !== undefined) return atDeadline(run, reached, manualPause, requests);
    return { run, state: "paused", reason: "manually paused", manualPause, requests };
  }
  const control = manualPause === undefined ? {} : { manualPause };
  if (state.data.state !== "paused") {
    // The deadline came: the run is paused from that moment, though a call it had begun may still end.
    if (reached !== undefined && manualPause !== undefined) return atDeadline(run, reached, manualPause, requests);
    return { run, state: "running", requests, ...control };
  }
  // The run says why it paused in its own words when the pause is the one it wrote for this pause (the core only
  // knows that the handler threw: `handler error: …`): written after the state before this one, or, for a retry that
  // failed the same way and wrote no new pause (its key is the reason), the very reason the core gives. A pause of
  // the core of its own (a version that is gone, a replay mismatch) keeps the core's reason.
  const before = journal.find({ type: CORE_TYPES.invocationState, field: "invocation", equals: invocation }).at(-2);
  const written = paused === undefined ? undefined : RunPaused.schema.parse(paused.data);
  const own =
    written !== undefined && ((before === undefined || (paused?.seq ?? 0) > before.seq) || state.data.reason === `handler error: ${written.reason}`)
      ? written
      : undefined;
  const reason = own?.reason ?? state.data.reason ?? (paused === undefined ? undefined : RunPaused.schema.parse(paused.data).reason);
  // What the core accepts for this pause, by the rule it holds an answer to (no skip on no step, only cancel on a wait).
  const choices = offeredChoices(journal, invocation, state.data);
  return { run, state: "paused", ...(reason === undefined ? {} : { reason }), choices, invocation, requests, ...control };
}

const cut = (text: string, width: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
};

/** The name of a run for a list: its label, else the file it runs without the directory and the extension. */
export function nameOfRun(journal: JournalReader, run: string): string {
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  if (requested === undefined) return run;
  const data = RunRequested.schema.parse(requested.data);
  return data.label ?? (data.file.split("/").at(-1) ?? data.file).replace(/\.[^.]+$/, "");
}

/** What a list of runs says of the phases a run is in: each title with its place among the declared phases, `Review (1/3), Fix (2/3)`. */
function phaseLine(status: RunStatus): string {
  const phases = status.phases ?? [];
  return phases
    .flatMap((phase, index) => (phase.state === "current" ? [`${phase.title} (${String(index + 1)}/${String(phases.length)})`] : []))
    .join(", ");
}

/** What a list of runs says of how a run ended: the result, the error, or that it was cancelled. */
function outcomeLine(outcome: RunOutcome): string {
  switch (outcome.status) {
    case "done":
      return outcome.result === null ? "" : JSON.stringify(outcome.result);
    case "failed":
      return `failed: ${outcome.error.message}`;
    case "cancelled":
      return "cancelled";
  }
}

/** A few words of what a run is up to or how it ended. */
function aboutRun(status: RunStatus): string {
  return status.state === "paused" ? (status.reason ?? "") : status.outcome !== undefined ? outcomeLine(status.outcome) : phaseLine(status);
}

/** A run of a list as fields: what a page needs to group and show runs without reading each one. */
export const RunEntry = z.object({
  boxed: z.boolean().optional(),
  run: z.string(),
  name: z.string(),
  state: RunState,
  /** The directory the run was started for; absent for a run started with none. */
  directory: z.string().optional(),
  workflow: z.string().optional(),
  phases: z.array(PhaseProgress).optional(),
  waiting: z.string().optional(),
  manualPause: z.boolean().optional(),
  /** When the run was last asked for: its start, or the resume that began it again. */
  requestedAt: z.iso.datetime(),
  /** A few words of what the run is up to or how it ended. */
  about: z.string(),
  /** The questions the run asked that nobody has answered yet. */
  requests: z.number().int().nonnegative(),
});
export type RunEntry = z.infer<typeof RunEntry>;

/** One run of the list, as fields. */
export function runEntry(journal: JournalReader, run: string): RunEntry {
  const status = statusOf(journal, run);
  const requested = journal.find({ type: RunRequested.name, field: "run", equals: run }).at(-1);
  const data = requested === undefined ? undefined : RunRequested.schema.parse(requested.data);
  return {
    run,
    name: nameOfRun(journal, run),
    ...(data && { boxed: data.box === true }),
    ...(data?.workflow && { workflow: data.workflow }),
    ...(status.phases && { phases: status.phases }),
    ...(status.waiting && { waiting: status.waiting }),
    ...(status.manualPause && { manualPause: true }),
    state: status.state,
    ...(data?.directory === undefined ? {} : { directory: data.directory }),
    requestedAt: new Date(requested?.at ?? 0).toISOString(),
    about: cut(aboutRun(status), 120),
    requests: status.requests.length,
  };
}

/**
 * One line of a list of runs: the id, the name, the state, a few words of what it is up to or how
 * it ended, the questions it asked, and for a paused run the command that answers its pause.
 */
export function runLine(journal: JournalReader, run: string): string {
  const status = statusOf(journal, run);
  const short = shortRun(run);
  const about = aboutRun(status);
  const resolve =
    status.state !== "paused"
      ? ""
      : status.manualPause?.kind === "deadline" && status.invocation === undefined
        ? `extend: niwa workflow.extend --run ${short} --by MS | niwa workflow.cancel --run ${short}`
      : status.manualPause !== undefined && status.invocation === undefined
        ? `continue: niwa workflow.continue --run ${short} --pause ${status.manualPause.id}`
        : status.invocation === undefined
          ? `resolve: niwa workflow.revise --run ${short} --file F | niwa workflow.cancel --run ${short}`
          : `resolve: niwa workflow.resume --run ${short} --choice ${(status.choices ?? []).join("|")}`;
  // A run that is going shows its question in what it waits for.
  const open = status.requests.length === 0 || status.state === "running" ? "" : `asks: ${status.requests.join(",")}`;
  return [short, nameOfRun(journal, run), status.state, cut(about, 60), status.waiting ?? "", open, resolve].filter((part) => part !== "").join("  ");
}
