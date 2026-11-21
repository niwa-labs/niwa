/**
 * The Claude Agent SDK harness kind: the reading side of Claude
 * Code, which reads the files the SDK writes, and the control side over the SDK. No insert side.
 * The SDK drives the owner's own Claude Code, the `claude` on the PATH, not a copy it carries.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ADMITTED, KIND_OPTIONS, NO_INSERT, UNSUPPORTED, VERIFIED, defineHarnessKind, harnessId } from "@niwa-labs/harness";
import type { HarnessId, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

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

/** What the kind needs. */
export interface ClaudeSdkOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness?: HarnessId;
  /** The home of the Claude Code installation: the directory that holds `projects`. */
  readonly home?: string;
  /** The model, when the caller does not choose one per start. */
  readonly model?: string;
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

/** The kind "claude-sdk", bound to the installation the options name. */
export function claudeSdkKind(options: ClaudeSdkOptions = {}) {
  const harness = options.harness ?? harnessId("claude-sdk");
  const home = options.home ?? join(homedir(), ".claude");
  return defineHarnessKind({
    name: "claude-sdk",
    reading: new ClaudeCodeReading({ harness, home }),
    control: new ClaudeSdkControl({
      harness,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.executable === undefined ? {} : { executable: options.executable }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.claude === undefined ? {} : { claude: options.claude }),
    }),
    capabilities: CLAUDE_SDK_CAPABILITIES,
    detect: CLAUDE_SDK_DETECTION,
    options: KIND_OPTIONS.claude,
  });
}

/**
 * How a Claude Agent SDK installation is found.
 *
 * The SDK is a library, not a program: there is no binary to look for, and the directory the
 * Claude Code files are in is all there is.
 */
const CLAUDE_SDK_DETECTION = {
  home: "~/.claude",
} as const;
