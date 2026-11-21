/**
 * mcp.ts — `niwa mcp`: the MCP server of a running host, over stdio.
 *
 * stdout is the transport: logs go to stderr.
 *
 * NIWA_VISIBLE names the actions the session may see, as a comma-separated list of action
 * names. Without it the session sees every action; with it the session sees only those, and
 * the observation tools only when they are named too.
 *
 * NIWA_SESSION_MARK is the mark niwa gave the server when it started the session: it names the
 * session the server serves, so the tool that answers a question shows the exact schema of the
 * questions that session is asked.
 */

import { tokenOf } from "@niwa-labs/client";
import { serveMcp } from "@niwa-labs/mcp";

/** Serve MCP on stdio until the client goes away or the process is told to stop. */
export async function runMcp(home: string, env: Record<string, string | undefined>): Promise<void> {
  const visible = env["NIWA_VISIBLE"]?.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const mark = env["NIWA_SESSION_MARK"]?.trim() || undefined;
  const token = tokenOf(home, env);
  const mcp = await serveMcp({
    home,
    visible,
    ...(mark === undefined ? {} : { mark }),
    ...(token === undefined ? {} : { token }),
  });
  mcp.server.onclose = ((previous) => () => {
    previous?.();
    process.exit(0);
  })(mcp.server.onclose);

  process.on("SIGTERM", () => {
    void mcp.close().finally(() => process.exit(0));
  });
}
