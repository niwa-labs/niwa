/**
 * The pi extension that gives a session niwa's tools: the file pi loads with `pi -e` for one session.
 *
 * It registers, as MCP servers of pi, the servers its process was given (`NIWA_PI_MCP_SERVERS`):
 * niwa's own server, which shows the session exactly the actions it may see and speaks to the host
 * as the session (it carries the session's token). A tool of it is a tool of pi like any other, and
 * `direct`, so the model has it from the first prompt: pi's default for an MCP server is to reach its
 * tools through a script tool, which a session of niwa's tools is not to depend on.
 */

import { PI_MCP_SERVERS_ENV, decodeServers } from "./servers.ts";

/** The entry of pi's `mcpServers` that the extension registers. */
export interface PiMcpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly exposure: "direct";
}

/** The part of pi's `ExtensionAPI` the extension uses. */
export interface PiMcpApi {
  registerMcpServer(name: string, config: PiMcpServerConfig): void;
}

export default function niwaPiTools(pi: PiMcpApi): void {
  const text = process.env[PI_MCP_SERVERS_ENV];
  if (text === undefined || text.trim() === "") return;
  for (const server of decodeServers(text)) {
    pi.registerMcpServer(server.name, { command: server.command, args: server.args, env: server.env, exposure: "direct" });
  }
}
