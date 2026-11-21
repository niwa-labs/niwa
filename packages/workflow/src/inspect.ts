/** The observed timeline of a workflow run, projected from its journal. */

import { CORE_TYPES, recordId } from "@niwa-labs/core";
import type { JournalReader, RecordTypeName, Seq, StoredRecord } from "@niwa-labs/core";
import { requestAsk } from "@niwa-labs/requests/records";
import { NiwaSessionIdSchema, SessionStarted } from "@niwa-labs/sessions/records";
import { z } from "zod";

import { InstallationId, RunFinished, RunId, RunRequested, RunStarted, StepPhase, WorkflowId, WorkflowVersion } from "./records.ts";
import { PhaseProgress, RunStatus, statusOf } from "./status.ts";

const ReceivedAt = z.iso.datetime();

export const WorkflowStep = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  action: z.string(),
  branch: z.string().optional(),
  prompt: z.string().optional(),
  startedAt: ReceivedAt,
  endedAt: ReceivedAt.optional(),
  status: z.enum(["running", "paused", "completed", "failed", "unknown", "skipped", "cancelled"]),
  session: NiwaSessionIdSchema.optional(),
  /** The declared phase the step belongs to, when the script named one. */
  phase: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowInspection = z.object({
  run: RunId,
  status: RunStatus,
  origin: z.object({
    file: z.string(),
    label: z.string().optional(),
    workflow: WorkflowId.optional(),
    version: WorkflowVersion.optional(),
    installation: InstallationId.optional(),
    requestedAt: ReceivedAt,
    startedAt: ReceivedAt.optional(),
    finishedAt: ReceivedAt.optional(),
  }),
  /** The phases the script declares, in order, each done, current or ahead, with the steps that named it. Empty when it declares none. */
  phases: z.array(PhaseProgress.extend({ steps: z.array(WorkflowStep) })),
  /** The steps that named no phase. */
  steps: z.array(WorkflowStep),
});
export type WorkflowInspection = z.infer<typeof WorkflowInspection>;

const Intent = z.object({ key: z.string(), action: z.string(), operationId: z.string(), input: z.unknown().optional() });
const Outcome = z.object({ outcome: z.object({ status: z.enum(["completed", "failed", "denied", "unknown"]) }) });
const Resolution = z.object({ key: z.string(), choice: z.enum(["retry", "skip", "cancel"]), attempt: z.number().int() });
const State = z.object({ state: z.string(), reason: z.string().optional(), key: z.string().optional() });
const Prompt = z.object({ prompt: z.string() });
const Question = z.object({ input: z.object({ title: z.string() }) });
const AskEnd = z.object({ outcome: z.object({ status: z.literal("completed"), value: z.object({ ended: z.enum(["cancelled", "expired"]) }) }) });

const at = (row: StoredRecord): string => new Date(row.at).toISOString();
const scriptKey = /^((?:[ps]\d+\.\d+\.)*)call-\d+$/;
// Nested actions and waits use the parent attempt's key as their namespace.
const nestedKey = /^(.+)\.(?:step|wait)-\d+$/;

/** An action's emissions are keyed by its operation, and have the same invocation as the intent. */
function sessionOf(journal: JournalReader, invocation: string, intent: StoredRecord, operation: string): WorkflowStep["session"] {
  for (let ordinal = 1; ; ordinal++) {
    const row = journal.get(recordId(`${operation}/emit/${ordinal}`));
    if (row === undefined) return undefined;
    if (row.type === SessionStarted.name && row.seq > intent.seq && row.actor.kind === "handler" && row.actor.invocation === invocation) {
      return SessionStarted.schema.parse(row.data).id;
    }
  }
}

export function inspectRun(journal: JournalReader, run: RunId): WorkflowInspection | undefined {
  const forRun = (type: RecordTypeName) => journal.find({ type, field: "run", equals: run });
  const requested = forRun(RunRequested.name).at(-1);
  if (requested === undefined) return undefined;
  const starts = forRun(RunStarted.name);
  const started = starts.findLast((row) => row.seq > requested.seq);
  const finished = forRun(RunFinished.name).findLast((row) => row.seq > requested.seq);
  const status = statusOf(journal, run);
  const { file, label, workflow, version, installation } = RunRequested.schema.parse(requested.data);
  // The phase of each step, by its invocation and its key.
  const stepPhases = new Map<string, string>();
  for (const row of forRun(StepPhase.name)) {
    if (row.actor.kind !== "handler") continue;
    const { key, phase } = StepPhase.schema.parse(row.data);
    stepPhases.set(`${row.actor.invocation} ${key}`, phase);
  }
  const phases = (status.phases ?? []).map((phase) => ({ ...phase, steps: [] as WorkflowStep[] }));
  const steps: WorkflowStep[] = [];
  const cancellation = finished !== undefined && status.outcome?.status === "cancelled" ? finished : undefined;
  let ended = finished;
  for (const start of starts) {
    if (start.actor.kind !== "handler") continue;
    const invocation = start.actor.invocation;
    const projected = invocationSteps(journal, invocation, start.seq > requested.seq ? cancellation : undefined);
    if (start === started && status.outcome?.status === "cancelled") ended ??= projected.cancelled;
    for (const { step } of projected.steps) {
      const phase = stepPhases.get(`${invocation} ${step.key}`);
      if (phase !== undefined) step.phase = phase;
      (phases.find((one) => one.title === phase)?.steps ?? steps).push(step);
    }
  }
  return {
    run,
    status,
    origin: { file, label, workflow, version, installation, requestedAt: at(requested), startedAt: started && at(started), finishedAt: ended && at(ended) },
    phases,
    steps,
  };
}

function invocationSteps(
  journal: JournalReader,
  invocation: string,
  cancelledByRun: StoredRecord | undefined,
): { steps: Array<{ row: StoredRecord; step: WorkflowStep }>; cancelled?: StoredRecord } {
  const rows = (type: RecordTypeName) => journal.find({ type, field: "invocation", equals: invocation });
  const stateRow = rows(CORE_TYPES.invocationState).at(-1);
  const state = stateRow === undefined ? undefined : State.parse(stateRow.data);
  const cancelled = cancelledByRun ?? (state?.state === "done" && state.reason === "cancelled" ? stateRow : undefined);
  const resolutions = new Map(rows(CORE_TYPES.invocationResolved).map((row) => {
    const { key, choice, attempt } = Resolution.parse(row.data);
    const operation: string = `${invocation}/${key}${attempt > 0 ? `#${attempt + 1}` : ""}`;
    return [operation, { row, choice }] as const;
  }));
  const outcomes = new Map(rows(CORE_TYPES.stepOutcome).map((row) => [String(row.id), row]));
  const intents = rows(CORE_TYPES.stepIntent).map((row) => ({ row, data: Intent.parse(row.data) }));
  // Script calls with explicit labels can contain dots. A preceding authorize intent proves a
  // direct script call even when its label looks like a key used by an action's nested work.
  const authorized = new Set(intents.filter(({ data }) => data.action === "workflow.authorize").map(({ data }) => data.key));
  const owners = new Map<string, { step: WorkflowStep; outcomeSeq?: Seq }>();
  const steps: Array<{ row: StoredRecord; step: WorkflowStep }> = [];
  for (const { row, data } of intents) {
    const { action, input, key, operationId } = data;
    const nested = nestedKey.exec(key)?.[1];
    const owner = nested !== undefined && !authorized.has(`${key}~auth`) ? owners.get(nested) : undefined;
    const branch = scriptKey.exec(key)?.[1]?.slice(0, -1);
    if (owner !== undefined && (owner.outcomeSeq === undefined || row.seq < owner.outcomeSeq)) {
      if (action === "session.start" && owner.step.action.startsWith("session.start.")) {
        owner.step.session ??= sessionOf(journal, invocation, row, operationId);
      }
      continue;
    }
    if (branch === undefined && (!key.startsWith("label:") || key.includes("~"))) continue;
    const resolution = resolutions.get(operationId);
    const outcome = outcomes.get(row.id.replace(/\/intent$/, "/outcome"));
    const askEnd = action === requestAsk.name ? outcomes.get(`${invocation}/step/${key}~ended/outcome`) : undefined;
    const askStatus = askEnd !== undefined && askEnd.seq > row.seq ? AskEnd.safeParse(askEnd.data).data?.outcome.value.ended : undefined;
    const settledAt = outcome ?? (askStatus === undefined ? undefined : askEnd);
    const settled = outcome === undefined
      ? askStatus === "expired" ? "failed" : askStatus
      : Outcome.parse(outcome.data).outcome.status;
    const namespace = operationId.slice(invocation.length + 1).replace(/#(\d+)$/, ".$1");
    const pauseKey = state?.state === "paused" ? state.key : undefined;
    const nestedPause = pauseKey !== undefined && nestedKey.test(pauseKey) && pauseKey.startsWith(`${namespace}.`) && !authorized.has(`${pauseKey}~auth`);
    const cancelledDuringCall = cancelled !== undefined && row.seq < cancelled.seq && (settledAt === undefined || cancelled.seq < settledAt.seq);
    const end = resolution?.choice === "skip" ? resolution.row : cancelledDuringCall ? cancelled : settledAt;
    const prompt = action === requestAsk.name ? Question.safeParse(input).data?.input.title : Prompt.safeParse(input).data?.prompt;
    const step: WorkflowStep = {
      id: row.id,
      key,
      label: key.startsWith("label:") ? key.slice("label:".length) : action,
      action,
      branch: branch || undefined,
      prompt,
      startedAt: at(row),
      endedAt: end && at(end),
      status: resolution?.choice === "skip" ? "skipped"
        : cancelledDuringCall ? "cancelled"
        : settled === "denied" ? "failed"
        : settled ?? (pauseKey === key || nestedPause ? "paused" : state?.state === "done" ? "unknown" : "running"),
      session: sessionOf(journal, invocation, row, operationId),
    };
    steps.push({ row, step });
    owners.set(namespace, { step, outcomeSeq: outcome?.seq });
  }
  return { steps, cancelled };
}
