/**
 * The harness kinds niwa serves.
 *
 * Each kind is code with the sides it has: the kind itself, whose `bind` makes one installation of it
 * with its own id, home, model and options, a shorthand for one installation with every default, and
 * the sides the kind offers by default. Several installations of one kind are several binds.
 *
 * The kinds:
 *
 * - `claude-code` — Claude Code, over the Agent Client Protocol, with an insert side;
 * - `claude-sdk` — the Claude Agent SDK, over the SDK itself;
 * - `codex` — Codex, over `codex app-server`;
 * - `mcode` — MiniMax Code (the published build), over the Agent Client Protocol;
 * - `ncode` — the owner's fork of MiniMax Code, over the same protocol and the same files;
 * - `opencode` — OpenCode v2, over its per-session HTTP server through the typed client;
 * - `pi` — pi, read from its files, with an insert side and no control side;
 * - `zcode` — ZCode, read from its SQLite database and driven over `zcode app-server`.
 */

export { CLAUDE_OPTIONS, claudeCode, claudeCodeKind, claudeCodeSides } from "@niwa-labs/harness-claude";
export type { ClaudeCodeInstanceOptions, ClaudeCodeOptions, ClaudeCodeReadingOptions } from "@niwa-labs/harness-claude";

export { claudeSdk, claudeSdkKind, claudeSdkSides } from "@niwa-labs/harness-claude";
export type { ClaudeSdkInstanceOptions, ClaudeSdkOptions } from "@niwa-labs/harness-claude";

export { CODEX_OPTIONS, codex, codexKind, codexSides } from "@niwa-labs/harness-codex";
export type { CodexInstanceOptions, CodexOptions, CodexReadingOptions } from "@niwa-labs/harness-codex";

export { mcode, mcodeKind, mcodeSides } from "@niwa-labs/harness-mcode";
export type { McodeInstanceOptions, McodeOptions, McodeReadingOptions } from "@niwa-labs/harness-mcode";

export { ncode, ncodeKind, ncodeSides } from "@niwa-labs/harness-mcode";
export type { NcodeInstanceOptions, NcodeOptions } from "@niwa-labs/harness-mcode";

export { PI_KIND, PI_OPTIONS, pi, piKind, piSides } from "@niwa-labs/harness-pi";
export type { PiInstanceOptions, PiOptions, PiReadingOptions } from "@niwa-labs/harness-pi";

export { ZCODE_OPTIONS, zcode, zcodeKind, zcodeSides } from "@niwa-labs/harness-zcode";
export type { ZcodeInstanceOptions, ZcodeMcpOptions, ZcodeOptions, ZcodePermissionPolicy, ZcodeReadingOptions } from "@niwa-labs/harness-zcode";

export { OPENCODE_OPTIONS, opencode, opencodeKind, opencodeSides } from "@niwa-labs/harness-opencode";
export type { OpenCodeControlOptions, OpenCodeInstanceOptions, OpenCodeOptions, OpenCodePermissionPolicy, OpenCodeReadingOptions } from "@niwa-labs/harness-opencode";

export { KINDS_WITH_SKILLS } from "./skills.ts";
