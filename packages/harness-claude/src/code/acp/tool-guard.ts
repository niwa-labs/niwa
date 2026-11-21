/**
 * The guard niwa's adapter entry puts before every tool call of a session held to a set of tools.
 *
 * The set is kept by what Claude Code is started with (its `tools`, and strict MCP config); the
 * guard is the second line: a call of a built-in tool the set leaves out, or of a tool of an MCP
 * server the session was not given, is denied before it runs, whatever the settings of the owner
 * loaded or any mode decided.
 */

/** What the guard holds a session to. */
export interface ToolGuardConfig {
  /** The built-in tools the session may use. */
  readonly allow: readonly string[];
  /** The MCP servers the session was given, by the name it knows them by. */
  readonly servers: readonly string[];
}

/** The name Claude Code gives an MCP server in the name of its tools: what it cannot carry becomes `_`. */
function mcpName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Why a call is denied, or `undefined` when the guard has nothing against it.
 *
 * `builtins` are the names of Claude Code's own tools: the ones the set leaves out are denied. A
 * name that is neither a built-in nor an MCP tool is not the guard's to judge.
 */
export function denialOf(config: ToolGuardConfig, tool: string, builtins: readonly string[]): string | undefined {
  if (tool.startsWith("mcp__")) {
    const given = config.servers.some((server) => tool.startsWith(`mcp__${mcpName(server)}__`));
    return given ? undefined : `the tool ${tool} is of an MCP server this session was not given`;
  }
  if (builtins.includes(tool) && !config.allow.includes(tool)) {
    return `the tool ${tool} is not in the set of tools this session is held to`;
  }
  return undefined;
}

/** The answer of a hook that denies a tool call. */
function denial(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** What the adapter gives a hook: the call, among other things. */
interface HookCall {
  readonly tool_name?: unknown;
}

/**
 * The hooks that hold a session to its set, from the `_meta.niwa` of its `session/new` or
 * `session/load`: none for a session with all of its tools.
 */
export function toolGuardHooks(
  niwa: { readonly tools?: unknown; readonly servers?: unknown } | undefined,
  builtins: readonly string[],
): Array<(input: HookCall) => Promise<Record<string, unknown>>> {
  if (!Array.isArray(niwa?.tools)) return [];
  const config: ToolGuardConfig = {
    allow: niwa.tools.filter((tool): tool is string => typeof tool === "string"),
    servers: Array.isArray(niwa.servers) ? niwa.servers.filter((server): server is string => typeof server === "string") : [],
  };
  return [
    async (input) => {
      const tool = typeof input.tool_name === "string" ? input.tool_name : undefined;
      const reason = tool === undefined ? undefined : denialOf(config, tool, builtins);
      return reason === undefined ? {} : denial(reason);
    },
  ];
}
