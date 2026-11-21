/**
 * The owner confirms a discovered harness.
 *
 * A finding proposes; a proposal is not an instance. The id and the machine are the
 * owner's to give, so the owner is asked: add this harness, and under what id and on what machine?
 * The answer "yes" writes the confirmation and registers the instance; the
 * answer "no" leaves the proposal as it is — a proposal nobody confirmed is not an instance.
 *
 * The question is a form in the common format (`Question`): the schema of the answer is its schema.
 * This module does not import the requests module, so the question is made by its name, as a
 * step of the handler. The requests module must be installed: a question asked by a name nobody
 * serves is a failed step.
 */

import { z } from "zod";

import { FormSchemaSchema, actionName, record, seq, stableJson, toJsonSchema } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName, Answer, Question, Step, Timestamp } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import {
  HarnessBinarySchema,
  HarnessIdSchema,
  HarnessKindSchema,
  HarnessProposalSchema,
  MachineIdSchema,
  admitInstance,
} from "@niwa-labs/harness";
import type {
  Harness,
  HarnessInstanceRegistry,
  HarnessKindRegistry,
  HarnessProposal,
  SideCapabilities,
} from "@niwa-labs/harness";

import { HarnessProposed } from "./discover.ts";

/** The name of the action that asks a question and waits for the answer. */
const REQUEST_ASK: ActionName = actionName("request.ask");

/** The name of the question the owner is asked about a discovered harness. */
export const HARNESS_CONFIRM_QUESTION = "harness.confirm";

/** The fields the owner must give: an instance has an id and a machine. */
export const HARNESS_CONFIRM_FIELDS = ["id", "machine"] as const;

/** The answer of the owner: yes, with the fields the instance needs; or no. */
export const HarnessConfirmAnswerSchema = z.discriminatedUnion("answer", [
  z.object({
    answer: z.literal("yes"),
    id: HarnessIdSchema,
    machine: MachineIdSchema,
  }),
  z.object({ answer: z.literal("no") }),
]);
export type HarnessConfirmAnswer = z.output<typeof HarnessConfirmAnswerSchema>;

/** The installation the owner confirmed: an instance without its sides. */
const ConfirmedInstallationSchema = z.object({
  id: HarnessIdSchema,
  kind: HarnessKindSchema,
  machine: MachineIdSchema,
  binary: HarnessBinarySchema.optional(),
  home: z.string().min(1),
});

type ConfirmedInstallation = z.output<typeof ConfirmedInstallationSchema>;

/** The owner confirmed a discovered harness. */
export const HarnessConfirmed = record("harness.confirmed", ConfirmedInstallationSchema);

/** The fields the owner gives, as a form: the JSON Schema of the answer. */
const CONFIRM_FORM = FormSchemaSchema.parse(toJsonSchema(HarnessConfirmAnswerSchema, "input"));

/** The question about a discovered harness: a form the owner fills to say yes, or says no in. */
function confirmQuestion(proposal: HarnessProposal): Question {
  return {
    kind: "form",
    title: "add this harness?",
    detail: [`kind: ${proposal.kind}`, ...(proposal.binary === undefined ? [] : [`binary: ${proposal.binary}`]), `home: ${proposal.home}`].join("\n"),
    schema: CONFIRM_FORM,
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

/** What the plugin needs to confirm a proposal. */
export interface HarnessConfirmOptions {
  /** Where the confirmed instances are put. */
  readonly registry: HarnessInstanceRegistry;
  /**
   * The sides of each kind, by kind name. The kind says which sides it has; this says what each
   * of them can do. A kind that is not named has no sides.
   */
  readonly sides?: Readonly<Record<string, SideCapabilities>>;
  /**
   * The kinds, when they are known: a confirmed installation may claim no more than its kind
   * declares, so sides that would widen the declaration are refused instead of registered.
   */
  readonly kinds?: HarnessKindRegistry;
}

/** The plugin that asks the owner about a proposal and registers what the owner confirms. */
export function harnessConfirm(options: HarnessConfirmOptions): Plugin {
  const registry = options.registry;
  const sides = options.sides ?? {};
  const instanceOf = (confirmed: ConfirmedInstallation): Harness => {
    const instance = { ...confirmed, sides: sides[String(confirmed.kind)] ?? {} };
    const kind = options.kinds?.get(instance.kind);
    if (kind !== undefined) admitInstance(instance, kind);
    return instance;
  };
  return plugin("harness-confirm", (api) => {
    api.declare(HarnessConfirmed);

    // The registry is memory and the journal is the truth: what the owner confirmed before the
    // host stopped is put back when it serves again.
    api.service(() => {
      for (const written of api.journal?.()?.since(seq(0), [HarnessConfirmed.name]) ?? []) {
        register(registry, instanceOf(ConfirmedInstallationSchema.parse(written.data)));
      }
      return () => {};
    });

    api.on(HarnessProposed, async (data, step, record) => {
      const answer = await askOwner(step, data, record.id);
      // The question ended without an answer: the proposal stays a proposal.
      if (answer === undefined) return;
      // The owner said no: nothing is written and nothing is registered.
      if (answer.answer === "no") return;

      const confirmed = {
        id: answer.id,
        kind: data.kind,
        machine: answer.machine,
        home: data.home,
        ...(data.binary === undefined ? {} : { binary: data.binary }),
      };
      const instance = instanceOf(confirmed);
      // Refused before anything is written: a confirmation the registry cannot take must not
      // reach the journal, where it would be put back at every start.
      checkFree(registry, instance);
      await step.emit(HarnessConfirmed, confirmed);
      register(registry, instance);
    });
  });
}

/**
 * The question for the owner, and the answer when there is one.
 *
 * A request that is cancelled or has expired ends the wait with a typed error of its own. The
 * owner did not answer, so the proposal stays a proposal and nothing is registered.
 */
async function askOwner(
  step: Step,
  proposal: HarnessProposal,
  key: string,
): Promise<HarnessConfirmAnswer | undefined> {
  try {
    const { answer } = await step<RequestAskInput, RequestAskOutput>(
      REQUEST_ASK,
      { to: { kind: "owner" }, question: HARNESS_CONFIRM_QUESTION, input: confirmQuestion(proposal) },
      // The step is named by the proposal: the same proposal is the same question, however many
      // times it is found.
      { key },
    );
    // The requests module checked the value against the schema of the form; it is read here once more for its type.
    return "form" in answer ? HarnessConfirmAnswerSchema.parse(answer.form) : undefined;
  } catch (error) {
    if (reasonOf(error) === undefined) throw error;
    return undefined;
  }
}

/**
 * Put the confirmed instance into the registry.
 *
 * An id is taken once: a confirmation that is made again finds the instance that is already there
 * and changes nothing. A different instance under the same id is refused — the owner's id names
 * one installation, and two of them cannot both be it.
 */
function register(registry: HarnessInstanceRegistry, instance: Harness): void {
  if (checkFree(registry, instance)) registry.register(instance);
}

/** True when the id is free; false when the very same instance is there; throws for another one. */
function checkFree(registry: HarnessInstanceRegistry, instance: Harness): boolean {
  const there = registry.get(instance.id);
  if (there === undefined) return true;
  if (stableJson(there) !== stableJson(instance)) {
    throw new Error(
      `harness instance "${instance.id}" is already registered and is not the one that was confirmed`,
    );
  }
  return false;
}

/** Why the wait ended without an answer: "cancelled" or "expired"; nothing else is ours. */
function reasonOf(error: unknown): "cancelled" | "expired" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "RequestCancelled") return "cancelled";
  if (error.name === "RequestExpired") return "expired";
  return undefined;
}
