/**
 * The records of the messages module: a message sent, and a message received, and the helpers that
 * read them: the ids of messages and the messages the journal holds.
 *
 * Both records carry the whole envelope. The envelope is the message; the record says that it
 * happened, and who did it. The journal keeps the truth, so nothing about a message lives
 * anywhere else.
 */

import { z } from "zod";

import { EntityDescription, IdIndex, record, recordId, seq } from "@niwa-labs/core";
import type { ActionContext, IssuedId, JournalReader, RecordId, RecordType } from "@niwa-labs/core";
import { trigger } from "@niwa-labs/plugin";
import type { Trigger } from "@niwa-labs/plugin";
import { DeliveryReceiptSchema } from "@niwa-labs/sessions/records";

import { Message } from "./envelope.ts";
import type { Message as MessageType } from "./envelope.ts";
import { resultValue } from "./text.ts";

/**
 * A message was sent.
 *
 * The envelope is inside the record as it was sent, so the record of a sent message is the
 * message itself.
 */
export const MessageSent = record("message.sent", Message, { providerOnly: "messages" });

/**
 * A message was received.
 *
 * The same envelope, on the other side of the delivery.
 */
export const MessageReceived = record("message.received", Message, { providerOnly: "messages" });

/**
 * A message was delivered to a session.
 *
 * The receipt says what became of it: delivered into the running turn, queued after the current
 * turn, or started a new turn. The message is inside the record, so the receipt belongs to the
 * message it is about.
 */
export const MessageDelivered = record(
  "message.delivered",
  z.object({
    /** The message that was delivered. */
    message: Message,
    /** What became of it. */
    receipt: DeliveryReceiptSchema,
  }),
);

/**
 * A trigger over the messages that are sent to a session.
 *
 * It is the type "message.sent" narrowed to the messages a session is to receive: a handler of
 * it is woken by exactly those messages and by no others, so a message to another address
 * costs nothing.
 */
export const MessageToSession: Trigger<MessageType> = trigger(MessageSent, {
  name: "message.sent:session",
  filter: { "to.kind": "session" },
});

/**
 * A trigger over the messages that came in for a session.
 *
 * The same narrowing of "message.received": a message from outside is delivered to a session as
 * a message from inside is.
 */
export const MessageReceivedForSession: Trigger<MessageType> = trigger(MessageReceived, {
  name: "message.received:session",
  filter: { "to.kind": "session" },
});

/*
 * The helpers below are pure over the records above: the ids of messages, and of the modules that
 * issue their ids the same way. An entity is born in the record its creating call writes first.
 */

/** The record an action writes first: the one its entity is born in, and the seed of the entity's id. */
export function birthOf(ctx: ActionContext): RecordId {
  return recordId(`${ctx.operationId}/emit/1`);
}

/**
 * The ids the journal holds, each with the seed it was issued from.
 *
 * Every record of the types that parses carries one id (`idOf`), and its own record id is the seed.
 */
export function issuedIds<T>(
  journal: JournalReader | undefined,
  types: readonly RecordType<T>[],
  idOf: (data: T) => string,
): IssuedId[] {
  if (journal === undefined) return [];
  const byName = new Map(types.map((type) => [type.name, type]));
  const issued: IssuedId[] = [];
  for (const stored of journal.since(seq(0), [...byName.keys()])) {
    const parsed = byName.get(stored.type)?.schema.safeParse(stored.data);
    if (parsed?.success === true) issued.push({ id: idOf(parsed.data), seed: stored.id });
  }
  return issued;
}

/** The ids of messages: a message is born when it is sent or received. */
export function messageIds(journal: () => JournalReader | undefined): IdIndex<"message"> {
  return new IdIndex("message", () => issuedIds(journal(), [MessageSent, MessageReceived], (message) => message.id));
}

/** The messages the journal holds, sent and received, in the order they were written. */
export function messagesOf(journal: JournalReader | undefined): Message[] {
  if (journal === undefined) return [];
  const found: Message[] = [];
  for (const stored of journal.since(seq(0), [MessageSent.name, MessageReceived.name])) {
    const parsed = Message.safeParse(stored.data);
    if (parsed.success) found.push(parsed.data);
  }
  return found;
}

/**
 * A few words about a message, for a list: what kind it is and how its text begins.
 *
 * A message has no author-given description, so it is read off the body: the kind, then the first
 * line of the text, cut to fit.
 */
export function describeMessage(message: Message): EntityDescription {
  const { body } = message;
  const result = body.type === "result" ? resultValue(body.text) : undefined;
  const preview = result === undefined
    ? body.text
    : Array.isArray(result) ? "" : ["summary", "outcome", "description", "text"].map((key) => result[key]).find(
      (value): value is string => typeof value === "string" && value.trim() !== "" && resultValue(value) === undefined,
    ) ?? "";
  const first = preview.split(/[\r\n]/, 1)[0]?.trim() ?? "";
  const line = `${message.body.type}: ${first}`.trim();
  const cut = line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
  return EntityDescription.parse(cut);
}
