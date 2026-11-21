/**
 * The agent action of a harness: what an `agent()` call of a script goes to when it names that
 * harness.
 *
 * It starts a session and asks it for the answer: one call is one session and one answer. The
 * sessions module is reached through the typed references of its actions, the way the tasks module
 * reaches it, so the workflow module names no harness kind and its calls are checked against the
 * schemas the sessions module really serves. The one thing it takes from the sessions module is
 * the name of the action that answers a question: the session of an agent call must see it, or a
 * harness that cannot answer by itself never answers at all.
 */

import type { Action, ActionContext } from "@niwa-labs/core";
import { DESCRIPTION_MAX, DESCRIPTION_MIN, EntityDescription, JsonSchemaValue, action } from "@niwa-labs/core";
import { WorktreeOption, gitWorktreeGet, gitWorktreeRemove } from "@niwa-labs/git/records";
import type { WorktreeOptionGiven } from "@niwa-labs/git/records";
import { SessionModeSchema, blocksOf, withBlocks } from "@niwa-labs/harness";
import type { OptionBlocks } from "@niwa-labs/harness";
import { BoxAccessSchema } from "@niwa-labs/sandbox";
import { SUBMIT_ANSWER_ACTION, harnessGet, sessionAsk, sessionStart } from "@niwa-labs/sessions/records";
import { z } from "zod";

import { agentActionName } from "./language.ts";

/**
 * The niwa actions the session of an agent call sees.
 *
 * The action that answers a question is among them: a harness that cannot answer by itself
 * answers through it, and a session that does not see it can never answer at all.
 */
const VISIBLE_ACTIONS: readonly string[] = [SUBMIT_ANSWER_ACTION];

/** What the adapter of a harness knows of what a session may be started with: the models and the efforts it lists. */
export interface HarnessLaunch {
  readonly models?: readonly string[];
  readonly efforts?: readonly string[];
}

/** A text that is one of the listed, or any non-empty text when the adapter lists none. */
function oneOf(listed: readonly string[] | undefined): z.ZodType<string, string> {
  const [first, ...rest] = listed ?? [];
  return first === undefined ? z.string().min(1) : z.enum([first, ...rest]);
}

/**
 * The fields of an agent call. The model and the effort are the listed ones where the adapter lists them. Which block
 * the harness takes is the sessions module's to say, so it is checked when the call runs (`requireOwnBlock`), and what
 * is in it is checked by the schema of the harness's kind when `session.start` takes it.
 */
const agentFields = (launch: HarnessLaunch) =>
  z.object({
    prompt: z.string(),
    harness: z.string().optional(),
    label: z.string().optional(),
    /** The actions (names or masks) the session sees besides the one that answers. */
    visible: z.array(z.string()).optional(),
    /** The model of the session, for its whole life. */
    model: oneOf(launch.models).optional(),
    /** The effort of the session, for its whole life. */
    effort: oneOf(launch.efforts).optional(),
    /** The working mode of the session, for its whole life. */
    mode: SessionModeSchema.optional(),
    /** The directory the session starts in. */
    cwd: z.string().min(1).optional(),
    /** Run the session in a new git worktree; removed when the call ends with it clean and no new commit. */
    worktree: WorktreeOption.optional(),
    /** The JSON Schema the answer must pass. Absent: the answer is text. */
    schema: JsonSchemaValue.optional(),
    /** How long, in milliseconds, a turn of the session may go with no progress before it counts as stuck. */
    stuckAfter: z.number().int().positive().optional(),
    /** What the session's box has besides the host's default (`allow`) or instead of it (`only`). */
    box: BoxAccessSchema.optional(),
  });

/** Every key of an agent call that is not one of its fields is an options block, an object named after the kind. */
const agentInput = (harness: string, launch: HarnessLaunch) =>
  withBlocks(agentFields(launch), (key) => `the agent call of the harness "${harness}" has no field "${key}"`);

/** The names of the fields of an agent call. */
const AGENT_FIELDS: readonly string[] = Object.keys(agentFields({}).shape);

/**
 * Refuse, before a session is started, a block that is not the one the sessions module binds the harness to
 * (`harness.get`): the kind of a harness is the sessions module's to know.
 */
async function requireOwnBlock(harness: string, given: object, ctx: ActionContext): Promise<void> {
  const blocks = Object.keys(blocksOfCall(harness, given));
  if (blocks.length === 0) return;
  const { block: own } = await ctx.step(harnessGet, { name: harness });
  const foreign = blocks.filter((block) => block !== own);
  if (foreign.length === 0) return;
  throw new Error(
    own === undefined
      ? `the harness "${harness}" takes no options (asked for "${foreign.join('", "')}")`
      : `the harness "${harness}" takes the "${own}" options block only (asked for "${foreign.join('", "')}")`,
  );
}
/** The blocks of an agent call; a key that is neither a field nor a block is refused, naming the harness. */
function blocksOfCall(harness: string, input: object): OptionBlocks {
  try {
    return blocksOf(input, AGENT_FIELDS);
  } catch (error) {
    throw new Error(`the agent call of the harness "${harness}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

type AgentInput = z.output<ReturnType<typeof agentInput>>;
type AgentInputGiven = z.input<ReturnType<typeof agentInput>>;

/**
 * What an agent call answers: `{ answer }` with the text the session gave, or, when the call
 * carries a schema, the value that passed it.
 */
const AgentOutput = z.unknown();

/** The worktree an agent call leaves behind: where the work is, and whether it changed anything. */
export const AgentWorktree = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  /** Uncommitted changes, or commits its base does not have. */
  changed: z.boolean(),
});
export type AgentWorktree = z.infer<typeof AgentWorktree>;

/** Whether a JSON Schema describes an object, so a field can ride along with the answer. */
function isObjectSchema(schema: JsonSchemaValue): boolean {
  return typeof schema === "object" && schema !== null && (schema as { type?: unknown }).type === "object";
}

/** The worktree an agent call asks session.start for: the description is the call's label, else the first line of its prompt. */
function worktreeAsked(option: WorktreeOption, label: string | undefined, prompt: string): WorktreeOptionGiven {
  const asked = option === true ? {} : option;
  if (asked.description !== undefined) return asked;
  const line = (label ?? prompt).split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const text = line.length >= DESCRIPTION_MIN ? line.slice(0, DESCRIPTION_MAX).trim() : "an agent call";
  return { ...asked, description: EntityDescription.parse(text.length >= DESCRIPTION_MIN ? text : "an agent call") };
}

/** The schema the answer of a session must pass when the call names none. */
const ANSWER_SCHEMA: JsonSchemaValue = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

/**
 * The action `session.start.<harness>`: it starts a session of the harness and asks it.
 *
 * The session is started without a prompt: the question carries the work, so the session answers
 * once, and the answer is a value that passed the schema: the schema of the call, else `{ answer }`.
 * An answer that does not pass it is refused by `session.ask` (see there), so none enters the journal.
 * An options block other than the one the sessions module binds the harness to fails the call before a session starts.
 */
export function sessionAgent(harness: string, launch: HarnessLaunch = {}): Action<AgentInput, unknown, AgentInputGiven> {
  return action(String(agentActionName(harness)), {
    description: `Starts a session of the harness "${harness}" and asks it for the answer.`,
    input: agentInput(harness, launch),
    output: AgentOutput,
    // A session is started and asked: a call that was cut off may have done both.
    recovery: "do-not-repeat",
    effect: "write",
    world: "local",
    run: async (input, ctx) => {
      await requireOwnBlock(harness, input, ctx);
      const answerSchema = input.schema ?? ANSWER_SCHEMA;
      if (input.worktree !== undefined && !isObjectSchema(answerSchema)) {
        throw new Error("an agent call with a worktree answers an object, so the worktree can ride along: give it a schema of an object");
      }
      const { session, worktree } = await ctx.step(sessionStart, {
        harness,
        prompt: "",
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.worktree === undefined ? {} : { worktree: worktreeAsked(input.worktree, input.label, input.prompt) }),
        ...(input.stuckAfter === undefined ? {} : { stuckAfter: input.stuckAfter }),
        ...(input.box === undefined ? {} : { box: input.box }),
        ...blocksOfCall(harness, input),
        visible: { actions: [...new Set([...VISIBLE_ACTIONS, ...(input.visible ?? [])])], disabledTools: [] },
      });
      const { value } = await ctx.step(sessionAsk, {
        session,
        prompt: input.prompt,
        schema: answerSchema,
      });
      if (worktree === undefined) return value;
      // The worktree goes when the work left nothing in it; otherwise the answer says where the work is.
      const now = await ctx.step(gitWorktreeGet, { id: worktree.id });
      const changed = now.dirty || now.aheadOfBase > 0;
      if (!changed && now.sessions.every((live) => live === session)) {
        // Its own session is the only one in it, and that session is done with it.
        await ctx.step(gitWorktreeRemove, { id: worktree.id, force: true });
        return value;
      }
      const kept: AgentWorktree = { ...worktree, changed };
      return { ...(value as object), worktree: kept };
    },
  });
}
