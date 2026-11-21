/**
 * The Codex harness kind.
 *
 * It serves the reading side and the control side. The reading side reads the rollouts Codex
 * writes; the control side drives Codex over `codex app-server`. It has no insert side.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { KIND_OPTIONS, NO_INSERT, UNSUPPORTED, VERIFIED, defineHarnessKind, harnessId } from "@niwa-labs/harness";
import type { HarnessId, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { CODEX_LAUNCH, codexControl } from "./control.ts";
import type { CodexControlOptions } from "./control.ts";
import { CodexReading } from "./reading.ts";
import type { CodexReadingOptions } from "./reading.ts";

export { CodexReading } from "./reading.ts";
export type { CodexReadingOptions } from "./reading.ts";
export { CODEX_LAUNCH, codexControl, codexToolFlags } from "./control.ts";
export type { CodexControlOptions, CodexSessionControl } from "./control.ts";

/**
 * The sides a Codex instance has by default.
 *
 * The reading side lists and reads the rollouts Codex writes; it does not follow a session while
 * it grows. The control side starts, resumes, sends, interrupts and asks; Codex answers a
 * question with a value that passed the schema, by itself.
 */
export const codexSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: true,
    launch: CODEX_LAUNCH,
  },
};

/** What the kind declares it can serve, proved against a live Codex. */
export const CODEX_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: VERIFIED,
    launch: { model: VERIFIED, effort: CODEX_LAUNCH.effort, modes: CODEX_LAUNCH.modes },
  },
  insert: NO_INSERT,
};

/** What the kind needs: the installation, and how its control side is set up. */
export interface CodexKindOptions extends CodexReadingOptions {
  /**
   * How the control side is set up: the model it uses, the working mode its sessions run in and
   * the binary it drives. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<CodexControlOptions, "harness">;
}

/** What the caller names of the kind: every part has a default. */
export type CodexOptions = Partial<CodexKindOptions>;

/** The kind "codex", bound to the installation the options name. */
export function codexKind(options: CodexKindOptions) {
  return defineHarnessKind({
    name: "codex",
    reading: new CodexReading(options),
    control: codexControl({ harness: options.harness, ...(options.control ?? {}) }),
    capabilities: CODEX_CAPABILITIES,
    detect: CODEX_DETECTION,
    options: KIND_OPTIONS.codex,
  });
}

/** The kind for the installation at `home` (default `~/.codex`). */
export function codex(options: CodexOptions = {}) {
  return codexKind({
    ...options,
    harness: options.harness ?? harnessId("codex"),
    home: options.home ?? join(homedir(), ".codex"),
  });
}

/**
 * How a Codex installation is found: the program that runs it, and the directory it keeps its
 * rollouts in.
 */
const CODEX_DETECTION = {
  binary: "codex",
  home: "~/.codex",
} as const;

export { codexSkills } from "./skills.ts";
export { nativeIdOfFileName } from "./paths.ts";
export { FIXTURE_HARNESS as CODEX_HARNESS, writeCodexFixtures } from "./fixtures.ts";
