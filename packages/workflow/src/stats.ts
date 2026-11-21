/**
 * `workflow.stats`: how the workflows did, folded from the journal.
 *
 * Nothing is written: the fold lives in memory, reads the journal by `seq` and catches up before
 * each answer, so a restart folds it again. Without an id it measures every workflow; with one it
 * measures that workflow version by version, or the two versions `compare` names, from `since` on.
 */

import { CORE_TYPES, IdText, WAIT_ACTION, actionRef, seq } from "@niwa-labs/core";
import type { JournalReader, RecordTypeName, Seq, StoredRecord } from "@niwa-labs/core";
import { requestAsk } from "@niwa-labs/requests/records";
import { SessionModel, SessionReverseAnswered, SessionReverseAsked, SessionReverseCancelled, sessionStart } from "@niwa-labs/sessions/records";
import { z } from "zod";

import { PhaseEntered, RunFinished, RunId, RunOutcome, RunPaused, RunRequested, RunStarted, WorkflowId, WorkflowVersion } from "./records.ts";

/** The share of runs that ended `done` with no human input, or null when no run ended. */
const Rate = z.number().min(0).max(1).nullable();

/** A spread of durations in milliseconds. */
export const Spread = z.object({ n: z.number().int(), p50: z.number(), p90: z.number(), max: z.number() });
export type Spread = z.infer<typeof Spread>;

/** What the runs of a workflow, or of one version of it, came to. */
export const Measures = z.object({
  runs: z.number().int(),
  outcomes: z.object({
    done: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
    paused: z.number().int(),
    running: z.number().int(),
  }),
  /** The runs that ended `done` with no question to a human, no answered pause and no permission asked of the starter. */
  clean: z.number().int(),
  /** `clean` over the runs that ended (done, failed, cancelled). */
  cleanRate: Rate,
  /** From the request of a run to its end, over the runs that ended. Absent when none ended. */
  duration: Spread.optional(),
  /** Where the time of the runs that ended went, summed. `other` is what the rest leaves of the wall time. */
  time: z.object({
    agentMs: z.number(),
    humanMs: z.number(),
    /** Of `humanMs`: the questions of the script (`ask`). */
    askMs: z.number(),
    /** Of `humanMs`: what the sessions asked their starter (permissions, questions). */
    reverseMs: z.number(),
    timerMs: z.number(),
    otherMs: z.number(),
  }),
  /** The steps that failed and paused a run, and the runs that ended `failed`, by the phase the run was in. */
  failures: z.array(z.object({ phase: z.string().nullable(), count: z.number().int() })),
  /** The `agent()` calls, by harness and the model the session ran (null until the harness named it). */
  agentCalls: z.array(
    z.object({ harness: z.string(), model: z.string().nullable(), calls: z.number().int(), failed: z.number().int(), ms: z.number() }),
  ),
});
export type Measures = z.infer<typeof Measures>;

/** What a row of the general view is about: a registered workflow, or a script file run without registration. */
export const StatsSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow"), id: WorkflowId }),
  z.object({ kind: z.literal("script"), file: z.string() }),
]);
export type StatsSubject = z.infer<typeof StatsSubject>;

/** The measures of one version of a workflow, with when its runs were asked for. */
export const VersionStats = z.object({
  version: WorkflowVersion,
  /** Absent for a version `compare` named that has no runs. */
  firstRunAt: z.number().int().optional(),
  lastRunAt: z.number().int().optional(),
  measures: Measures,
});
export type VersionStats = z.infer<typeof VersionStats>;

export const StatsInput = z.object({
  /** One registered workflow, by its id or a text that names it. Absent: every workflow. */
  id: IdText.optional(),
  /** With `id`: only these two versions (a version or a unique start of one), in this order. */
  compare: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  /** Only the runs asked for at or after this moment, in milliseconds since the epoch. */
  since: z.number().int().nonnegative().optional(),
});
export type StatsInput = z.infer<typeof StatsInput>;

export const StatsOutput = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("all"),
    total: Measures,
    workflows: z.array(z.object({ subject: StatsSubject, measures: Measures })),
    caveats: z.array(z.string()),
  }),
  z.object({
    scope: z.literal("workflow"),
    id: WorkflowId,
    total: Measures,
    /** The versions that ran, the earliest first; with `compare`, the two it names. */
    versions: z.array(VersionStats),
    caveats: z.array(z.string()),
  }),
]);
export type StatsOutput = z.infer<typeof StatsOutput>;

export const workflowStats = actionRef("workflow.stats", {
  description:
    "How the workflows did, from the journal: runs, outcomes (done, failed, cancelled, paused, running), durations, the time split between agents, humans (questions, permissions), timers and the rest, failures by phase, agent calls by harness and model, and the clean rate (done with no human input). Without id every workflow; with id one workflow version by version (a version is the hash of its code), or the two versions `compare` names. `since` keeps the runs asked for from then on.",
  input: StatsInput,
  output: StatsOutput,
});

/** What the numbers cannot say exactly. */
const CAVEATS: readonly string[] = [
  "A run revised or resumed under another version counts whole under the version it was last asked for.",
  "Time is the difference of the moments records were written; a pause waiting for a decision counts as other time.",
  "Human time of a session counts inside the agent call that asked it and is taken out of agent time.",
  "Scripts run by file, not registered, have no version: they show in the general view by file only.",
  "No token or cost counts: the harnesses do not record them yet.",
];

/** The steps and records the fold reads. */
const FOLDED: readonly RecordTypeName[] = [
  RunRequested.name,
  RunStarted.name,
  PhaseEntered.name,
  RunPaused.name,
  RunFinished.name,
  CORE_TYPES.invocationState,
  CORE_TYPES.stepIntent,
  CORE_TYPES.stepOutcome,
  SessionModel.name,
  SessionReverseAsked.name,
  SessionReverseAnswered.name,
  SessionReverseCancelled.name,
];

/** How many records one read of the journal takes. */
const CHUNK = 5000;

const StepIntent = z.object({ invocation: z.string(), key: z.string(), action: z.string(), input: z.unknown().optional() });
const StepOutcome = z.object({
  invocation: z.string(),
  key: z.string(),
  outcome: z.object({ status: z.enum(["completed", "denied", "failed", "unknown"]), value: z.unknown().optional() }),
});
const InvocationState = z.object({ invocation: z.string(), state: z.string() });
/** What `session.start` answers: the pair the harness and its id make, `ref`, which the records of the session carry (`session` is the niwa id). */
const StartedSession = z.object({ ref: z.string() });

/** The step key of a call made inside another call: `<outer>.step-<n>`, or `<outer>.<attempt>.step-<n>`. */
const NESTED = /^(.*?)(?:\.\d+)?\.step-\d+$/;

/** What a top-level step of a run spends its time on. */
type StepKind = "agent" | "ask" | "timer" | "other";

function kindOf(action: string): StepKind {
  if (action === sessionStart.name || action.startsWith(`${sessionStart.name}.`)) return "agent";
  if (action === requestAsk.name) return "ask";
  if (action === WAIT_ACTION) return "timer";
  return "other";
}

/** One `agent()` call of a run. */
interface AgentCall {
  harness?: string;
  /** The ref of its session, the pair its records carry. */
  session?: string;
  ms: number;
  failed: boolean;
}

/** A run as the fold knows it. */
interface RunFact {
  run: RunId;
  workflow?: WorkflowId;
  version?: WorkflowVersion;
  file: string;
  requestedAt: number;
  phase?: string;
  outcome?: RunOutcome["status"] | "paused";
  endedAt?: number;
  time: { agent: number; ask: number; reverse: number; timer: number };
  /** Whether a human answered something for it: a question, a pause, a permission. */
  human: boolean;
  failures: Array<string | undefined>;
  calls: Map<string, AgentCall>;
}

/** The fold over the journal: run facts by run, and what links steps and sessions to them. */
export class StatsFold {
  private next: Seq = seq(0);
  private readonly runs = new Map<string, RunFact>();
  private readonly runOfInvocation = new Map<string, RunFact>();
  private readonly intents = new Map<string, { at: number; action: string; input: unknown }>();
  private readonly runOfSession = new Map<string, RunFact>();
  private readonly modelOf = new Map<string, string>();
  private readonly reverseAsked = new Map<string, { at: number; session: string }>();

  /** Reads what the journal holds past the fold. */
  catchUp(journal: JournalReader): void {
    for (;;) {
      const rows = journal.since(this.next, [...FOLDED], CHUNK);
      for (const row of rows) this.absorb(row);
      if (rows.length < CHUNK) return;
    }
  }

  /** Folds one record in. */
  absorb(row: StoredRecord): void {
    this.next = row.seq;
    const at = Number(row.at);
    switch (row.type) {
      case RunRequested.name: {
        const data = RunRequested.schema.parse(row.data);
        const known = this.runs.get(data.run);
        if (known === undefined) {
          this.runs.set(data.run, {
            run: data.run,
            ...(data.workflow === undefined ? {} : { workflow: data.workflow }),
            ...(data.version === undefined ? {} : { version: data.version }),
            file: data.file,
            requestedAt: at,
            time: { agent: 0, ask: 0, reverse: 0, timer: 0 },
            human: false,
            failures: [],
            calls: new Map(),
          });
          return;
        }
        // A resume or a revision asks for the run again: it goes on, under the version it is asked for now.
        if (data.version !== undefined) known.version = data.version;
        known.file = data.file;
        if (known.outcome === "paused") known.human = true;
        delete known.outcome;
        delete known.endedAt;
        return;
      }
      case RunStarted.name: {
        const fact = this.runs.get(RunStarted.schema.parse(row.data).run);
        if (fact !== undefined && row.actor.kind === "handler") this.runOfInvocation.set(String(row.actor.invocation), fact);
        return;
      }
      case PhaseEntered.name: {
        const data = PhaseEntered.schema.parse(row.data);
        const fact = this.runs.get(data.run);
        if (fact !== undefined) fact.phase = data.phase;
        return;
      }
      case RunPaused.name: {
        const fact = this.runs.get(RunPaused.schema.parse(row.data).run);
        if (fact !== undefined && fact.outcome === undefined) fact.outcome = "paused";
        return;
      }
      case RunFinished.name: {
        const data = RunFinished.schema.parse(row.data);
        const fact = this.runs.get(data.run);
        if (fact === undefined) return;
        fact.outcome = data.outcome.status;
        fact.endedAt = at;
        if (data.outcome.status === "failed") fact.failures.push(fact.phase);
        return;
      }
      case CORE_TYPES.invocationState: {
        const data = InvocationState.parse(row.data);
        const fact = this.runOfInvocation.get(data.invocation);
        if (fact === undefined) return;
        if (data.state === "paused") {
          fact.outcome = "paused";
          fact.failures.push(fact.phase);
        } else if (data.state === "running" && fact.outcome === "paused") {
          // A pause answered with retry or skip: a human decided.
          fact.human = true;
          delete fact.outcome;
        } else if (data.state === "done" && fact.outcome === undefined) {
          // The invocation ended without an end of the run: it was cancelled while it paused.
          fact.outcome = "cancelled";
          fact.endedAt = at;
        }
        return;
      }
      case CORE_TYPES.stepIntent: {
        const data = StepIntent.parse(row.data);
        if (this.runOfInvocation.has(data.invocation)) this.intents.set(`${data.invocation} ${data.key}`, { at, action: data.action, input: data.input });
        return;
      }
      case CORE_TYPES.stepOutcome:
        this.stepEnded(StepOutcome.parse(row.data), at);
        return;
      case SessionModel.name: {
        const data = SessionModel.schema.parse(row.data);
        this.modelOf.set(data.session, data.model);
        return;
      }
      case SessionReverseAsked.name: {
        const data = SessionReverseAsked.schema.parse(row.data);
        if (data.route === "starter") this.reverseAsked.set(data.id, { at, session: data.session });
        return;
      }
      case SessionReverseAnswered.name:
      case SessionReverseCancelled.name: {
        const id = row.type === SessionReverseAnswered.name ? SessionReverseAnswered.schema.parse(row.data).id : SessionReverseCancelled.schema.parse(row.data).id;
        const asked = this.reverseAsked.get(id);
        if (asked === undefined) return;
        this.reverseAsked.delete(id);
        const fact = this.runOfSession.get(asked.session);
        if (fact === undefined) return;
        fact.time.reverse += at - asked.at;
        if (row.type === SessionReverseAnswered.name && SessionReverseAnswered.schema.parse(row.data).by === "starter") fact.human = true;
        return;
      }
    }
  }

  private stepEnded(data: z.infer<typeof StepOutcome>, at: number): void {
    const id = `${data.invocation} ${data.key}`;
    const intent = this.intents.get(id);
    const fact = this.runOfInvocation.get(data.invocation);
    if (intent === undefined || fact === undefined) return;
    this.intents.delete(id);
    const ms = at - intent.at;
    const outer = NESTED.exec(data.key)?.[1];
    if (outer !== undefined) {
      // The start of the session inside an agent call names the harness and the session; it ends before the call does.
      if (intent.action !== sessionStart.name || kindOf(this.intents.get(`${data.invocation} ${outer}`)?.action ?? "") !== "agent") return;
      const call = fact.calls.get(outer) ?? { ms: 0, failed: false };
      fact.calls.set(outer, call);
      const input = sessionStart.input.safeParse(intent.input);
      const started = StartedSession.safeParse(data.outcome.value);
      if (input.success) call.harness = input.data.harness;
      if (started.success) {
        call.session = started.data.ref;
        this.runOfSession.set(started.data.ref, fact);
      }
      return;
    }
    const kind = kindOf(intent.action);
    switch (kind) {
      case "agent": {
        const call = fact.calls.get(data.key) ?? { ms: 0, failed: false };
        call.ms = ms;
        call.failed = data.outcome.status !== "completed";
        fact.calls.set(data.key, call);
        fact.time.agent += ms;
        return;
      }
      case "ask":
        fact.time.ask += ms;
        if (data.outcome.status === "completed") fact.human = true;
        return;
      case "timer":
        fact.time.timer += ms;
        return;
      case "other":
        return;
    }
  }

  /** Every run asked for at or after `since`, in the order they were first asked for. */
  private factsSince(since: number | undefined): RunFact[] {
    return [...this.runs.values()].filter((fact) => since === undefined || fact.requestedAt >= since);
  }

  /** The versions a workflow ran, the earliest first. */
  versionsOf(id: WorkflowId): WorkflowVersion[] {
    return [...new Set([...this.runs.values()].flatMap((fact) => (fact.workflow === id && fact.version !== undefined ? [fact.version] : [])))];
  }

  /** The answer to `workflow.stats`, for a workflow already resolved to its id. */
  answer(input: { id?: WorkflowId; compare?: readonly [WorkflowVersion, WorkflowVersion]; since?: number }): StatsOutput {
    const facts = this.factsSince(input.since);
    if (input.id === undefined) {
      const groups = new Map<string, { subject: StatsSubject; facts: RunFact[] }>();
      for (const fact of facts) {
        const subject: StatsSubject = fact.workflow === undefined ? { kind: "script", file: fact.file } : { kind: "workflow", id: fact.workflow };
        const key = subject.kind === "workflow" ? subject.id : `file ${subject.file}`;
        const group = groups.get(key) ?? { subject, facts: [] };
        group.facts.push(fact);
        groups.set(key, group);
      }
      return {
        scope: "all",
        total: this.measure(facts),
        workflows: [...groups.values()].map((group) => ({ subject: group.subject, measures: this.measure(group.facts) })),
        caveats: [...CAVEATS],
      };
    }
    const id = input.id;
    const mine = facts.filter((fact) => fact.workflow === id);
    const versions = input.compare ?? this.versionsOf(id).filter((version) => mine.some((fact) => fact.version === version));
    return {
      scope: "workflow",
      id,
      total: this.measure(mine),
      versions: versions.map((version) => {
        const of = mine.filter((fact) => fact.version === version);
        const first = of[0];
        const last = of.at(-1);
        return {
          version,
          ...(first === undefined ? {} : { firstRunAt: first.requestedAt }),
          ...(last === undefined ? {} : { lastRunAt: last.requestedAt }),
          measures: this.measure(of),
        };
      }),
      caveats: [...CAVEATS],
    };
  }

  private measure(facts: readonly RunFact[]): Measures {
    const outcomes = { done: 0, failed: 0, cancelled: 0, paused: 0, running: 0 };
    const time = { agentMs: 0, humanMs: 0, askMs: 0, reverseMs: 0, timerMs: 0, otherMs: 0 };
    const durations: number[] = [];
    const failures = new Map<string | null, number>();
    const calls = new Map<string, { harness: string; model: string | null; calls: number; failed: number; ms: number }>();
    let clean = 0;
    for (const fact of facts) {
      outcomes[fact.outcome ?? "running"] += 1;
      for (const phase of fact.failures) failures.set(phase ?? null, (failures.get(phase ?? null) ?? 0) + 1);
      for (const call of fact.calls.values()) {
        const harness = call.harness ?? "unknown";
        const model = call.session === undefined ? null : (this.modelOf.get(call.session) ?? null);
        const key = `${harness} ${model ?? ""}`;
        const row = calls.get(key) ?? { harness, model, calls: 0, failed: 0, ms: 0 };
        row.calls += 1;
        row.failed += call.failed ? 1 : 0;
        row.ms += call.ms;
        calls.set(key, row);
      }
      if (fact.endedAt === undefined) continue;
      if (fact.outcome === "done" && !fact.human) clean += 1;
      const wall = fact.endedAt - fact.requestedAt;
      durations.push(wall);
      const agent = Math.max(0, fact.time.agent - fact.time.reverse);
      const human = fact.time.ask + fact.time.reverse;
      time.agentMs += agent;
      time.askMs += fact.time.ask;
      time.reverseMs += fact.time.reverse;
      time.humanMs += human;
      time.timerMs += fact.time.timer;
      time.otherMs += Math.max(0, wall - agent - human - fact.time.timer);
    }
    const ended = outcomes.done + outcomes.failed + outcomes.cancelled;
    return {
      runs: facts.length,
      outcomes,
      clean,
      cleanRate: ended === 0 ? null : clean / ended,
      ...(durations.length === 0 ? {} : { duration: spreadOf(durations) }),
      time,
      failures: [...failures].map(([phase, count]) => ({ phase, count })),
      agentCalls: [...calls.values()],
    };
  }
}

function spreadOf(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0 };
}
