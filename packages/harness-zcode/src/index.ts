/**
 * The ZCode harness kind.
 *
 * It serves the reading side and the control side. The reading side reads the SQLite database
 * ZCode writes; the control side drives ZCode over `zcode app-server --stdio`. It has no insert
 * side.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ADMITTED, NO_INSERT, NoOptions, UNSUPPORTED, VERIFIED, defineHarnessKind, kindOptions } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { ZCODE_LAUNCH, zcodeControl } from "./control.ts";
import type { ZcodeControlOptions } from "./control.ts";
import { ZcodeReading } from "./reading.ts";

export { ZcodeReading } from "./reading.ts";
export type { ZcodeReadingOptions } from "./reading.ts";
export { zcodeControl } from "./control.ts";
export type { ZcodeControlOptions, ZcodeMcpOptions, ZcodePermissionPolicy, ZcodeSessionControl } from "./control.ts";

/**
 * The sides a ZCode instance has by default.
 *
 * The reading side lists and reads the sessions in the database; it does not follow a session
 * while it grows. The control side starts, resumes, sends, interrupts and asks; the session is
 * asked for JSON that matches the schema and the control side validates the answer: `ask` returns
 * a value that passed the schema.
 */
export const zcodeSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: true,
    launch: ZCODE_LAUNCH,
    tools: { niwaOnly: true, allow: true },
  },
};

/** What the kind declares it can serve, proved against a live ZCode. */
export const ZCODE_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: VERIFIED,
    launch: { model: VERIFIED, effort: ZCODE_LAUNCH.effort, modes: ZCODE_LAUNCH.modes },
    tools: { niwaOnly: ADMITTED, allow: ADMITTED },
  },
  insert: NO_INSERT,
};

/** The block a ZCode session takes at its start: `zcode`, with no option of its own yet. */
export const ZCODE_OPTIONS = kindOptions("zcode", NoOptions);

/** How a ZCode installation is found: the program that runs it, and the directory it keeps its sessions in. */
const ZCODE_DETECTION = {
  binary: "zcode",
  home: "~/.zcode",
} as const;

/** What an installation of ZCode is given: its id, home and model, and how its control side is set up. */
export interface ZcodeInstanceOptions extends InstanceOptions {
  /**
   * How the control side is set up: the reasoning level, what it does with a permission request,
   * the binary it drives and the ZCode fields of its MCP servers. Its own defaults are used when it
   * is absent. The model of the installation (`model`) is a `providerId/modelId`.
   */
  readonly control?: Omit<ZcodeControlOptions, "harness" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type ZcodeOptions = Partial<ZcodeInstanceOptions>;

/**
 * The kind "zcode". Each installation is bound to its own home (default `~/.zcode`): its sessions
 * are read from the database there, and its processes keep their sessions there.
 */
export const zcodeKind = defineHarnessKind<ZcodeInstanceOptions>({
  name: "zcode",
  capabilities: ZCODE_CAPABILITIES,
  implements: ["reading", "control"],
  sides: zcodeSides,
  detect: ZCODE_DETECTION,
  options: ZCODE_OPTIONS,
  home: () => join(homedir(), ".zcode"),
  bind: ({ id, home, model, control }) => ({
    reading: new ZcodeReading({ harness: id, home }),
    control: zcodeControl({ harness: id, home, ...(control ?? {}), ...(model === undefined ? {} : { model }) }),
  }),
});

/** One installation of ZCode: `zcode` at `~/.zcode` unless the options say otherwise. */
export function zcode(options: ZcodeOptions = {}): HarnessBinding {
  return zcodeKind.bind({ ...options, id: options.id ?? "zcode" });
}

export { zcodeSkills } from "./skills.ts";
