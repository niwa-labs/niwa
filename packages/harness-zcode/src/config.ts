/**
 * The user's config file of a ZCode installation, read the way ZCode reads it, for the one thing
 * niwa needs from it: `permission.mode`, the mode a session gets when nothing else names one.
 *
 * Only this file counts. ZCode reads a project's `zcode.json` and `.zcode/config.json` through a
 * schema that keeps the extension declarations (mcp, hooks, skills, commands, plugins) and strips
 * the rest, `permission` among it; and its `ZCODE_*` environment names no mode. A file that is not
 * a JSON object, or whose `permission.mode` is not one of ZCode's modes, is not loaded at all.
 */

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { configPathOf } from "./paths.ts";

/** The modes ZCode's config schema accepts for `permission.mode`. */
const ZCODE_MODES = ["plan", "build", "edit", "yolo", "guarded", "auto"] as const;

const ConfigFileSchema = z.looseObject({
  permission: z.looseObject({ mode: z.enum(ZCODE_MODES).optional() }).optional(),
});

/** `permission.mode` of the config file under `home`; `undefined` when the file is absent, unreadable, invalid, or names none. */
export function configuredModeOf(home: string): string | undefined {
  const path = configPathOf(home);
  if (!existsSync(path)) return undefined;
  try {
    return ConfigFileSchema.parse(JSON.parse(readFileSync(path, "utf-8")) as unknown).permission?.mode;
  } catch {
    return undefined;
  }
}
