// A real MCP server of a home linked to an SDK client over memory, for the tests of the generated surfaces and of the caller.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { readOwnerToken } from "@niwa-labs/client";
import type { Token } from "@niwa-labs/core";
import { createMcpServer } from "@niwa-labs/mcp";

export interface McpPair {
  client: Client;
  close: () => Promise<void>;
}

/** Start the MCP server of a home and a client connected to it: as the owner's `niwa mcp` is, unless a session's token is given. */
export async function mcpPair(
  home: string,
  visible?: readonly string[],
  mark?: string,
  token: Token | undefined = readOwnerToken(home),
): Promise<McpPair> {
  const mcp = createMcpServer({
    home,
    ...(visible === undefined ? {} : { visible }),
    ...(mark === undefined ? {} : { mark }),
    ...(token === undefined ? {} : { token }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check", version: "0.1.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

/** The text of a tool result. */
export function textOf(result: object): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? part.text : "")).join("");
}

/** The JSON a tool answered with. */
export function jsonOf(result: object): unknown {
  return JSON.parse(textOf(result));
}
