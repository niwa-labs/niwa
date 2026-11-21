/**
 * The Claude Code harness kind.
 *
 * It serves the reading side, the control side and the insert side. The reading side reads the
 * files Claude Code writes; the control side drives Claude Code over the Agent Client Protocol;
 * the insert side is the plugin inside Claude Code, which is installed into the installation it
 * belongs to.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ADMITTED, UNSUPPORTED, VERIFIED, defineHarnessKind, harnessId } from "@niwa-labs/harness";
import type { HarnessId, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { CLAUDE_CODE_ADAPTER, claudeCodeControl } from "./control.ts";
import { CLAUDE_CODE_LAUNCH } from "./launch.ts";
import type { ClaudeCodeControlOptions } from "./control.ts";
import { installClaudeCodeInsert } from "./insert/index.ts";
import { CLAUDE_OPTIONS } from "./options.ts";
import { ClaudeCodeReading } from "./reading.ts";
import type { ClaudeCodeReadingOptions } from "./reading.ts";

export { ClaudeCodeReading } from "./reading.ts";
export type { ClaudeCodeReadingOptions } from "./reading.ts";
export { claudeCodeControl } from "./control.ts";
export type {
  ClaudeCodeControlOptions,
  ClaudeCodeSessionControl,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "./control.ts";

/**
 * The sides a Claude Code instance has by default.
 *
 * The reading side lists and reads the files Claude Code writes; it does not follow a session
 * while it grows. The control side starts, resumes, sends, interrupts and asks; the ACP
 * protocol carries no schema, so the schema goes into the question and the control side validates
 * the answer: `ask` returns a value that passed the schema.
 */
export const claudeCodeSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: true,
    launch: CLAUDE_CODE_LAUNCH,
    tools: { niwaOnly: true, allow: true },
  },
};

/**
 * What the kind declares it can serve. The control side and the reading side are proved against
 * a live Claude Code; the insert side's hooks are taken from Claude Code's hook documentation.
 */
export const CLAUDE_CODE_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: VERIFIED,
    launch: { model: VERIFIED, effort: CLAUDE_CODE_LAUNCH.effort, modes: CLAUDE_CODE_LAUNCH.modes },
    tools: { niwaOnly: ADMITTED, allow: ADMITTED },
  },
  insert: { nested: ADMITTED, compaction: ADMITTED, manualOpen: ADMITTED, permission: ADMITTED, end: ADMITTED },
};

/** What the kind needs: the installation, and how its control side is set up. */
export interface ClaudeCodeKindOptions extends ClaudeCodeReadingOptions {
  /**
   * How the control side is set up: the model it uses, what it does with a permission request,
   * and the adapter it drives. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<ClaudeCodeControlOptions, "harness" | "home">;
}

/** What the caller names of the kind: every part has a default. */
export type ClaudeCodeOptions = Partial<ClaudeCodeKindOptions>;

/** The kind "claude-code", bound to the installation the options name. */
export function claudeCodeKind(options: ClaudeCodeKindOptions) {
  return defineHarnessKind({
    name: "claude-code",
    reading: new ClaudeCodeReading(options),
    control: claudeCodeControl({ harness: options.harness, ...(options.control ?? {}), home: options.home }),
    insert: {
      // The insert is put into the installation it belongs to: the plugin is written into the
      // plugins directory of that installation, and the hooks report to the host at the home
      // the caller names, through `niwa insert report`.
      install: async (opts) => {
        await installClaudeCodeInsert(join(options.home, "plugins"), {
          home: opts.home,
          harness: options.harness,
          ...(opts.cli === undefined ? {} : { cli: opts.cli }),
        });
      },
    },
    capabilities: CLAUDE_CODE_CAPABILITIES,
    detect: CLAUDE_CODE_DETECTION,
    options: CLAUDE_OPTIONS,
  });
}

/** The kind for the installation at `home` (default `~/.claude`). */
export function claudeCode(options: ClaudeCodeOptions = {}) {
  return claudeCodeKind({
    ...options,
    harness: options.harness ?? harnessId("claude-code"),
    home: options.home ?? join(homedir(), ".claude"),
  });
}

/**
 * How a Claude Code installation is found: the ACP adapter that drives it, and the directory it
 * keeps its sessions in.
 */
const CLAUDE_CODE_DETECTION = {
  bundled: CLAUDE_CODE_ADAPTER,
  home: "~/.claude",
} as const;

export { claudeCodeSkills } from "./skills.ts";
