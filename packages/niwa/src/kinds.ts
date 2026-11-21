/**
 * The harness kinds niwa serves.
 *
 * Each kind is code with the sides it has: a factory that binds the kind to an installation, and
 * the sides the kind offers by default. A caller that names a kind says which installation it is
 * and how its control side is set up; the sides are what the installation may claim.
 *
 * The kinds:
 *
 * - `claude-code` — Claude Code, over the Agent Client Protocol, with an insert side;
 * - `claude-sdk` — the Claude Agent SDK, over the SDK itself;
 * - `codex` — Codex, over `codex app-server`;
 * - `mcode` — MiniMax Code (the published build), over the Agent Client Protocol;
 * - `ncode` — the owner's fork of MiniMax Code, over the same protocol and the same files;
 * - `pi` — pi, read from its files, with an insert side and no control side;
 * - `zcode` — ZCode, read from its SQLite database and driven over `zcode app-server`.
 */

export { claudeCode, claudeCodeKind, claudeCodeSides } from "@niwa-labs/harness-claude";
export type { ClaudeCodeKindOptions, ClaudeCodeOptions, ClaudeCodeReadingOptions } from "@niwa-labs/harness-claude";

export { claudeSdkKind, claudeSdkSides } from "@niwa-labs/harness-claude";
export type { ClaudeSdkOptions } from "@niwa-labs/harness-claude";

export { codex, codexKind, codexSides } from "@niwa-labs/harness-codex";
export type { CodexKindOptions, CodexOptions, CodexReadingOptions } from "@niwa-labs/harness-codex";

export { mcode, mcodeKind, mcodeSides } from "@niwa-labs/harness-mcode";
export type { McodeKindOptions, McodeOptions, McodeReadingOptions } from "@niwa-labs/harness-mcode";

export { ncode, ncodeKind, ncodeSides } from "@niwa-labs/harness-mcode";
export type { NcodeKindOptions, NcodeOptions } from "@niwa-labs/harness-mcode";

export { PI_KIND, pi } from "@niwa-labs/harness-pi";
export type { PiKindOptions, PiReadingOptions } from "@niwa-labs/harness-pi";

export { zcode, zcodeKind, zcodeSides } from "@niwa-labs/harness-zcode";
export type { ZcodeKindOptions, ZcodeOptions, ZcodePermissionPolicy, ZcodeReadingOptions } from "@niwa-labs/harness-zcode";

export { KINDS_WITH_SKILLS } from "./skills.ts";
