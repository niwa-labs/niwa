/**
 * The `ncode` harness kind: the owner's fork of MiniMax Code.
 *
 * It reads the files and speaks the protocol of `mcode` and shares its code. It differs in the
 * program (`mcode`, the launcher of the fork), in taking the working mode in `session/new` too,
 * and in marking tool calls with the permission decision, which its control side reports in the
 * signs of life.
 */

import type { SideCapabilities } from "@niwa-labs/harness";
import { minimaxInstance, minimaxKind, minimaxSides } from "../mcode/kind.ts";
import type { McodeKindOptions, McodeOptions, MinimaxKindSpec } from "../mcode/kind.ts";

export type { McodeKindOptions as NcodeKindOptions, McodeOptions as NcodeOptions } from "../mcode/kind.ts";

/** The sides a fork instance has by default. */
export const ncodeSides: SideCapabilities = minimaxSides();

/** How the fork is found: its launcher (`mcode`), and the directory it keeps its sessions in. */
const NCODE_KIND: MinimaxKindSpec = {
  name: "ncode",
  lineage: "fork",
  detect: { binary: "mcode", home: "~/.minimax" },
};

/** The kind "ncode", bound to the installation the options name. */
export function ncodeKind(options: McodeKindOptions) {
  return minimaxKind(NCODE_KIND, options);
}

/** The kind for the installation at `home` (default: the home of the profile, `~/.minimax`). */
export function ncode(options: McodeOptions = {}) {
  return minimaxInstance(NCODE_KIND, options);
}

export { ncodeSkills } from "./skills.ts";
