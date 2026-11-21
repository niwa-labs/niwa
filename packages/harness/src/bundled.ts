/**
 * A program niwa ships as the dependency of a kind: the ACP adapter of Claude Code is one. It is
 * run by the runtime that runs niwa, so finding it and starting it are the same resolution and
 * neither wants anything on the `PATH`. The kind that depends on the program finds it and hands
 * the result to discovery.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { z } from "zod";

/**
 * A bundled program as the kind that ships it found it: the package that holds it, the script
 * inside the package as an absolute path, and the version the package says.
 *
 * The kind finds it because the kind declares the dependency: a package manager that keeps each
 * package's dependencies apart shows them to that package alone. `path` is absent when the
 * package is not installed where the kind looks.
 */
export const BundledProgramSchema = z.object({
  /** The package that holds the program. */
  package: z.string().min(1),
  /** The script, as an absolute path. */
  path: z.string().min(1).optional(),
  /** The version the package says in its `package.json`, when it says one. */
  version: z.string().min(1).optional(),
});
export type BundledProgram = z.output<typeof BundledProgramSchema>;

/** What of a `package.json` niwa reads: the version, when the package says one. */
const PackageManifestSchema = z.object({ version: z.string().min(1) });

/** The version a `package.json` says, when it says one: a version that is not a non-empty text is none. */
export function manifestVersion(manifest: unknown): string | undefined {
  const parsed = PackageManifestSchema.safeParse(manifest);
  return parsed.success ? parsed.data.version : undefined;
}

/**
 * Find a bundled program from the package that depends on it.
 *
 * `from` is the `import.meta.url` of a file of that package, and the program is looked for the
 * way that file would import it. A program that is not installed there comes back without a path.
 */
export function findBundled(from: string, program: { readonly package: string; readonly entry: string }): BundledProgram {
  const require = createRequire(from);
  let path: string;
  try {
    path = require.resolve(`${program.package}/${program.entry}`);
  } catch {
    return { package: program.package };
  }
  let version: string | undefined;
  try {
    version = manifestVersion(JSON.parse(readFileSync(require.resolve(`${program.package}/package.json`), "utf8")));
  } catch {
    // A package that does not let its manifest be read has no version to say.
  }
  return version === undefined ? { package: program.package, path } : { package: program.package, path, version };
}
