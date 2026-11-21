/**
 * The ZCode harness kind.
 *
 * It serves the reading side and the control side. The reading side reads the SQLite database
 * ZCode writes; the control side drives ZCode over `zcode app-server --stdio`. It has no insert
 * side.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { KIND_OPTIONS, defineHarnessKind, harnessId } from "@niwa-labs/harness";
import type { SideCapabilities } from "@niwa-labs/harness";

import { ZCODE_LAUNCH, zcodeControl } from "./control.ts";
import type { ZcodeControlOptions } from "./control.ts";
import { ZcodeReading } from "./reading.ts";
import type { ZcodeReadingOptions } from "./reading.ts";

export { ZcodeReading } from "./reading.ts";
export type { ZcodeReadingOptions } from "./reading.ts";
export { zcodeControl } from "./control.ts";
export type { ZcodeControlOptions, ZcodePermissionPolicy, ZcodeSessionControl } from "./control.ts";

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
  },
};

/** What the kind needs: the installation, and how its control side is set up. */
export interface ZcodeKindOptions extends ZcodeReadingOptions {
  /**
   * How the control side is set up: the model it uses (`providerId/modelId`), the reasoning
   * level, what it does with a permission request and the binary it drives. Its own defaults are
   * used when it is absent.
   */
  readonly control?: Omit<ZcodeControlOptions, "harness" | "home">;
}

/** What the caller names of the kind: every part has a default. */
export type ZcodeOptions = Partial<ZcodeKindOptions>;

/** The kind "zcode", bound to the installation the options name. */
export function zcodeKind(options: ZcodeKindOptions) {
  return defineHarnessKind({
    name: "zcode",
    reading: new ZcodeReading(options),
    control: zcodeControl({ harness: options.harness, home: options.home, ...(options.control ?? {}) }),
    detect: ZCODE_DETECTION,
    options: KIND_OPTIONS.zcode,
  });
}

/** The kind for the installation at `home` (default `~/.zcode`). */
export function zcode(options: ZcodeOptions = {}) {
  return zcodeKind({
    ...options,
    harness: options.harness ?? harnessId("zcode"),
    home: options.home ?? join(homedir(), ".zcode"),
  });
}

/** How a ZCode installation is found: the program that runs it, and the directory it keeps its sessions in. */
const ZCODE_DETECTION = {
  binary: "zcode",
  home: "~/.zcode",
} as const;

export { zcodeSkills } from "./skills.ts";
