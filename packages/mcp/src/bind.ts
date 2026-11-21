/**
 * bind.ts — the core client of one MCP session.
 *
 * The caller is bound by the transport, never by a tool argument:
 * the client is opened with an id made from the session, so the host sees that id and no other.
 */

import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import type { Token } from "@niwa-labs/core";

/** The id of one MCP session. */
export type SessionId = string;

/** A session and the core client that speaks for it. */
export interface Binding {
  readonly sessionId: SessionId;
  readonly api: NiwaApi;
}

/** The client id the host sees for a session. */
export function clientIdOf(sessionId: SessionId): string {
  return `mcp:${sessionId}`;
}

/** How the core client of a session is opened: by connecting to the host of the home. */
export type Connector = (opts: { home: string; id: string; token?: Token }) => Promise<NiwaApi>;

/** Open the core client of one session. */
export async function bind(opts: { home: string; sessionId: SessionId; token?: Token; connect?: Connector }): Promise<Binding> {
  const api = await (opts.connect ?? connect)({
    home: opts.home,
    id: clientIdOf(opts.sessionId),
    ...(opts.token === undefined ? {} : { token: opts.token }),
  });
  return { sessionId: opts.sessionId, api };
}
