/**
 * The directory a call is for: where the caller works.
 *
 * An action that takes a `directory` (the project a run belongs to) is told where the caller works when the caller names
 * none. The surfaces that act for a person or an agent in a working directory, the CLI and the MCP server, fill it in
 * from the schema of the action: they keep no list of the actions that take one.
 */

import type { JsonSchema } from "@niwa-labs/core";

/** The field of an action's input that holds the directory the call is for. */
export const DIRECTORY_FIELD = "directory";

/** Does the input schema of an action declare a directory? */
export function takesDirectory(input: JsonSchema | undefined): boolean {
  const properties = (input as { properties?: unknown } | undefined)?.properties;
  return properties !== null && typeof properties === "object" && Object.hasOwn(properties, DIRECTORY_FIELD);
}

/** The input with the caller's working directory in `directory`, when the action takes one and the input has none. */
export function withWorkingDirectory(
  input: JsonSchema | undefined,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): Record<string, unknown> {
  if (!takesDirectory(input) || args[DIRECTORY_FIELD] !== undefined) return args;
  return { ...args, [DIRECTORY_FIELD]: cwd };
}
