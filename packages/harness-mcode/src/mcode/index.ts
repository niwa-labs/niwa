/**
 * The MiniMax Code harness kind: the published `@minimax-ai/code`.
 * The owner's fork of it is the kind `ncode` (`../ncode/index.ts`); the two share one
 * reading side and one control side.
 *
 * It serves the reading side and the control side. The reading side reads the files MiniMax Code
 * writes; the control side drives MiniMax Code over the Agent Client Protocol. It has no insert
 * side.
 */

import type { HarnessBinding, SideCapabilities } from "@niwa-labs/harness";

import { minimaxKind, minimaxSides } from "./kind.ts";
import type { McodeOptions, MinimaxKindSpec } from "./kind.ts";

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
export type { McodeInstanceOptions, McodeOptions } from "./kind.ts";

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

/** The kind "mcode". */
export const mcodeKind = minimaxKind(MCODE_KIND);

/** One installation of the published build: `mcode` at the home of its profile (`~/.minimax`) unless the options say otherwise. */
export function mcode(options: McodeOptions = {}): HarnessBinding {
  return mcodeKind.bind({ ...options, id: options.id ?? "mcode" });
}

export { mcodeSkills } from "./skills.ts";
