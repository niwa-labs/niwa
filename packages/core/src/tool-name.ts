/**
 * The name of an action as an MCP tool: the one rule the tool catalogue and the sessions that list
 * their tools by name share.
 */

/** The tool name of an action: dots and dashes are not allowed in a tool name. */
export function toolNameOf(action: string): string {
  return action.replace(/[.\-]/g, "_");
}
