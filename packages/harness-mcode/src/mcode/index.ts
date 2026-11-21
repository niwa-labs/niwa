/**
 * The MiniMax Code harness kind: the published `@minimax-ai/code`.
 * The owner's fork of it is the kind `ncode` (`../ncode/index.ts`); the two share one
 * reading side and one control side.
 *
 * It serves the reading side and the control side. The reading side reads the files MiniMax Code
 * writes; the control side drives MiniMax Code over the Agent Client Protocol. It has no insert
 * side.
 */

import type { SideCapabilities } from "@niwa-labs/harness";

import { minimaxInstance, minimaxKind, minimaxSides } from "./kind.ts";
import type { McodeKindOptions, McodeOptions, MinimaxKindSpec } from "./kind.ts";

export { McodeReading } from "./reading.ts";
export type { McodeReadingOptions } from "./reading.ts";
export { mcodeControl } from "./control.ts";
export type {
  McodeControlOptions,
  McodeSessionControl,
  MinimaxLineage,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "./control.ts";
export type { McodeKindOptions, McodeOptions } from "./kind.ts";

/** The sides an upstream MiniMax Code instance has by default. */
export const mcodeSides: SideCapabilities = minimaxSides();

/**
 * How the upstream installation is found: the launcher of the published build (`mcode`),
 * and the directory it keeps its sessions in.
 */
const MCODE_KIND: MinimaxKindSpec = {
  name: "mcode",
  lineage: "upstream",
  detect: { binary: "mcode", home: "~/.minimax" },
};

/** The kind "mcode", bound to the installation the options name. */
export function mcodeKind(options: McodeKindOptions) {
  return minimaxKind(MCODE_KIND, options);
}

/** The kind for the installation at `home` (default: the home of the profile, `~/.minimax`). */
export function mcode(options: McodeOptions = {}) {
  return minimaxInstance(MCODE_KIND, options);
}

export { mcodeSkills } from "./skills.ts";
