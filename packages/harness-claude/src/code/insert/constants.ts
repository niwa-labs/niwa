/**
 * The names the insert and its hooks agree on.
 *
 * The name of the action and the marker of a session niwa started are the harness package's
 * (`@niwa-labs/harness`): they are the same for every kind.
 */

/** The id of the harness this insert serves: Claude Code. */
export const CLAUDE_CODE_HARNESS = "claude-code";

/**
 * The variable the hook command carries the id of the harness instance in: the plugin is installed
 * for one instance, and the sessions its hooks report are that instance's.
 */
export const INSERT_HARNESS_ENV = "NIWA_INSERT_HARNESS";
