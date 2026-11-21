/**
 * The pi extension: the file pi loads with `pi -e` to bring niwa inside pi.
 *
 * The default export takes pi's `ExtensionAPI`. The handlers report by running `niwa insert
 * report` against the host found by NIWA_HOME, and a failure to report is written to stderr: the
 * extension never blocks or crashes pi. It is no client of the host: the command is.
 */

import { NIWA_SESSION_ENV, reportThroughCli } from "@niwa-labs/harness";
import type { InsertEvent } from "@niwa-labs/harness";

import { PiInsert } from "./insert.ts";
import type {
  PiSessionCompact,
  PiSessionInfo,
  PiSessionStart,
  PiUiPromptStart,
} from "./insert.ts";

/** The longest a report may hold pi up. */
const DEADLINE_MS = 5_000;

/** The part of pi's extension context the insert reads. */
export interface PiExtensionContext {
  readonly sessionManager: { getSessionId(): string };
  readonly cwd: string;
}

/** The part of pi's `ExtensionAPI` the insert uses. */
export interface PiExtensionApi {
  on<E>(event: string, handler: (event: E, ctx: PiExtensionContext) => Promise<void>): void;
}

function sessionOf(ctx: PiExtensionContext): PiSessionInfo {
  return { id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
}

export default function niwaPiExtension(pi: PiExtensionApi): void {
  const insert = new PiInsert({
    report: reporter(),
    owned: process.env[NIWA_SESSION_ENV] !== undefined,
  });

  pi.on<PiSessionStart>("session_start", (event, ctx) =>
    safely(() => insert.onSessionStart(event, sessionOf(ctx))),
  );
  pi.on<PiSessionCompact>("session_compact", (event, ctx) =>
    safely(() => insert.onSessionCompact(event, sessionOf(ctx))),
  );
  pi.on<PiUiPromptStart>("ui_prompt_start", (event, ctx) =>
    safely(() => insert.onUiPromptStart(event, sessionOf(ctx))),
  );
}

/** Hands the event to `niwa insert report` for the host at NIWA_HOME; without a home there is nowhere to report. */
function reporter(): (event: InsertEvent) => Promise<void> {
  return async (event) => {
    const home = process.env.NIWA_HOME;
    if (home === undefined || home.trim() === "") return;
    await reportThroughCli(event, { home });
  };
}

/** Runs a handler within the deadline; whatever goes wrong goes to stderr, never to pi. */
async function safely(work: () => Promise<void>): Promise<void> {
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, DEADLINE_MS).unref());
  try {
    await Promise.race([work(), deadline]);
  } catch (error) {
    process.stderr.write(`niwa insert: ${String(error)}\n`);
  }
}
