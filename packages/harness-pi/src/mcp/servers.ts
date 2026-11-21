/**
 * The servers a pi session is given, as they cross from the control side to the extension inside pi.
 *
 * pi's RPC mode takes no MCP server, but an extension of pi can register one for the session, so
 * the control side hands the servers to the extension through the environment of the process it
 * starts, and the extension registers them.
 */

import { z } from "zod";

import type { McpServerSpec } from "@niwa-labs/harness";

/** The environment variable that carries the servers of a session to the extension inside pi. */
export const PI_MCP_SERVERS_ENV = "NIWA_PI_MCP_SERVERS";

/** One server, as the extension registers it: the part of niwa's server spec that pi's `mcpServers` entry takes. */
export const PiMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});
export type PiMcpServer = z.output<typeof PiMcpServerSchema>;

/** The servers as text for the environment. */
export function encodeServers(servers: readonly McpServerSpec[]): string {
  return JSON.stringify(servers.map(({ name, command, args, env }) => ({ name, command, args, env })));
}

/** The servers the environment carries; text that is not servers is an error. */
export function decodeServers(text: string): PiMcpServer[] {
  return z.array(PiMcpServerSchema).parse(JSON.parse(text));
}

/**
 * The pattern of the tools of one server, as pi's `--tools` reads it. pi names a tool of an MCP
 * server `mcp__<server>__<tool>`, with every character of the server other than a letter, a digit
 * or `_` written as `_`.
 */
export function piToolPattern(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__*`;
}
