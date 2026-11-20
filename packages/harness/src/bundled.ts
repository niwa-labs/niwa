/**
 * A program niwa ships as its own dependency: the ACP adapter of
 * Claude Code is one. It is run by the runtime that runs niwa, so finding it and starting it are
 * the same resolution and neither wants anything on the `PATH`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { z } from "zod";

/** Where a bundled program is: the package that holds it and the script inside the package. */
export const BundledProgramSchema = z.object({
  package: z.string().min(1),
  /** The script, relative to the root of the package. */
  entry: z.string().min(1),
});
export type BundledProgram = z.output<typeof BundledProgramSchema>;

/** What of a `package.json` niwa reads: the version, when the package says one. */
const PackageManifestSchema = z.object({ version: z.string().min(1) });

/** The script of a bundled program, as an absolute path. Throws when the package is not installed. */
export function bundledPath(program: BundledProgram): string {
  return createRequire(import.meta.url).resolve(`${program.package}/${program.entry}`);
}

/** The version a `package.json` says, when it says one: a version that is not a non-empty text is none. */
export function manifestVersion(manifest: unknown): string | undefined {
  const parsed = PackageManifestSchema.safeParse(manifest);
  return parsed.success ? parsed.data.version : undefined;
}

/** The version the package of a bundled program says in its `package.json`, when it says one. */
export function bundledVersion(program: BundledProgram): string | undefined {
  return manifestVersion(
    JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${program.package}/package.json`), "utf8")),
  );
}
