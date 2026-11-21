/**
 * The Codex harness kind.
 *
 * It serves the reading side and the control side. The reading side reads the rollouts Codex
 * writes; the control side drives Codex over `codex app-server`. It has no insert side.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ADMITTED, NO_INSERT, NoOptions, UNSUPPORTED, VERIFIED, defineHarnessKind, kindOptions } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { CODEX_LAUNCH, codexControl } from "./control.ts";
import type { CodexControlOptions } from "./control.ts";
import { CodexReading } from "./reading.ts";

export { CodexReading } from "./reading.ts";
export type { CodexReadingOptions } from "./reading.ts";
export { CODEX_FIXED_TOOLS, CODEX_LAUNCH, codexControl, codexToolFlags, codexToolsModeFlags } from "./control.ts";
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
    tools: { niwaOnly: false, allow: true },
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
    tools: { niwaOnly: UNSUPPORTED, allow: ADMITTED },
  },
  insert: NO_INSERT,
};

/** The block a Codex session takes at its start: `codex`, with no option of its own yet. */
export const CODEX_OPTIONS = kindOptions("codex", NoOptions);

/**
 * How a Codex installation is found: the program that runs it, and the directory it keeps its
 * rollouts in.
 */
const CODEX_DETECTION = {
  binary: "codex",
  home: "~/.codex",
} as const;

/** What an installation of Codex is given: its id, home and model, and how its control side is set up. */
export interface CodexInstanceOptions extends InstanceOptions {
  /** Where the rollouts are, when not in `<home>/sessions`. */
  readonly sessionsDir?: string;
  /**
   * How the control side is set up: the effort, the working mode its sessions run in and the binary
   * it drives. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<CodexControlOptions, "harness" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type CodexOptions = Partial<CodexInstanceOptions>;

function defaultHome(): string {
  const named = process.env["CODEX_HOME"];
  return named !== undefined && named !== "" ? named : join(homedir(), ".codex");
}

/**
 * The kind "codex". Each installation is bound to its own home (default `$CODEX_HOME`, else
 * `~/.codex`: where Codex itself looks): its rollouts are read from there, and its processes are
 * started with it, so the sessions they write are the ones the reading side lists.
 */
export const codexKind = defineHarnessKind<CodexInstanceOptions>({
  name: "codex",
  capabilities: CODEX_CAPABILITIES,
  implements: ["reading", "control"],
  sides: codexSides,
  detect: CODEX_DETECTION,
  options: CODEX_OPTIONS,
  home: defaultHome,
  bind: ({ id, home, model, sessionsDir, control }) => ({
    reading: new CodexReading({ harness: id, home, ...(sessionsDir === undefined ? {} : { sessionsDir }) }),
    control: codexControl({ ...(control ?? {}), ...(model === undefined ? {} : { model }), harness: id, home }),
  }),
});

/** One installation of Codex: `codex` at its default home unless the options say otherwise. */
export function codex(options: CodexOptions = {}): HarnessBinding {
  return codexKind.bind({ ...options, id: options.id ?? "codex" });
}

export { codexSkills } from "./skills.ts";
export { nativeIdOfFileName } from "./paths.ts";
export { FIXTURE_HARNESS as CODEX_HARNESS, writeCodexFixtures } from "./fixtures.ts";
