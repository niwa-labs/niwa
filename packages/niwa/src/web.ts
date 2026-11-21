/**
 * web.ts — `niwa web [--port N]`: the web cockpit of a running host.
 *
 * It prints the address and the login link, and serves until it is stopped. The web surface draws
 * no page: the cockpit app is a package of its own, built when it is missing or older than its
 * sources, and `niwa web` hands it to the surface. When it cannot be built a plain notice stands at
 * `/` and at the trace of a record, while the API under `/api` serves as it does.
 */

import { cockpitApp } from "@niwa-labs/cockpit";
import { TOKEN_ENV } from "@niwa-labs/core";
import { serveWeb } from "@niwa-labs/web";
import type { WebApp, WebOptions, WebPages, WebServer } from "@niwa-labs/web";

import { COCKPIT_OWNER_ACTIONS } from "./cockpit-pages.ts";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function noticePage(title: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>niwa</title></head>
<body><h1>${escapeHtml(title)}</h1><p>The cockpit app is not installed; the API of this host is served under /api.</p></body>
</html>
`;
}

/** The pages the surface serves when it has no app, and under the app for the trace of a record. */
export const NOTICE_PAGES: WebPages = {
  feed: () => noticePage("niwa"),
  trace: (recordId) => noticePage(`niwa: ${recordId}`),
};

/** The web surface with the pages it is given, and the actions of the workflow page for the owner. */
export function serveCockpit(options: Omit<WebOptions, "ownerActions">): Promise<WebServer> {
  return serveWeb({ ...options, ownerActions: COCKPIT_OWNER_ACTIONS });
}

/** The port from the arguments of `niwa web`; undefined when they are not `[--port N]`. */
export function portOf(args: readonly string[]): number | undefined {
  if (args.length === 0) return 0;
  const text = args.length === 2 && args[0] === "--port" ? args[1] : args.length === 1 ? args[0]?.replace(/^--port=/, "") : undefined;
  if (text === undefined || text.trim() === "") return undefined;
  const port = Number(text);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

/** The built cockpit app, or undefined, with the reason printed, when it cannot be had: the API still serves. */
async function appOrNotice(): Promise<WebApp | undefined> {
  try {
    return await cockpitApp();
  } catch (error) {
    console.error(`niwa web: the cockpit app is not available, a plain notice is served instead: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Serve the cockpit of the home on the port, with the app it is given or the built one. The address and the login link are
 * for the caller to print.
 */
export async function startWeb(home: string, port: number, env: Record<string, string | undefined>, app?: WebApp | undefined): Promise<WebServer> {
  // The owner's own tool speaks for the owner. A process a session started (`NIWA_ID`) is that
  // session, not the owner: its page is a plain client.
  const speaksFor = env[TOKEN_ENV]?.trim() ? undefined : "owner";
  const served = app ?? (await appOrNotice());
  return serveCockpit({
    home,
    port,
    pages: NOTICE_PAGES,
    ...(served === undefined ? {} : { app: served }),
    ...(speaksFor === undefined ? {} : { speaksFor }),
  });
}

/** Serve the cockpit of the home on the port, until SIGINT or SIGTERM. */
export async function runWeb(home: string, port: number, env: Record<string, string | undefined>): Promise<void> {
  const server = await startWeb(home, port, env);
  console.log(`niwa web: ${server.url} (home ${home})`);
  console.log(`niwa web: open this link once to log in: ${server.loginUrl}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}
