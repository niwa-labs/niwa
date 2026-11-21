/**
 * The request actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const Option = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), flavor: z.string() });
export type Option = z.infer<typeof Option>;

const Wording = { title: z.string(), detail: z.string().optional() };
const Pick = { ...Wording, options: z.array(Option), allowOther: z.boolean().optional() };

export const Question = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), ...Pick }),
  z.object({ kind: z.literal("multi"), ...Pick }),
  z.object({ kind: z.literal("confirm"), ...Pick }),
  z.object({ kind: z.literal("text"), ...Wording }),
  z.object({ kind: z.literal("form"), ...Wording, schema: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("permission"), ...Wording, options: z.array(Option), subject: z.record(z.string(), z.unknown()) }),
]);
export type Question = z.infer<typeof Question>;

/** An address, as the page names it: its kind and what it names. */
export const Address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }).loose();
export type Address = z.infer<typeof Address>;

export const OpenRequest = z.object({ id: z.string(), to: Address, question: z.string(), input: Question, from: Address.optional() });
export type OpenRequest = z.infer<typeof OpenRequest>;

export const OpenPaused = z.object({
  kind: z.literal("paused"),
  invocation: z.string(),
  choices: z.array(z.string()),
  key: z.string().optional(),
  reason: z.string().optional(),
});
export type OpenPaused = z.infer<typeof OpenPaused>;

export const openAction = {
  name: "request.open",
  input: z.object({}),
  output: z.object({ requests: z.array(z.union([OpenPaused, OpenRequest])) }),
} as const;

/** What an answer to a request is: the options picked, a free text, or the value of a form. */
export const Answer = z.union([z.object({ ids: z.array(z.string()) }), z.object({ text: z.string() }), z.object({ form: z.unknown() })]);
export type Answer = z.infer<typeof Answer>;

export const answerAction = {
  name: "request.answer",
  input: z.object({ id: z.string(), answer: Answer }),
  output: z.object({ id: z.string(), accepted: z.boolean(), reason: z.enum(["cancelled", "expired"]).optional() }),
} as const;

export const resolveAction = {
  name: "niwa.invocation.resolve",
  input: z.object({ invocation: z.string(), choice: z.string() }),
  output: z.unknown(),
} as const;
