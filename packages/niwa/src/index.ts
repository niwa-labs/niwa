/**
 * niwa: the standard composition of the platform. It re-exports the packages a program that runs
 * a host needs, and `bin/niwa.ts` is the `niwa` command.
 */

export * from "@niwa-labs/core";
export * from "@niwa-labs/plugin";
export * from "@niwa-labs/client";
export * from "@niwa-labs/host";
export * from "@niwa-labs/harness";
export * from "@niwa-labs/sandbox";
export * from "@niwa-labs/script";
export * from "@niwa-labs/requests";
export * from "@niwa-labs/messages";
export * from "@niwa-labs/tasks";
export * from "@niwa-labs/timer";
export * from "@niwa-labs/git";
export * from "@niwa-labs/proc";
export * from "@niwa-labs/history";
export * from "@niwa-labs/sessions";
export * from "@niwa-labs/agent";
export * from "@niwa-labs/workflow";
export * from "@niwa-labs/web";
export * from "@niwa-labs/mcp";
export { chatId, telegram } from "@niwa-labs/telegram";

// Names two packages declare each: the contracts of core, and the first plugin that needs the name.
export { SessionRefSchema } from "@niwa-labs/core";
export type { Answer, CallOptions, Question, SessionRef } from "@niwa-labs/core";
export { fold } from "@niwa-labs/requests";
export { sameAddress } from "@niwa-labs/sessions";

export * from "./composition.ts";
export * from "./kinds.ts";
export * from "./inserts.ts";
export * from "./mcp.ts";
export * from "./serve.ts";
export * from "./web.ts";
export { COCKPIT_OWNER_ACTIONS } from "./cockpit-pages.ts";
