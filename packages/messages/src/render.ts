/**
 * Unfolding an envelope into text.
 *
 * An agent is a language model, so what it receives is text: niwa unfolds the envelope into
 * text on its edge. The text says who sent it, who it is for, what kind of message it is and
 * what it carries: everything a reader needs to act on it, and nothing that the envelope does
 * not say.
 */

import { addressText } from "@niwa-labs/core";

import type { Message, MessageBody } from "./envelope.ts";

/**
 * The text of one message, for an agent.
 *
 * The lines are in a fixed order: who sent it, who it is for, what kind of message it is, and
 * what it carries. A reader that knows the shape of the text can tell the parts apart.
 */
export function render(message: Message): string {
  const lines: string[] = [
    `From: ${addressText(message.from)}`,
    `To: ${addressText(message.to)}`,
    `Kind: ${message.body.type}`,
  ];
  lines.push(contentText(message));
  return lines.join("\n");
}

/**
 * The text of what a message carries, without who it is from and to: the task it belongs to, then
 * the body with whatever else the body holds.
 *
 * A reader that is told the sender and the receiver some other way (a turn in an inbox says who it
 * is from) reads this and no more. A message with no task and nothing but a text is that text.
 */
export function contentText(message: Message): string {
  const lines: string[] = [];
  if (message.task !== undefined) lines.push(`Task: ${message.task}`);
  lines.push(bodyText(message.body));
  return lines.join("\n");
}

/**
 * The text of one body: what it carries, plus whatever else it holds.
 *
 * The extra fields are only shown when they are there: an agent reads what was sent, not a
 * field that was left empty.
 */
function bodyText(body: MessageBody): string {
  const lines = [body.text];
  const question = "question" in body ? body.question : undefined;
  if (question !== undefined) lines.push(`Question: ${question}`);
  const reason = "reason" in body ? body.reason : undefined;
  if (reason !== undefined) lines.push(`Reason: ${reason}`);
  const kind = "kind" in body ? body.kind : undefined;
  if (kind !== undefined) lines.push(`Kind of work: ${kind}`);
  const result = "result" in body ? body.result : undefined;
  if (result !== undefined) lines.push(`The result must fit this JSON Schema: ${JSON.stringify(result)}`);
  const data = body.data;
  if (data !== undefined) lines.push(`Data: ${JSON.stringify(data)}`);
  return lines.join("\n");
}
