/**
 * The names a workflow script is given: `call` and the generated
 * `niwa.<group>.<action>` wrappers, `agent`, `wait`, `sleep`, `ask`, `emit`, `read`, `now`,
 * `random`, `scope`, `parallel`, `stream`, `race`, `moveOnAfter`, `failAfter`, `pipeline`, `phase`, `log`
 * and `workflow`. The script is
 * `export default workflow({ description, input, output, uses, on }, async (input) => { ... })` and
 * ends by returning its result; the names are globals of the disposable process it runs in (see `child.ts`).
 *
 * This file also holds what the script and the parent say to each other: the requests the child
 * sends (`ScriptRequest`) and the way a duration is written.
 */

import { z } from "zod";

import { JsonSchemaValue, JsonValueSchema, QuestionSchema } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";
import { WorktreeOption } from "@niwa-labs/git/records";
import type { WorktreeOptionGiven } from "@niwa-labs/git/records";
import { SessionModeSchema, withBlocks } from "@niwa-labs/harness";
import type { SessionMode } from "@niwa-labs/harness";
import { BoxAccessSchema } from "@niwa-labs/sandbox";
import type { BoxAccessInput } from "@niwa-labs/sandbox";

import type { Duration } from "@niwa-labs/script";

/**
 * The prefix of a line of the protocol between the child and the parent.
 *
 * The script and the child share one stdout, and the script may write to it: a line of the
 * protocol is told from an ordinary line by this prefix, so a script that writes a line of its
 * own breaks nothing.
 */
export const PROTOCOL_PREFIX = "@niwa ";

/**
 * What an `agent()` call may ask for. The options of the harness's kind go in the block named after
 * it (`claude: { advisor: false }`); the block of another kind is refused.
 */
export interface AgentOptions {
  /** The harness the session runs in. */
  harness?: string;
  /** The key of the call, so reordering a list does not rerun the work. */
  label?: string;
  /** The actions (names or masks) the session sees besides the one that answers; within the run's grant. */
  visible?: string[];
  /** The model of the session, set once at its start; the instance's own when absent. */
  model?: string;
  /** The effort of the session, set once at its start; a kind that takes none refuses it. */
  effort?: string;
  /** The working mode of the session, set once at its start: ask, auto or full; the instance's own, else auto, when absent. */
  mode?: SessionMode;
  /** The directory the session starts in; the host's own directory when absent. */
  cwd?: string;
  /**
   * Run the session in a new git worktree of the repository (`cwd` by default). When the call ends with the
   * worktree clean and no new commit, it is removed; otherwise the answer carries `worktree`.
   */
  worktree?: WorktreeOptionGiven;
  /** A zod schema for the answer: the call gives the answer parsed, typed as the schema says. */
  schema?: z.ZodType;
  /** How long a turn of the session may go with no progress before it counts as stuck. */
  stuckAfter?: Duration;
  /** What the session's box has besides the host's default (`allow`) or instead of it (`only`). */
  box?: BoxAccessInput;
  /**
   * The options block of the harness's kind, named after the kind (`claude: { advisor: false }`). Which kinds there
   * are is the host's to say: the typing `workflow.check` makes of a host knows each harness's block, and the host
   * refuses a block the harness's kind does not declare.
   */
  [block: string]: unknown;
}

/** The action an agent call goes to by default: `mcode-work` becomes `session.start.mcode-work`. */
export function agentActionName(harness: string | undefined): ActionName {
  const base = harness === undefined || harness === "" ? "session.start" : `session.start.${harness}`;
  return base as ActionName;
}

/** A phase a script declares in `workflow({ phases })`: a title, and a line of what is done in it. */
export const WorkflowPhase = z.strictObject({
  title: z.string().regex(/\S/, "a phase has a title"),
  detail: z.string().min(1).optional(),
});
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

/** The phases of a script, in the order they come: `phase(title)` names one by its title, so no two share one. */
export const WorkflowPhases = z.array(WorkflowPhase).superRefine((phases, ctx) => {
  const seen = new Set<string>();
  for (const [index, phase] of phases.entries()) {
    if (seen.has(phase.title)) ctx.addIssue({ code: "custom", path: [index, "title"], message: `the phase "${phase.title}" is declared twice` });
    seen.add(phase.title);
  }
});
export type WorkflowPhases = z.infer<typeof WorkflowPhases>;

/** The prefix of the record types a script may emit: its own. */
export const SCRIPT_TYPES = "wf.";

const UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A duration in milliseconds.
 *
 * @throws when it is not a non-negative number or a number with a unit.
 */
export function durationMs(value: Duration): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`a duration must be a non-negative number, got ${String(value)}`);
    return value;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(value);
  const unit = match?.[2];
  const amount = match?.[1];
  if (unit === undefined || amount === undefined) {
    throw new TypeError(`a duration is milliseconds or a number with ms, s, m, h or d, got ${JSON.stringify(value)}`);
  }
  return Math.round(Number(amount) * (UNITS[unit] ?? 1));
}

/** How a branch of a group ended. */
export const ScopeOutcome = z.enum(["done", "failed", "cancelled"]);
export type ScopeOutcome = z.infer<typeof ScopeOutcome>;

/** How a group closed: its block returned, threw, or ran out of time. */
export const ScopeClosing = z.enum(["done", "failed", "deadline"]);
export type ScopeClosing = z.infer<typeof ScopeClosing>;

/** The fields of an `agent()` request: every other key of it is an options block. */
export const AgentRequestFields = z.object({
  prompt: z.string(),
  harness: z.string().optional(),
  label: z.string().optional(),
  visible: z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  mode: SessionModeSchema.optional(),
  cwd: z.string().min(1).optional(),
  worktree: WorktreeOption.optional(),
  /** The JSON Schema the answer must pass, made from the zod schema of the script. */
  schema: JsonSchemaValue.optional(),
  /** How long, in milliseconds, a turn may go with no progress before the session counts as stuck. */
  stuckAfter: z.number().int().positive().optional(),
  /** What the session's box has besides the host's default, or instead of it. */
  box: BoxAccessSchema.optional(),
});

/** The names of the fields of an `agent()` request, so the rest of it is known as its blocks. */
export const AGENT_REQUEST_FIELDS: readonly string[] = Object.keys(AgentRequestFields.shape);

/** What the child asks the parent to do: every request has a key, and the key says which one it is. */
export const ScriptRequest = z.discriminatedUnion("op", [
  /** `agent()`: start a session of a harness and ask it. */
  z.object({
    op: z.literal("agent"),
    // Every key that is not a field is the options block of the harness's kind, named after it.
    input: withBlocks(AgentRequestFields),
  }),
  /** `call()` and the generated wrappers: any action, by name. */
  z.object({ op: z.literal("call"), action: z.string().min(1), input: JsonValueSchema.optional(), reason: z.string().min(1).optional() }),
  /** `wait()`: the first record of a type whose data holds the filter, after a position or the wait's start, or the timeout. */
  z.object({
    op: z.literal("wait"),
    type: z.string().min(1),
    /** The version a reference to the type holds: the host refuses one it does not write. */
    version: z.number().int().positive().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    /** The position to look after: what an earlier wait or read answered. */
    from: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().optional(),
  }),
  z.object({ op: z.literal("sleep"), ms: z.number() }),
  z.object({
    op: z.literal("ask"),
    question: QuestionSchema,
    timeoutMs: z.number().optional(),
  }),
  /** `emit()`: a record the script declares in `emits`, by its short name; the host writes it under `wf.<name>.`. */
  z.object({ op: z.literal("emit"), record: z.string().min(1), data: z.unknown() }),
  z.object({ op: z.literal("read-state"), plugin: z.string().min(1) }),
  /** `read.records()`: the query, and the version each type named by reference holds, so the host refuses one it does not write. */
  z.object({ op: z.literal("read-records"), query: z.record(z.string(), z.unknown()), versions: z.record(z.string(), z.number().int().positive()).optional() }),
  z.object({ op: z.literal("now") }),
  z.object({ op: z.literal("random") }),
  /**
   * `scope()` opens a group of branches: its key prefix, what leaving it does, its deadline and
   * whether an outer cancel waits for it. The answer is what the host knows of the group already.
   */
  z.object({
    op: z.literal("scope-open"),
    scope: z.string().min(1),
    onExit: z.enum(["wait", "cancel"]),
    deadlineMs: z.number().nonnegative().optional(),
    onDeadline: z.enum(["skip", "fail"]).optional(),
    shield: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
  /** A branch of a group ended: the host commits its outcome and answers its place among the outcomes of the group. */
  z.object({
    op: z.literal("scope-settled"),
    scope: z.string().min(1),
    key: z.string().min(1),
    outcome: ScopeOutcome,
    error: z.object({ name: z.string(), message: z.string() }).optional(),
  }),
  /** Cancel branches of a group: the steps under the prefixes end as cancelled. */
  z.object({ op: z.literal("scope-cancel"), scope: z.string().min(1), prefixes: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }),
  /** What `pending()` or `ready()` sees, recorded once so a replay sees the same. */
  z.object({ op: z.literal("scope-snapshot"), scope: z.string().min(1), keys: z.array(z.string()) }),
  /** Answer when the clock of the host reaches the deadline of a group, or when the script process is gone. */
  z.object({ op: z.literal("scope-deadline"), scope: z.string().min(1), at: z.number() }),
  /** A group closed: how it ended. */
  z.object({ op: z.literal("scope-close"), scope: z.string().min(1), outcome: ScopeClosing }),
]);

export type ScriptRequest = z.infer<typeof ScriptRequest>;
