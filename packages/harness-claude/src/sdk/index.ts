/**
 * The Claude Agent SDK harness kind: the reading side of Claude
 * Code, which reads the files the SDK writes, and the control side over the SDK. No insert side.
 * The SDK drives the owner's own Claude Code, the `claude` on the PATH, not a copy it carries.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ADMITTED, NO_INSERT, UNSUPPORTED, VERIFIED, defineHarnessKind } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { CLAUDE_OPTIONS } from "../code/options.ts";
import { claudeProfile } from "../code/needs.ts";
import { ClaudeCodeReading } from "../code/reading.ts";
import { CLAUDE_SDK_LAUNCH, ClaudeSdkControl } from "./control.ts";
import type { ClaudeSdkControlOptions } from "./control.ts";

export { ClaudeSdkControl } from "./control.ts";
export type {
  ClaudeSdkControlOptions,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  SdkQuery,
} from "./control.ts";

export { MessageStream } from "./stream.ts";
export { signsOf } from "./messages.ts";

/**
 * The sides a Claude Agent SDK instance has by default.
 *
 * The reading side is the reading side of Claude Code: it lists and reads the files the SDK
 * writes; it does not follow a session while it grows. The control side starts, resumes, sends,
 * interrupts and asks; the SDK answers a question with a value that passed the schema, by itself.
 */
export const claudeSdkSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: true,
    launch: CLAUDE_SDK_LAUNCH,
    tools: { niwaOnly: true, allow: true },
  },
};

/** What the kind declares it can serve, proved against a live Claude Agent SDK. */
export const CLAUDE_SDK_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: VERIFIED,
    launch: { model: VERIFIED, effort: CLAUDE_SDK_LAUNCH.effort, modes: CLAUDE_SDK_LAUNCH.modes },
    tools: { niwaOnly: ADMITTED, allow: ADMITTED },
  },
  insert: NO_INSERT,
};

/**
 * How a Claude Agent SDK installation is found.
 *
 * The SDK is a library, not a program: there is no binary to look for, and the directory the
 * Claude Code files are in is all there is.
 */
const CLAUDE_SDK_DETECTION = {
  home: "~/.claude",
} as const;

/** What an installation of the SDK is given: its id, home and model, and how its control side is set up. */
export interface ClaudeSdkInstanceOptions extends InstanceOptions {
  /** The effort, when the caller does not choose one per start. */
  readonly effort?: string;
  /** The Claude Code program the SDK runs, as a path. Default: the `claude` on the PATH. */
  readonly executable?: string;
  /** The working mode, when the caller does not choose one per start. Default: `auto`. */
  readonly mode?: ClaudeSdkControlOptions["mode"];
  /** What happens when a tool asks for permission, in the modes that can ask. */
  readonly permissions?: ClaudeSdkControlOptions["permissions"];
  /** The options of the Claude kind, when the caller does not give them per start. */
  readonly claude?: ClaudeSdkControlOptions["claude"];
}

/** What the caller names of one installation: every part has a default. */
export type ClaudeSdkOptions = Partial<ClaudeSdkInstanceOptions>;

/**
 * The kind "claude-sdk". Each installation is bound to its own home (default `~/.claude`): its
 * sessions are read from there and its processes write there.
 */
export const claudeSdkKind = defineHarnessKind<ClaudeSdkInstanceOptions>({
  name: "claude-sdk",
  capabilities: CLAUDE_SDK_CAPABILITIES,
  implements: ["reading", "control"],
  sides: claudeSdkSides,
  detect: CLAUDE_SDK_DETECTION,
  options: CLAUDE_OPTIONS,
  home: () => join(homedir(), ".claude"),
  profile: { status: "admitted", of: ({ home, executable }) => claudeProfile(home, executable) },
  bind: ({ id, home, model, effort, executable, mode, permissions, claude }) => ({
    reading: new ClaudeCodeReading({ harness: id, home }),
    control: new ClaudeSdkControl({
      harness: id,
      home,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(executable === undefined ? {} : { executable }),
      ...(mode === undefined ? {} : { mode }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(claude === undefined ? {} : { claude }),
    }),
  }),
});

/** One installation of the SDK: `claude-sdk` at `~/.claude` unless the options say otherwise. */
export function claudeSdk(options: ClaudeSdkOptions = {}): HarnessBinding {
  return claudeSdkKind.bind({ ...options, id: options.id ?? "claude-sdk" });
}
