/**
 * Where the script processes find their packages.
 *
 * The workflow module does not know the layout it is installed in. It asks package resolution: its
 * own root is the folder above this file, the packages it depends on are found from there the way
 * any import of its own is, and `node_modules` is the one that holds the packages niwa runs with.
 * A script process reads the child and the packages the child loads; a stored script finds the
 * packages it imports by name through a link to that `node_modules`.
 *
 * The script libraries (`@niwa-labs/flow`, `flow-code`, `flow-eval`) are dependencies of this package for
 * that reason alone: so they are in that `node_modules` and among what a box may read, wherever niwa is laid out.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of this package. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The module a script takes its types from: the file of the script package that imports nothing. */
export const SCRIPT_API = fileURLToPath(import.meta.resolve("@niwa-labs/script/api"));

/** The folder of the package `name`, as `from` resolves it; undefined when it is not installed. */
function packageRootOf(name: string, from: string): string | undefined {
  try {
    return dirname(Bun.resolveSync(`${name}/package.json`, from));
  } catch {
    // A package may keep its manifest out of its exports: its entry then leads to its folder.
  }
  let entry: string;
  try {
    entry = Bun.resolveSync(name, from);
  } catch {
    return undefined;
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === name) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The folders of the packages a package needs when it runs, and of the ones those need. */
function dependencyRoots(root: string, found: Set<string>): Set<string> {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const dependency = packageRootOf(name, root);
    if (dependency === undefined || found.has(dependency)) continue;
    found.add(dependency);
    dependencyRoots(dependency, found);
  }
  return found;
}

/**
 * The `node_modules` that holds the packages niwa runs with: the one an installation puts the script
 * package in, or, in a checkout that links every package from its own `node_modules`, the one of this package.
 */
export function modulesDir(): string | undefined {
  const marker = `${sep}node_modules${sep}`;
  const at = SCRIPT_API.indexOf(marker);
  const found = at < 0 ? join(PACKAGE_ROOT, "node_modules") : SCRIPT_API.slice(0, at + marker.length - 1);
  return existsSync(found) ? found : undefined;
}

let readable: string[] | undefined;

/** What a script process in a box may read: this package, the packages it loads, and the packages niwa runs with. */
export function readableRoots(): string[] {
  if (readable === undefined) {
    const modules = modulesDir();
    readable = [PACKAGE_ROOT, ...dependencyRoots(PACKAGE_ROOT, new Set()), ...(modules === undefined ? [] : [realpathSync(modules)])];
  }
  return readable;
}

/** The folder of the type declarations of bun and node that a check reads, when the package that holds them is installed. */
export function typeRoots(): string | undefined {
  const bun = packageRootOf("@types/bun", PACKAGE_ROOT);
  return bun === undefined ? undefined : dirname(bun);
}
