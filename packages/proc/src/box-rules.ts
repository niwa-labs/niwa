/**
 * The rules that widen a box, as names a grant and a script's `uses` can hold.
 *
 * A box is widened beyond the host's default by the caller's rules `box.use@<profile>`,
 * `box.read@<path>`, `box.write@<path>` and `box.net@<host>`: the action that makes the box (a
 * `proc.run`, a `session.start`) holds them against the grant. They are registered here as actions
 * so a grant and a script can name them like any other; calling one only answers that the caller
 * holds it, since a call its grant does not cover is refused before it runs.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { placeTarget } from "@niwa-labs/sandbox";

import { boxNet, boxRead, boxUse, boxWrite } from "./records.ts";

/** The real path of a place, or the place as it is spelled when it is not there. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The plugin that registers the rules of the box. */
export function boxRules(): Plugin {
  return plugin("box", (api) => {
    const held = async () => ({ held: true as const });
    const common = { recovery: "repeat", effect: "read", world: "local", run: held } as const;
    api.action(action(boxUse, { ...common, target: (input) => input.profile }));
    api.action(action(boxRead, { ...common, target: (input) => placeTarget(realOr(input.path)) }));
    api.action(action(boxWrite, { ...common, target: (input) => placeTarget(realOr(input.path)) }));
    api.action(action(boxNet, { ...common, target: (input) => input.host }));
  });
}
