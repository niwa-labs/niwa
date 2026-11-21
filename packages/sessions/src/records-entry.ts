/**
 * The records entry of the sessions module: what another plugin may import from it. The records,
 * the typed references of the actions, the names of the questions it asks and the pure helpers
 * that read a session's identity or life; no factory and nothing that runs. The actions import the
 * records, so this file sits above both and neither imports it.
 */

export {
  ActivityToolSchema,
  BelongingSource,
  DeliveryReceiptSchema,
  SESSION_SEND,
  SESSION_TYPES,
  SessionActivity,
  SessionAdvisor,
  SessionBelongs,
  SessionBoxManifest,
  SessionCompacted,
  SessionEnded,
  SessionMarked,
  SessionModel,
  SessionStarted,
  SessionStartReserved,
  SessionTurnEnded,
  SessionTurnStarted,
  SessionUnknownVariant,
  TurnEnding,
  sameAddress,
} from "./records.ts";
export type { DeliveryReceipt, SessionSendInput, SessionSendOutput } from "./records.ts";
export {
  BelongingSchema,
  OpenQuestionSchema,
  SessionEntrySchema,
  SessionRefInput,
  UnreadableSchema,
  harnessGet,
  harnessList,
  sessionAsk,
  sessionBelong,
  sessionGet,
  sessionEnd,
  sessionInterrupt,
  sessionList,
  sessionOpenQuestions,
  sessionRead,
  sessionResume,
  sessionRunning,
  sessionSearch,
  sessionSend,
  sessionStart,
} from "./actions.ts";
export { SESSION_QUESTION, SUBMIT_ANSWER_ACTION } from "./ask.ts";
export { NiwaSessionIdSchema, SessionRefSchema, sessionOf, sessionRef } from "./identity.ts";
export type { NiwaSessionId, SessionRef } from "./identity.ts";
export { lifeOf } from "./life.ts";
export type { LifeState } from "./life.ts";
export {
  REVERSE_QUESTION,
  REVERSE_TYPES,
  ReverseIdSchema,
  SessionReverseAnswered,
  SessionReverseAsked,
  SessionReverseCancelled,
} from "./reverse.ts";
export type { ReverseId } from "./reverse.ts";
export {
  HARNESS_DISCOVER_ACTION,
  HarnessDiscoverOutputSchema,
  HarnessProposed,
  harnessDiscover,
  proposalIdOf,
} from "./discover.ts";
export type { HarnessDiscoverOutput } from "./discover.ts";
export {
  HARNESS_CONFIRM_QUESTION,
  HarnessConfirmAnswerSchema,
  HarnessConfirmed,
} from "./confirm.ts";
export type { HarnessConfirmAnswer } from "./confirm.ts";
export { harnessSupports } from "./support.ts";
export {
  Compacted,
  InsertReportOutputSchema,
  NestedSpawned,
  OpenedByHand,
  PERMISSION_QUESTION,
  PermissionAsked,
  SessionEndedByHarness,
} from "./insert-plugin.ts";
export type { InsertReportOutput } from "./insert-plugin.ts";
