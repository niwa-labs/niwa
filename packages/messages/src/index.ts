/**
 * The messages module: a message is an envelope sent to an address.
 *
 * The module owns two facts: a message was sent, and a message was received. Both records
 * carry the whole envelope, so the envelope is the message and the record says that it
 * happened.
 *
 * The action "message.send" takes the envelope without its id and writes the record
 * "message.sent". The action "message.receive" does the same for a message that came in from
 * outside, and writes "message.received". The two differ only in the direction; the sender is
 * the same in both.
 *
 * **Who sent it.** A message always carries who sent it. When the caller is known, the caller
 * is the sender: the binding says what address that caller speaks as, and a payload that
 * claims to come from somebody else does not change it. When the caller is not known, the
 * sender must be given, and a message without a sender is refused.
 *
 * **Ids.** A message id is `msg-<hex>`, issued here when the message is written; the sender never
 * chooses it. "message.list" shows the messages and "message.get" gives one by its id or any text
 * that names it.
 *
 * One agent writes to another by address.
 */

import type { z } from "zod";

import { UnknownId, action, actionName } from "@niwa-labs/core";
import type { Action, ActionContext, ActionName, Address, Caller, IdIndex } from "@niwa-labs/core";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, MessagesOptions, Plugin } from "@niwa-labs/plugin";
import { SESSION_SEND } from "@niwa-labs/sessions/records";
import type { SessionSendInput, SessionSendOutput } from "@niwa-labs/sessions/records";

import { messageGetRef, messageListRef, messageReceiveRef, messageSendRef } from "./actions.ts";
import { Message, MessageInput } from "./envelope.ts";
import { MessageDelivered, MessageReceived, MessageSent, MessageToSession, birthOf, describeMessage, messageIds, messagesOf } from "./records.ts";
import { render } from "./render.ts";

export {
  Assignment,
  Answer,
  Failure,
  Message,
  MessageBody,
  MessageId,
  MessageInput,
  Question,
  Result,
  ResultSchema,
  Update,
} from "./envelope.ts";
export type { MessageBodyType } from "./envelope.ts";
export {
  MessageDelivered,
  MessageReceived,
  MessageSent,
  MessageToSession,
  birthOf,
  describeMessage,
  issuedIds,
  messageIds,
  messagesOf,
} from "./records.ts";
export { render } from "./render.ts";
export { MessageKind, messageGetRef, messageListRef, messageReceiveRef, messageSendRef } from "./actions.ts";

/** The name of the action that sends a message. */
export const MESSAGE_SEND: ActionName = actionName("message.send");

/** The name of the action that receives a message from outside. */
export const MESSAGE_RECEIVE: ActionName = actionName("message.receive");

/**
 * The sender of a message.
 *
 * A bound caller is the address it is bound to: a payload that claims another sender does not
 * change that, and the returned envelope shows the address really used.
 * A client the binding does not know is refused: it must not pick its own address. The host and
 * handlers are in-process and must say who sends.
 */
function senderOf(caller: Caller, given: Address | undefined, bind: CallerBinding): Address {
  const bound = bind(caller);
  if (bound !== undefined) return bound;
  if (caller.kind === "client") {
    throw new Error("the client is not bound to an address, so it cannot send a message");
  }
  if (given === undefined) {
    throw new Error("the sender of the message is not known: the caller is not bound to an address");
  }
  return given;
}

/**
 * The envelope of a message, from the input of the action and the sender that was resolved.
 *
 * The id is issued here and nowhere else, so a caller cannot say which id its message has. It is
 * seeded by the record the call writes, and the operation of a step is stable across repeats: a
 * call that was cut off and made again gets the same id and writes the same record once, not two
 * messages.
 */
function envelopeOf(input: MessageInput, from: Address, ctx: ActionContext, ids: IdIndex<"message">): Message {
  return {
    id: ids.issue(birthOf(ctx)),
    from,
    to: input.to,
    ...(input.task === undefined ? {} : { task: input.task }),
    body: input.body,
  };
}

/**
 * The action that sends a message: the system sends it out.
 *
 * The input is the envelope without its id. The sender is the caller when the caller is
 * known, and the payload's own sender when it is not.
 */
export function messageSend(
  opts?: MessagesOptions,
  ids: IdIndex<"message"> = messageIds(() => undefined),
): Action<MessageInput, Message, z.input<typeof MessageInput>> {
  const bind = bindingOf(opts);
  return action(messageSendRef, {
    // The write is idempotent by the id of the message, so the call may be made again.
    recovery: "repeat",
    async run(input, ctx): Promise<Message> {
      const from = senderOf(ctx.caller, input.from, bind);
      const envelope = envelopeOf(input, from, ctx, ids);
      await ctx.emit(MessageSent, envelope);
      return envelope;
    },
  });
}

/**
 * The action that receives a message: a message came in from outside.
 *
 * The input is the envelope without its id, exactly as for sending. The sender is the caller
 * when the caller is known — the outsider who sent it — and the payload's own sender when it
 * is not.
 */
export function messageReceive(
  opts?: MessagesOptions,
  ids: IdIndex<"message"> = messageIds(() => undefined),
): Action<MessageInput, Message, z.input<typeof MessageInput>> {
  const bind = bindingOf(opts);
  return action(messageReceiveRef, {
    recovery: "repeat",
    async run(input, ctx): Promise<Message> {
      const from = senderOf(ctx.caller, input.from, bind);
      const envelope = envelopeOf(input, from, ctx, ids);
      await ctx.emit(MessageReceived, envelope);
      return envelope;
    },
  });
}

/**
 * The plugin of the messages module.
 *
 * It declares the three records of the module and registers the two actions. The binding says
 * what address a caller speaks as; the same binding belongs to the actions a handler uses
 * (`messageSend({ bind })`), so that a message sent from a handler carries the same sender as
 * a message sent from outside.
 *
 * A message to a session is delivered as text: the envelope is unfolded into what an agent
 * reads, and the sessions module is told to send it. A message to any other address is left where
 * it is: the addressee of its kind reads it in its own way.
 */
export function messages(opts?: MessagesOptions): Plugin {
  return plugin("messages", (api) => {
    const ids = messageIds(() => api.journal?.());
    api.declare(MessageSent, MessageReceived, MessageDelivered);
    api.action(messageSend(opts, ids));
    api.action(messageReceive(opts, ids));
    api.action(
      action(messageListRef, {
        recovery: "repeat",
        run: async (input) => ({
          items: messagesOf(api.journal?.())
            .filter((message) => input.task === undefined || message.task === input.task)
            .map((message) => ({
              id: message.id,
              description: describeMessage(message),
              from: message.from,
              to: message.to,
              kind: message.body.type,
              ...(message.task === undefined ? {} : { task: message.task }),
            })),
        }),
      }),
    );
    api.action(
      action(messageGetRef, {
        recovery: "repeat",
        run: async (input) => {
          const id = ids.require(input.id);
          const found = messagesOf(api.journal?.()).find((message) => message.id === id);
          if (found === undefined) throw new UnknownId(input.id, "message");
          return found;
        },
      }),
    );

    // A message to a session goes into that session, once, as the text of the envelope.
    api.on(MessageToSession, async (message, step) => {
      if (message.to.kind !== "session") return;
      const sent = await step<SessionSendInput, SessionSendOutput>(SESSION_SEND, {
        session: `${message.to.harness} ${message.to.id}`,
        message: render(message),
      });
      await step.emit(MessageDelivered, { message, receipt: sent.receipt });
    });
  });
}
