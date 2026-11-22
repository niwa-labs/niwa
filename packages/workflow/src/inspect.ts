/** The observed timeline of a workflow run, projected from its journal. */

import { CORE_TYPES, WAIT_ACTION, recordId, storedOutcome } from "@niwa-labs/core";
import type { ArtifactStore, JournalReader, RecordTypeName, Seq, StoredRecord } from "@niwa-labs/core";
import { requestAsk } from "@niwa-labs/requests/records";
import { NiwaSessionIdSchema, SessionBoxManifest, SessionEnded, SessionMarked, SessionRefInput, SessionStarted, sessionAskAndWait, sessionEnd, sessionSend, sessionTurnWait } from "@niwa-labs/sessions/records";
import { SleepRequested } from "@niwa-labs/timer/records";
import { WAIT_NAME } from "./bridge.ts";
import { nestedKey, readAttempts } from "./attempts.ts";
import { z } from "zod";

import { InstallationId, RunFinished, RunId, RunRequested, RunStarted, StepPhase, StepReused, WorkflowId, WorkflowVersion } from "./records.ts";
import { PhaseProgress, RunStatus, statusOf } from "./status.ts";

const ReceivedAt = z.iso.datetime();

export const WorkflowStep = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  action: z.string(),
  branch: z.string().optional(),
  prompt: z.string().optional(),
  waitEvent: z.string().optional(),
  dueAt: ReceivedAt.optional(),
  /** A predictable timer.fired filter: empty matches the next scheduled timer. */
  timerName: z.string().optional(),
  /** The step belongs to a superseded invocation or attempt. */
  historical: z.boolean().optional(),
  startedAt: ReceivedAt,
  endedAt: ReceivedAt.optional(),
  status: z.enum(["running", "paused", "completed", "failed", "unknown", "skipped", "cancelled"]),
  session: NiwaSessionIdSchema.optional(),
  sequence: z.number().optional(),
  endSequence: z.number().optional(),
  sessionResult: z.enum(["sent", "queued", "handled", "completed", "ended", "no-answer", "invalid-answer", "timed-out", "closed", "already-closed"]).optional(),
  sessionEndRecord: z.string().optional(),
  /** The declared phase the step belongs to, when the script named one. */
  phase: z.string().optional(),
  /** The call has an effect: it was made under a contract other than repeat, so running it again repeats the effect. */
  effect: z.boolean().optional(),
  /** A later start of the run took this step's answer instead of making the call again. */
  reused: z.boolean().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowInspection = z.object({
  run: RunId,
  status: RunStatus,
  observedAt: ReceivedAt.optional(),
  origin: z.object({
    file: z.string(),
    args: z.unknown().optional(),
    label: z.string().optional(),
    workflow: WorkflowId.optional(),
    version: WorkflowVersion.optional(),
    installation: InstallationId.optional(),
    directory: z.string().optional(),
    requestedAt: ReceivedAt,
    sourceSeq: z.number().optional(),
    startedAt: ReceivedAt.optional(),
    finishedAt: ReceivedAt.optional(),
  }),
  sessions: z.array(z.object({
    boxed: z.literal(true).optional(), id: NiwaSessionIdSchema, ref: z.string(),
    parentSession: z.string().optional(), startedAt: ReceivedAt,
    startSequence: z.number().optional(),
    end: z.object({ at: ReceivedAt, sequence: z.number(), record: z.string() }).optional(),
  })),
  /** The phases the script declares, in order, each done, current or ahead, with the steps that named it. Empty when it declares none. */
  phases: z.array(PhaseProgress.extend({ steps: z.array(WorkflowStep) })),
  /** The steps that named no phase. */
  steps: z.array(WorkflowStep),
});
export type WorkflowInspection = z.infer<typeof WorkflowInspection>;

const Outcome = z.object({ outcome: z.object({ status: z.enum(["completed", "failed", "denied", "unknown", "cancelled"]) }) });
const State = z.object({ state: z.string(), reason: z.string().optional(), key: z.string().optional() });
const WaitInput = z.object({ type: z.string(), place: z.string().optional(), filter: z.looseObject({ key: z.string().optional(), timer: z.string().optional() }).optional() });
const Prompt = z.object({
  prompt: z.union([z.string(), z.object({ sections: z.array(z.object({ text: z.string() })) }).transform(({ sections }) => sections.map(({ text }) => text).join("\n\n"))]),
});
const OwnedSession = SessionStarted.schema.and(z.object({ parentSession: z.string().optional() }));
const SessionTarget = z.object({ session: SessionRefInput });
const SESSION_TARGET_ACTIONS = new Set([
  "session.ask", "session.ask-and-wait", "session.end", "session.interrupt", "session.resume", "session.send",
  "session.turn-send", "session.turn-wait",
]);
const SessionOutcome = z.object({ outcome: z.object({ status: z.literal("completed"), value: z.unknown().optional(), artifact: z.unknown().optional() }) });

function sessionResultOf(action: string, row: StoredRecord | undefined, artifacts: ArtifactStore | undefined): WorkflowStep["sessionResult"] {
  if (!row || !["session.send", "session.turn-send", "session.turn-wait", "session.end", "session.ask-and-wait"].includes(action)) return undefined;
  const entry = SessionOutcome.safeParse(row.data).data?.outcome;
  if (!entry) return undefined;
  let value = entry.value;
  if (entry.artifact !== undefined) {
    try {
      const outcome = storedOutcome(entry, artifacts);
      if (outcome.status === "completed") value = outcome.value;
    } catch {
      // The completed call alone cannot prove the result of the session operation.
      return undefined;
    }
  }
  if (action === sessionTurnWait.name) return sessionTurnWait.output.safeParse(value).data?.status;
  if (action === sessionAskAndWait.name) return sessionAskAndWait.output.safeParse(value).data?.result.status;
  if (action === sessionEnd.name) {
    const result = sessionEnd.output.safeParse(value).data;
    return result === undefined ? undefined : result.ended ? "closed" : "already-closed";
  }
  const receipt = sessionSend.output.safeParse(value).data?.receipt;
  return receipt?.status === "queued" || receipt?.status === "handled" ? receipt.status : receipt && "sent";
}
const Question = z.object({ input: z.object({ title: z.string() }) });

const at = (row: StoredRecord): string => new Date(row.at).toISOString();
// The key of a call of the script: the path of its branch (groups, scopes and their branches), then its number or its label.
const scriptKey = /^((?:[^.~]+\.)*?)(call-\d+|label:[^~]+)$/;

/** An action's emissions are keyed by its operation, and have the same invocation as the intent. */
function sessionEmission(journal: JournalReader, invocation: string, intent: StoredRecord, operation: string, type: RecordTypeName): StoredRecord | undefined {
  for (let ordinal = 1; ; ordinal++) {
    const row = journal.get(recordId(`${operation}/emit/${ordinal}`));
    if (row === undefined) return undefined;
    if (row.type === type && row.seq > intent.seq && row.actor.kind === "handler" && row.actor.invocation === invocation) {
      return row;
    }
  }
}

function startedSession(journal: JournalReader, invocation: string, intent: StoredRecord, operation: string) {
  const row = sessionEmission(journal, invocation, intent, operation, SessionStarted.name);
  return row && SessionStarted.schema.parse(row.data).id;
}

export function inspectRun(journal: JournalReader, run: RunId, artifacts?: ArtifactStore): WorkflowInspection | undefined {
  const forRun = (type: RecordTypeName) => journal.find({ type, field: "run", equals: run });
  const requested = forRun(RunRequested.name).at(-1);
  if (requested === undefined) return undefined;
  const starts = forRun(RunStarted.name);
  const started = starts.findLast((row) => row.seq > requested.seq);
  const finished = forRun(RunFinished.name).findLast((row) => row.seq > requested.seq);
  const status = statusOf(journal, run);
  const { file, args, label, workflow, version, installation, directory } = RunRequested.schema.parse(requested.data);
  // The phase of each step, by its invocation and its key.
  const stepPhases = new Map<string, string>();
  for (const row of forRun(StepPhase.name)) {
    if (row.actor.kind !== "handler") continue;
    const { key, phase } = StepPhase.schema.parse(row.data);
    stepPhases.set(`${row.actor.invocation} ${key}`, phase);
  }
  // The steps a later start took, by the start that made them and their key.
  const reused = new Set(forRun(StepReused.name).map((row) => {
    const { key, from } = StepReused.schema.parse(row.data);
    return `${from} ${key}`;
  }));
  const phases = (status.phases ?? []).map((phase) => ({ ...phase, steps: [] as WorkflowStep[] }));
  const steps: WorkflowStep[] = [];
  const sessionRows = forRun(SessionStarted.name);
  const identities = new Map<string, WorkflowStep["session"]>();
  for (const row of sessionRows) {
    const { id, session } = SessionStarted.schema.parse(row.data);
    // An exact native pair must identify a single Niwa session in this run.
    identities.set(session, identities.has(session) ? undefined : id);
  }
  const cancellation = finished !== undefined && status.outcome?.status === "cancelled" ? finished : undefined;
  let ended = finished;
  let observed: number = finished?.at ?? requested.at;
  for (const start of starts) {
    if (start.actor.kind !== "handler") continue;
    const invocation = start.actor.invocation;
    const projected = invocationSteps(journal, invocation, start === started ? cancellation : undefined, start !== started || status.state === "finished", identities, artifacts);
    observed = Math.max(observed, start.at, projected.observed);
    if (start === started && status.outcome?.status === "cancelled") ended ??= projected.cancelled;
    for (const { step } of projected.steps) {
      const phase = stepPhases.get(`${invocation} ${step.key}`);
      if (phase !== undefined) step.phase = phase;
      if (!step.historical && reused.has(`${invocation} ${step.key}`)) step.reused = true;
      if (start !== started) step.historical = true;
      (phases.find((one) => one.title === phase)?.steps ?? steps).push(step);
    }
  }
  return {
    run,
    status,
    observedAt: new Date(observed).toISOString(),
    origin: { file, args, ...(started && { sourceSeq: started.seq }), label, workflow, version, installation, directory, requestedAt: at(requested), startedAt: started && at(started), finishedAt: ended && at(ended) },
    phases,
    steps,
    sessions: sessionRows.map((row) => {
      const session = OwnedSession.parse(row.data);
      const lastMark = journal.find({ type: SessionMarked.name, field: "session", equals: session.session }).at(-1);
      const mark = lastMark && SessionMarked.schema.parse(lastMark.data).mark;
      const boxed = mark && journal.find({ type: SessionBoxManifest.name, field: "mark", equals: mark }).length > 0;
      const end = identities.get(session.session) === session.id
        ? journal.find({ type: SessionEnded.name, field: "session", equals: session.session, after: row.seq })[0]
        : undefined;
      return {
        ...(boxed && { boxed: true as const }), id: session.id, ref: session.session, parentSession: session.parentSession,
        startedAt: at(row), startSequence: row.seq,
        ...(end && { end: { at: at(end), sequence: end.seq, record: end.id } }),
      };
    }),
  };
}

function invocationSteps(
  journal: JournalReader,
  invocation: string,
  cancelledByRun: StoredRecord | undefined,
  terminal: boolean,
  identities: ReadonlyMap<string, WorkflowStep["session"]>,
  artifacts: ArtifactStore | undefined,
): { steps: Array<{ row: StoredRecord; step: WorkflowStep }>; cancelled?: StoredRecord; observed: number } {
  const rows = (type: RecordTypeName) => journal.find({ type, field: "invocation", equals: invocation });
  const stateRow = rows(CORE_TYPES.invocationState).at(-1);
  const state = stateRow === undefined ? undefined : State.parse(stateRow.data);
  const cancelled = cancelledByRun ?? (state?.state === "done" && state.reason === "cancelled" ? stateRow : undefined);
  const { attempts, outcomes, authorized } = readAttempts(journal, invocation);
  const owners = new Map<string, { step: WorkflowStep; outcomeSeq?: Seq; current: boolean }>();
  const steps: Array<{ row: StoredRecord; step: WorkflowStep }> = [];
  let observed = Math.max(stateRow?.at ?? 0, attempts.at(-1)?.row.at ?? 0);
  for (const attempt of attempts) {
    const { row, data, namespace, parent, outcome, resolution, askEnd, askStatus, replaced, superseded } = attempt;
    // Resolutions can change which attempt is live before another intent is written.
    observed = Math.max(observed, resolution?.row.at ?? 0);
    const { action, input, key, operationId, recovery } = data;
    const owner = parent === undefined ? undefined : owners.get(parent.namespace);
    const parsed = scriptKey.exec(key);
    const branch = parsed?.[1]?.slice(0, -1);
    const labeled = parsed?.[2]?.startsWith("label:") === true ? parsed[2].slice("label:".length) : undefined;
    if (owner !== undefined && (owner.outcomeSeq === undefined || row.seq < owner.outcomeSeq)) {
      const current = owner.current && !replaced;
      if (current && action === "session.start" && owner.step.action.startsWith("session.start.")) {
        owner.step.session = startedSession(journal, invocation, row, operationId) ?? owner.step.session;
      }
      // A hidden call can own more calls. Keep their visible script owner within the same attempt.
      const outcomeSeq = outcome?.seq;
      owners.set(namespace, {
        step: owner.step,
        current,
        outcomeSeq: outcomeSeq !== undefined && (owner.outcomeSeq === undefined || outcomeSeq < owner.outcomeSeq)
          ? outcomeSeq
          : owner.outcomeSeq,
      });
      continue;
    }
    if (parsed === null) continue;
    const settledAt = outcome ?? (askStatus === undefined ? undefined : askEnd);
    const settled = outcome === undefined
      ? askStatus === "expired" ? "failed" : askStatus
      : Outcome.parse(outcome.data).outcome.status;
    const pauseKey = !terminal && !superseded && state?.state === "paused" ? state.key : undefined;
    const nestedPause = pauseKey !== undefined && nestedKey.test(pauseKey) && pauseKey.startsWith(`${namespace}.`) && !authorized.has(`${pauseKey}~auth`);
    const cancelledDuringCall = !superseded && cancelled !== undefined && row.seq < cancelled.seq && (settledAt === undefined || cancelled.seq < settledAt.seq);
    const end = resolution?.choice === "skip" ? resolution.row : cancelledDuringCall ? cancelled : settledAt;
    const prompt = action === requestAsk.name ? Question.safeParse(input).data?.input.title : Prompt.safeParse(input).data?.prompt;
    const wait = action === WAIT_ACTION || action === WAIT_NAME ? WaitInput.safeParse(input).data : undefined;
    const sleep = wait && attempt.open && !terminal && end === undefined
      ? journal.find({ type: SleepRequested.name, field: "key", equals: wait.place ?? wait.filter?.key ?? `${invocation}:${key}` }).at(-1)
      : undefined;
    const target = SESSION_TARGET_ACTIONS.has(action) ? SessionTarget.safeParse(input).data?.session : undefined;
    const exactTarget = typeof target === "object" ? `${target.harness} ${target.native}` : target;
    const session = exactTarget === undefined
      ? startedSession(journal, invocation, row, operationId)
      : NiwaSessionIdSchema.safeParse(exactTarget).data ?? identities.get(exactTarget);
    const sessionEndRecord = action === sessionEnd.name && session !== undefined
      ? sessionEmission(journal, invocation, row, operationId, SessionEnded.name)?.id : undefined;
    const step: WorkflowStep = {
      ...(wait && { waitEvent: wait.type }),
      ...(wait?.type === "timer.fired" && Object.keys(wait.filter ?? {}).every(k => k === "timer") && { timerName: wait.filter?.timer ?? "" }),
      ...(sleep && { dueAt: new Date(SleepRequested.schema.parse(sleep.data).at).toISOString() }),
      ...(superseded && { historical: true }),
      id: row.id,
      key,
      label: labeled ?? action,
      action,
      branch: branch || undefined,
      prompt,
      startedAt: at(row),
      endedAt: end && at(end),
      status: resolution?.choice === "skip" ? "skipped"
        : cancelledDuringCall ? "cancelled"
        : settled === "denied" ? "failed"
        : settled ?? (pauseKey === key || nestedPause ? "paused" : terminal || !attempt.open || state?.state === "done" ? "unknown" : "running"),
      session,
      sequence: row.seq,
      endSequence: end?.seq,
      sessionResult: sessionResultOf(action, outcome, artifacts),
      sessionEndRecord,
      ...(recovery !== undefined && recovery !== "repeat" ? { effect: true } : {}),
    };
    steps.push({ row, step });
    owners.set(namespace, { step, outcomeSeq: outcome?.seq, current: true });
  }
  for (const outcome of outcomes.values()) observed = Math.max(observed, outcome.at);
  return { steps, cancelled, observed };
}
