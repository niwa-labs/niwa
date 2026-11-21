/**
 * The niwa side of every insert: the action "insert.report" and the records it writes.
 *
 * An insert runs inside a harness and cannot write to niwa's journal. It calls this action with
 * an insert event, and the host writes the record of that event. The contract is the same for
 * every harness kind: kinds differ in what they learn and how, not in what they say.
 *
 * A tool that asks for permission becomes a question for the owner: the owner is asked, and the
 * answer goes back to the side that asked. The request is made by its name, as a step of the
 * handler: this module does not import the requests module.
 */

import { z } from "zod";

import { OptionIdSchema, action, actionName, record, timestamp } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { ActionContext, ActionName, Answer, Question, Step, Timestamp } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import {
  CompactedEventSchema,
  INSERT_REPORT_ACTION,
  InsertEventSchema,
  NestedSpawnedEventSchema,
  OpenedByHandEventSchema,
  PermissionAskedEventSchema,
  SessionIdSchema,
} from "@niwa-labs/harness";
import type { InsertEvent, PermissionAnswer, PermissionAskedEvent } from "@niwa-labs/harness";

import { permissionId, PermissionIdSchema } from "./insert-routing.ts";
import type { PermissionId, PermissionRouter } from "./insert-routing.ts";

/** The name of the action that asks a question and waits for the answer. */
const REQUEST_ASK: ActionName = actionName("request.ask");

/** A nested session was spawned inside a session. */
export const NestedSpawned = record(
  "insert.nested-spawned",
  NestedSpawnedEventSchema.omit({ kind: true }),
);

/** The harness compacted the context of a session. */
export const Compacted = record("insert.compacted", CompactedEventSchema.omit({ kind: true }));

/** The owner opened a session by hand. */
export const OpenedByHand = record(
  "insert.opened-by-hand",
  OpenedByHandEventSchema.omit({ kind: true }),
);

/** A tool asks for permission. */
export const PermissionAsked = record(
  "insert.permission-asked",
  PermissionAskedEventSchema.omit({ kind: true }),
);

const INSERT_RECORDS = [NestedSpawned, Compacted, OpenedByHand, PermissionAsked] as const;

/** What the action answers: the record that was written. */
export const InsertReportOutputSchema = z.object({
  reported: z.literal(true),
  record: z.string(),
});

export type InsertReportOutput = z.output<typeof InsertReportOutputSchema>;

/** The name of the question the owner is asked about a tool that wants to go on. */
export const PERMISSION_QUESTION = "insert.permission";

/** The ids of the options the owner picks from about a tool that asks for permission. */
const ALLOW = OptionIdSchema.parse("allow");
const DENY = OptionIdSchema.parse("deny");

/** The question about a tool that asks for permission: allow it or deny it. */
function permissionQuestion(event: PermissionAskedEvent): Question {
  return {
    kind: "permission",
    title: `${event.tool} asks for permission`,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    options: [
      { id: ALLOW, label: "Allow", flavor: "allow_once" },
      { id: DENY, label: "Deny", flavor: "reject_once" },
    ],
    subject: { tool: event.tool, kind: "tool", target: event.detail ?? "" },
  };
}

/**
 * What the requests module is asked for.
 *
 * The shape is the contract of the name: this module does not import the requests module,
 * so it declares what it sends, and the requests module checks it.
 */
interface RequestAskInput {
  /** Who may answer. */
  to: { readonly kind: "owner" };
  /** The name of the question. */
  question: string;
  /** What is asked: the question, whole. */
  input: Question;
  /** When the question stops waiting. Without one it waits for ever. */
  deadline?: Timestamp;
}

/** What the requests module answers: the answer, with the id of the request. */
interface RequestAskOutput {
  readonly answer: Answer;
}

/** What the plugin needs to turn a permission question into a question for the owner. */
export interface InsertPluginOptions {
  /**
   * The routing that carries the answer back to the side that asked.
   *
   * Without it the plugin only reports: a question whose answer has nowhere to go is not asked.
   */
  readonly router?: PermissionRouter;
  /**
   * How long the owner may take to answer, in milliseconds.
   *
   * A question nobody answers in time ends as expired, and the side is told "deny" for it.
   * Without this the question waits for ever.
   */
  readonly permissionTimeoutMs?: number;
}

/** The plugin every harness kind with an insert uses. */
export function insertPlugin(options: InsertPluginOptions = {}): Plugin {
  const router = options.router;
  const timeoutMs = options.permissionTimeoutMs;
  return plugin("insert", (api) => {
    for (const type of INSERT_RECORDS) api.declare(type);

    api.action(
      action(INSERT_REPORT_ACTION, {
        description:
          "Report what a harness did inside itself: a nested session was spawned, the context was compacted, the owner opened a session by hand, or a tool asks for permission.",
        input: InsertEventSchema,
        output: InsertReportOutputSchema,
        // The record is written under the id of the operation, so a report that was cut off
        // may be made again: the same record is found instead of a second one.
        recovery: "repeat",
        run: async (event, ctx): Promise<InsertReportOutput> => {
          const written = await write(ctx, event);
          return { reported: true, record: written.id };
        },
      }),
    );

    // Without a routing there is nowhere to carry the answer, so the question stays a record.
    if (router === undefined) return;

    // The question reaches the owner as a request, and the answer comes back through the
    // routing to the side that asked.
    api.on(PermissionAsked, async (data, step) => {
      const side = router.sideOf(data.session);
      // Nobody can carry the answer: the question stays a record, and nobody waits for it.
      if (side === undefined) return;
      const event: PermissionAskedEvent = { kind: "permission-asked", ...data };
      router.ask(side, event);

      const id = permissionId(data.session, data.requestId);
      const answer = await askOwner(step, router, event, id, await deadlineOf(step, timeoutMs));
      if (answer === undefined) return;

      const carried: PermissionAnswer = {
        requestId: data.requestId,
        allow: "ids" in answer && answer.ids[0] === ALLOW,
      };
      await router.answer(data.session, carried);
    });
  });
}

/**
 * The question for the owner, and the answer to the side when the question ends without one.
 *
 * A request that is cancelled or has expired ends the wait with a typed error of its own. The
 * side that asked is still waiting for an answer, so the side is told "deny" and why: nobody
 * waits for ever, and the routing keeps no pending question.
 *
 * This module does not import the requests module, so the two errors are told apart by their
 * name. Anything else is not theirs and is thrown again.
 */
async function askOwner(
  step: Step,
  router: PermissionRouter,
  event: PermissionAskedEvent,
  id: PermissionId,
  deadline: Timestamp | undefined,
): Promise<Answer | undefined> {
  try {
    const asked = await step<RequestAskInput, RequestAskOutput>(
      REQUEST_ASK,
      {
        to: { kind: "owner" },
        question: PERMISSION_QUESTION,
        input: permissionQuestion(event),
        ...(deadline === undefined ? {} : { deadline }),
      },
      // The step is named by the question itself: the same question is the same step, however
      // many times the report of it is made.
      { key: id },
    );
    return asked.answer;
  } catch (error) {
    const reason = reasonOf(error);
    if (reason === undefined) throw error;
    // The question ended without an answer, so the side is told "deny" and why it ended. The
    // routing forgets the question: nobody waits for an answer that will never come.
    await router.answer(event.session, {
      requestId: event.requestId,
      allow: false,
      reason,
    });
    return undefined;
  }
}

/**
 * When the question stops waiting, read as a step so a replay reads the same moment again.
 *
 * Without a timeout there is no deadline, and the question waits for ever.
 */
async function deadlineOf(step: Step, timeoutMs: number | undefined): Promise<Timestamp | undefined> {
  if (timeoutMs === undefined) return undefined;
  const now = await step.now();
  return timestamp(now + timeoutMs);
}

/** Why the wait ended without an answer: "cancelled" or "expired"; nothing else is ours. */
function reasonOf(error: unknown): "cancelled" | "expired" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "RequestCancelled") return "cancelled";
  if (error.name === "RequestExpired") return "expired";
  return undefined;
}

function write(ctx: ActionContext, event: InsertEvent) {
  switch (event.kind) {
    case "nested-spawned":
      return ctx.emit(NestedSpawned, withoutKind(event));
    case "compacted":
      return ctx.emit(Compacted, withoutKind(event));
    case "opened-by-hand":
      return ctx.emit(OpenedByHand, withoutKind(event));
    case "permission-asked":
      return ctx.emit(PermissionAsked, withoutKind(event));
  }
}

function withoutKind<E extends { kind: string }>(event: E): Omit<E, "kind"> {
  const { kind: _kind, ...data } = event;
  return data;
}
