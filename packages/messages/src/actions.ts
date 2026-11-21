/**
 * The actions of the messages module, as typed references: name, description and the two schemas.
 *
 * A caller imports these to call `message.send` or `message.receive` with the input and the output
 * checked by the type checker, on the host and on a client. The module's factories build the real
 * actions from the same references.
 */

import { z } from "zod";

import { Address, actionRef, getRef, idSchema, listRef } from "@niwa-labs/core";

import { Message, MessageInput } from "./envelope.ts";

/** Send a message to an address. */
export const messageSendRef = actionRef("message.send", {
  description:
    "Send a message to an address. The envelope carries who sent it, who it is for and what it carries.",
  input: MessageInput,
  output: Message,
});

/** Record a message that came in from outside. */
export const messageReceiveRef = actionRef("message.receive", {
  description:
    "Record a message that came in from outside: who sent it, who it is for and what it carries.",
  input: MessageInput,
  output: Message,
});

/** What a message is, as a list says it: the tag of its body. */
export const MessageKind = z.enum(["assignment", "update", "question", "answer", "result", "failure"]);

/** List the messages: id, description, who and what at a glance. */
export const messageListRef = listRef("message.list", {
  kind: "message",
  noun: "message",
  detail: "The description is the kind of the message and how its text begins. Messages sent and received are both here, oldest first.",
  filter: { task: idSchema("task").optional() },
  item: { from: Address, to: Address, kind: MessageKind, task: idSchema("task").optional() },
});

/** Get one message by its id, or any text that names one id. */
export const messageGetRef = getRef("message.get", {
  kind: "message",
  noun: "message",
  entity: Message,
});
