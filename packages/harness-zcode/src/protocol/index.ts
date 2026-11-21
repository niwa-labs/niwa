/**
 * The wire of `zcode app-server`, typed. What ZCode sends is
 * read here into a union by method, and a session event into a union by type; the schemas are
 * generated from ZCode's own zod protocol (`generated/zcode-protocol.ts`, `scripts/gen-zcode.ts`).
 *
 * The snapshot is one version of ZCode; the installed one may be newer (the generated header says
 * which is which). What a newer ZCode sends that the snapshot does not know is never a crash and
 * never lost: it is read as an `UnknownVariant` that names the protocol, the discriminator and its
 * value, and keeps the raw message, and the control side shows it in the session's log.
 *
 * Nothing here talks to a process.
 */

import type { z } from "zod";

import { ProtocolNameSchema, VariantNameSchema } from "@niwa-labs/harness";
import type { ProtocolName, VariantName } from "@niwa-labs/harness";

import {
  ANSWER_SCHEMAS,
  NOTIFICATION_SCHEMAS,
  NotificationSessionEventSchema,
  REQUEST_SCHEMAS,
  SESSION_EVENT_TYPES,
  V4_NOTIFICATION_METHODS,
} from "./generated/zcode-protocol.ts";
import * as wire from "./generated/zcode-protocol.ts";

export type { NotificationSessionEvent as SessionEvent } from "./generated/zcode-protocol.ts";

export type NotificationMethod = keyof typeof NOTIFICATION_SCHEMAS;
export type RequestMethod = keyof typeof REQUEST_SCHEMAS;

/** A notification of ZCode: its method, and the params as the snapshot has them. */
export type Notification = {
  [M in NotificationMethod]: { readonly method: M; readonly params: z.output<(typeof NOTIFICATION_SCHEMAS)[M]> };
}[NotificationMethod];

/** A request of ZCode to the client. The params are `undefined` when they do not fit the snapshot. */
export type ServerRequest = {
  [M in RequestMethod]: { readonly method: M; readonly params: z.output<(typeof REQUEST_SCHEMAS)[M]> | undefined };
}[RequestMethod];

/** The answer ZCode takes to a request, as the snapshot has it. */
export type RequestAnswer<M extends RequestMethod> = z.input<(typeof ANSWER_SCHEMAS)[M]>;

/** The name of this wire protocol in a record of an unknown variant. */
export const ZCODE_PROTOCOL: ProtocolName = ProtocolNameSchema.parse("zcode app-server");

/** A message the snapshot does not know, or knows by name but not by shape. */
export interface UnknownVariant {
  readonly protocol: "zcode";
  /** What failed to match: the method of a message, or the type of a session event. */
  readonly discriminator: "method" | "event type";
  readonly value: string;
  readonly why: "not in the snapshot" | "does not fit the snapshot";
  /** The message as it came. */
  readonly raw: unknown;
}

/** What a notification is: one of ZCode's, a message of its v4 side channel, or unknown. */
export type NotificationRead =
  | { readonly kind: "known"; readonly notification: Notification }
  /** `v4/*`: the conversation view of ZCode's own desktop, which a session driver has no use for. */
  | { readonly kind: "side-channel"; readonly method: string }
  | { readonly kind: "unknown"; readonly unknown: UnknownVariant };

/** What a request is. `unknown` says why the log should show it; `request` is set when the method is ZCode's. */
export interface RequestRead {
  readonly request: ServerRequest | undefined;
  readonly unknown: UnknownVariant | undefined;
}

/** How much of a raw message the log keeps. */
const RAW_CHARS = 4000;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

/** The params of a schema that fit it, or `undefined`. */
function fit<M extends string, S extends z.ZodType>(method: M, schema: S, params: unknown): { readonly method: M; readonly params: z.output<S> } | undefined {
  const parsed = schema.safeParse(params);
  return parsed.success ? { method, params: parsed.data } : undefined;
}

const isNotificationMethod = (method: string): method is NotificationMethod => Object.hasOwn(NOTIFICATION_SCHEMAS, method);
const isRequestMethod = (method: string): method is RequestMethod => Object.hasOwn(REQUEST_SCHEMAS, method);
const isV4 = (method: string): boolean => (V4_NOTIFICATION_METHODS as readonly string[]).includes(method);
const isSessionEventType = (type: string): boolean => (SESSION_EVENT_TYPES as readonly string[]).includes(type);

function parseNotification(method: NotificationMethod, params: unknown): Notification | undefined {
  switch (method) {
    case "session/event":
      return fit(method, NotificationSessionEventSchema, params);
    case "state.updated":
      return fit(method, wire.NotificationStateUpdatedSchema, params);
    case "session/lifecycle/changed":
      return fit(method, wire.NotificationSessionLifecycleChangedSchema, params);
    case "startup/pluginsDegraded":
      return fit(method, wire.NotificationPluginsDegradedSchema, params);
    case "startup/storageState":
      return fit(method, wire.NotificationStorageStateSchema, params);
    case "interaction/providerRuntimeHeadersCancelled":
      return fit(method, wire.NotificationProviderRuntimeHeadersCancelledSchema, params);
    case "process/mcpTelemetry":
      return fit(method, wire.NotificationMcpTelemetrySchema, params);
    case "process/mcpResourceSamples":
      return fit(method, wire.NotificationMcpResourceSamplesSchema, params);
    case "process/toolExecResource":
      return fit(method, wire.NotificationToolExecResourceSchema, params);
    case "plugins/operationProgress":
      return fit(method, wire.NotificationPluginOperationProgressSchema, params);
    case "process/resourceSample":
      return fit(method, wire.NotificationProcessResourceSampleSchema, params);
    case "process/networkRequests":
      return fit(method, wire.NotificationNetworkRequestsSchema, params);
    case "computer-use/operation-event":
      return fit(method, wire.NotificationComputerUseOperationEventSchema, params);
  }
}

function parseRequest(method: RequestMethod, params: unknown): ServerRequest {
  switch (method) {
    case "session/requestRuntimePreferences":
      return { method, params: fit(method, wire.RequestRuntimePreferencesParamsSchema, params)?.params };
    case "interaction/requestPermission":
      return { method, params: fit(method, wire.RequestPermissionParamsSchema, params)?.params };
    case "interaction/requestUserInput":
      return { method, params: fit(method, wire.RequestUserInputParamsSchema, params)?.params };
    case "interaction/requestProviderRuntimeHeaders":
      return { method, params: fit(method, wire.RequestProviderRuntimeHeadersParamsSchema, params)?.params };
    case "interaction/requestOfficialMcpAuthHeaders":
      return { method, params: fit(method, wire.RequestOfficialMcpAuthHeadersParamsSchema, params)?.params };
    case "interaction/requestCredentialCipher":
      return { method, params: fit(method, wire.RequestCredentialCipherParamsSchema, params)?.params };
    case "interaction/browserList":
      return { method, params: fit(method, wire.RequestBrowserListParamsSchema, params)?.params };
    case "interaction/browserExecute":
      return { method, params: fit(method, wire.RequestBrowserExecuteParamsSchema, params)?.params };
    case "subagents/readRuntimeConfig":
      return { method, params: fit(method, wire.RequestSubagentsRuntimeConfigParamsSchema, params)?.params };
    case "bot/channel/reply":
      return { method, params: fit(method, wire.RequestChannelReplyParamsSchema, params)?.params };
    case "topic/resource/read":
      return { method, params: fit(method, wire.RequestTopicResourceReadParamsSchema, params)?.params };
    case "topic/resource/cancel":
      return { method, params: fit(method, wire.RequestTopicResourceCancelParamsSchema, params)?.params };
    case "appControl/listProjects":
      return { method, params: fit(method, wire.RequestAppControlListProjectsParamsSchema, params)?.params };
    case "appControl/listSessions":
      return { method, params: fit(method, wire.RequestAppControlListSessionsParamsSchema, params)?.params };
    case "appControl/readSession":
      return { method, params: fit(method, wire.RequestAppControlReadSessionParamsSchema, params)?.params };
    case "appControl/createSession":
      return { method, params: fit(method, wire.RequestAppControlCreateSessionParamsSchema, params)?.params };
    case "appControl/forkSession":
      return { method, params: fit(method, wire.RequestAppControlForkSessionParamsSchema, params)?.params };
    case "appControl/sendToSession":
      return { method, params: fit(method, wire.RequestAppControlSendToSessionParamsSchema, params)?.params };
    case "appControl/waitSessions":
      return { method, params: fit(method, wire.RequestAppControlWaitSessionsParamsSchema, params)?.params };
    case "appControl/interruptSession":
      return { method, params: fit(method, wire.RequestAppControlInterruptSessionParamsSchema, params)?.params };
    case "appControl/renameSession":
      return { method, params: fit(method, wire.RequestAppControlRenameSessionParamsSchema, params)?.params };
    case "appControl/openSession":
      return { method, params: fit(method, wire.RequestAppControlOpenSessionParamsSchema, params)?.params };
    case "appControl/setSessionArchived":
      return { method, params: fit(method, wire.RequestAppControlSetSessionArchivedParamsSchema, params)?.params };
    case "appControl/setSessionPinned":
      return { method, params: fit(method, wire.RequestAppControlSetSessionPinnedParamsSchema, params)?.params };
    case "appControl/cancel":
      return { method, params: fit(method, wire.RequestAppControlCancelParamsSchema, params)?.params };
  }
}

/**
 * Reads a notification (a message with a method and no id). A `session/event` is read as its
 * params, or, as some bundles frame it, as `{ event: <its params> }`.
 */
export function readNotification(method: string, params: unknown): NotificationRead {
  const raw = { method, params };
  if (!isNotificationMethod(method)) {
    if (isV4(method)) return { kind: "side-channel", method };
    return { kind: "unknown", unknown: { protocol: "zcode", discriminator: "method", value: method, why: "not in the snapshot", raw } };
  }
  const framed = method === "session/event" ? (recordOf(params)?.["event"] ?? params) : params;
  const notification = parseNotification(method, framed);
  if (notification !== undefined) return { kind: "known", notification };
  if (method === "session/event") {
    const type = recordOf(framed)?.["type"];
    if (typeof type === "string" && !isSessionEventType(type)) {
      return { kind: "unknown", unknown: { protocol: "zcode", discriminator: "event type", value: type, why: "not in the snapshot", raw } };
    }
    return {
      kind: "unknown",
      unknown: { protocol: "zcode", discriminator: "event type", value: typeof type === "string" ? type : "(none)", why: "does not fit the snapshot", raw },
    };
  }
  return { kind: "unknown", unknown: { protocol: "zcode", discriminator: "method", value: method, why: "does not fit the snapshot", raw } };
}

/** Reads a request of ZCode to the client (a message with a method and an id). */
export function readRequest(id: number | string, method: string, params: unknown): RequestRead {
  const raw = { id, method, params };
  if (!isRequestMethod(method)) {
    return { request: undefined, unknown: { protocol: "zcode", discriminator: "method", value: method, why: "not in the snapshot", raw } };
  }
  const request = parseRequest(method, params);
  return {
    request,
    unknown: request.params === undefined ? { protocol: "zcode", discriminator: "method", value: method, why: "does not fit the snapshot", raw } : undefined,
  };
}

/**
 * The discriminator value of an unknown variant, as a record names it: the method of a message, or
 * the type of a `session/event` (an event type is read only in that notification).
 */
export function unknownVariantName(unknown: UnknownVariant): VariantName {
  return VariantNameSchema.parse(unknown.discriminator === "method" ? unknown.value : `session/event ${unknown.value}`);
}

/** The words that put an unknown variant in a session's log: the protocol, the discriminator and its value, and the raw message. */
export function unknownDetail(unknown: UnknownVariant): string {
  const raw = JSON.stringify(unknown.raw) ?? "undefined";
  const shown = raw.length > RAW_CHARS ? `${raw.slice(0, RAW_CHARS)}... (${raw.length - RAW_CHARS} more characters)` : raw;
  return `unknown ${unknown.protocol} ${unknown.discriminator} "${unknown.value}" (${unknown.why}): ${shown}`;
}
