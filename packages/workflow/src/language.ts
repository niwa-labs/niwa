/**
 * The names a workflow script is given: `call` and the generated
 * `niwa.<group>.<action>` wrappers, `agent`, `wait`, `sleep`, `ask`, `emit`, `read`, `now`,
 * `random`, `parallel`, `pipeline`, `phase`, `log` and `workflow`. The script is
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
import { OptionBlocks, SessionModeSchema } from "@niwa-labs/harness";
import type { SessionMode } from "@niwa-labs/harness";

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
export interface AgentOptions extends OptionBlocks {
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

/** What the child asks the parent to do: every request has a key, and the key says which one it is. */
export const ScriptRequest = z.discriminatedUnion("op", [
  /** `agent()`: start a session of a harness and ask it. */
  z.object({
    op: z.literal("agent"),
    input: z.object({
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
      // The options of the harness's kind, in the block named after it.
    }).extend(OptionBlocks.shape),
  }),
  /** `call()` and the generated wrappers: any action, by name. */
  z.object({ op: z.literal("call"), action: z.string().min(1), input: JsonValueSchema.optional(), reason: z.string().min(1).optional() }),
  /** `wait()`: the first record of a type whose data holds the filter, or the timeout. */
  z.object({
    op: z.literal("wait"),
    type: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
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
  z.object({ op: z.literal("read-records"), query: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("now") }),
  z.object({ op: z.literal("random") }),
]);

export type ScriptRequest = z.infer<typeof ScriptRequest>;
