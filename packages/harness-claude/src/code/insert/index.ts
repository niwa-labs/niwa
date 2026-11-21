/**
 * The Claude Code insert: a plugin inside the harness that reports what cannot be seen from
 * outside.
 *
 * The chain breaks at the edge of the harness, and only an insert inside it can stitch the chain
 * there. This one reports:
 *
 * - a session the owner opened by hand, with its exact id;
 * - a nested session, linked to the session it was spawned in;
 * - a compaction of the context, with the summary when the harness has one;
 * - a tool that asks for permission.
 *
 * The hooks inside Claude Code are no clients of the host: they run `niwa insert report`, which
 * calls one action, `insert.report`, and the host writes the records.
 */

export {
  PLUGIN_DIR_NAME,
  PLUGIN_NAME,
  hookPath,
  hooksJson,
  installClaudeCodeInsert,
  pluginJson,
} from "./install.ts";
export type { InstallOptions } from "./install.ts";

export { CLAUDE_CODE_HARNESS } from "./constants.ts";

export { report, reportOf } from "./hook.ts";
export type { HookInput, Report } from "./hook.ts";
