/**
 * The `ncode` harness kind: the owner's fork of MiniMax Code.
 *
 * It reads the files and speaks the protocol of `mcode` and shares its code. It differs in the
 * program (`mcode`, the launcher of the fork), in taking the working mode in `session/new` too,
 * and in marking tool calls with the permission decision, which its control side reports in the
 * signs of life.
 */

import type { HarnessBinding, SideCapabilities } from "@niwa-labs/harness";
import { minimaxKind, minimaxSides } from "../mcode/kind.ts";
import type { McodeOptions, MinimaxKindSpec } from "../mcode/kind.ts";

export type { McodeInstanceOptions as NcodeInstanceOptions, McodeOptions as NcodeOptions } from "../mcode/kind.ts";

/** The sides a fork instance has by default. */
export const ncodeSides: SideCapabilities = minimaxSides();

/** How the fork is found: its launcher (`mcode`), and the directory it keeps its sessions in. */
const NCODE_KIND: MinimaxKindSpec = {
  name: "ncode",
  lineage: "fork",
  detect: { binary: "mcode", home: "~/.minimax" },
};

/** The kind "ncode". */
export const ncodeKind = minimaxKind(NCODE_KIND);

/** One installation of the fork: `ncode` at the home of its profile (`~/.minimax`) unless the options say otherwise. */
export function ncode(options: McodeOptions = {}): HarnessBinding {
  return ncodeKind.bind({ ...options, id: options.id ?? "ncode" });
}

export { ncodeSkills } from "./skills.ts";
