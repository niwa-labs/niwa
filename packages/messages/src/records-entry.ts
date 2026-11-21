/**
 * The records entry of the messages module: what another plugin may import from it. The envelope
 * and its schemas, the records, the typed references of the actions and the pure helpers that read
 * messages from the journal or turn them into text; no factory and nothing that runs. The actions
 * import the records, so this file sits above both and neither imports it.
 */

export {
  Answer,
  Assignment,
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
  MessageReceivedForSession,
  MessageSent,
  MessageToSession,
  birthOf,
  describeMessage,
  issuedIds,
  messageIds,
  messagesOf,
} from "./records.ts";
export { MessageKind, messageGetRef, messageListRef, messageReceiveRef, messageSendRef } from "./actions.ts";
export { render } from "./render.ts";
