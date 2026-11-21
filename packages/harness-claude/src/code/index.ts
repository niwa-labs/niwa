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

import { ADMITTED, UNSUPPORTED, VERIFIED, defineHarnessKind } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { CLAUDE_CODE_ADAPTER, claudeCodeControl } from "./control.ts";
import { CLAUDE_CODE_LAUNCH } from "./launch.ts";
import type { ClaudeCodeControlOptions } from "./control.ts";
import { installClaudeCodeInsert } from "./insert/index.ts";
import { CLAUDE_OPTIONS } from "./options.ts";
import { ClaudeCodeReading } from "./reading.ts";

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

/**
 * How a Claude Code installation is found: the ACP adapter that drives it, and the directory it
 * keeps its sessions in.
 */
const CLAUDE_CODE_DETECTION = {
  bundled: CLAUDE_CODE_ADAPTER,
  home: "~/.claude",
} as const;

/** What an installation of Claude Code is given: its id, home and model, and how its control side is set up. */
export interface ClaudeCodeInstanceOptions extends InstanceOptions {
  /**
   * How the control side is set up: what it does with a permission request, the adapter it drives,
   * the effort and the Claude options of its sessions. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<ClaudeCodeControlOptions, "harness" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type ClaudeCodeOptions = Partial<ClaudeCodeInstanceOptions>;

/**
 * The kind "claude-code". Each installation is bound to its own home (default `~/.claude`): its
 * sessions are read from there, its processes write there, and its insert is put there.
 */
export const claudeCodeKind = defineHarnessKind<ClaudeCodeInstanceOptions>({
  name: "claude-code",
  capabilities: CLAUDE_CODE_CAPABILITIES,
  implements: ["reading", "control", "insert"],
  sides: claudeCodeSides,
  detect: CLAUDE_CODE_DETECTION,
  options: CLAUDE_OPTIONS,
  home: () => join(homedir(), ".claude"),
  bind: ({ id, home, model, control }) => ({
    reading: new ClaudeCodeReading({ harness: id, home }),
    control: claudeCodeControl({ harness: id, ...(control ?? {}), ...(model === undefined ? {} : { model }), home }),
    insert: {
      // The insert is put into the installation it belongs to: the plugin is written into the
      // plugins directory of that installation, and the hooks report to the host at the home
      // the caller names, through `niwa insert report`.
      install: async (opts) => {
        await installClaudeCodeInsert(join(home, "plugins"), {
          home: opts.home,
          harness: id,
          ...(opts.cli === undefined ? {} : { cli: opts.cli }),
        });
      },
    },
  }),
});

/** One installation of Claude Code: `claude-code` at `~/.claude` unless the options say otherwise. */
export function claudeCode(options: ClaudeCodeOptions = {}): HarnessBinding {
  return claudeCodeKind.bind({ ...options, id: options.id ?? "claude-code" });
}

export { claudeCodeSkills } from "./skills.ts";
