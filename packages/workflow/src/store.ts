/**
 * The code of the registered workflows, kept in the home of the host.
 *
 * A registration copies the source closure of its version — exactly the files whose hash is the version — under
 * `<home>/workflows/<wf-id>/<version>/`, laid out as they were relative to each other, so the relative imports
 * resolve in the copy as they did in the original. Next to the folder, `<version>.json` names the entry in it and
 * the file the version was registered from; it is written last, so a version is stored once it is there.
 *
 * What a registered version runs, is checked and resumed on is its copy: the file it was registered from may be
 * edited or deleted. A version is written once: the same version is the same folder, it is not written again.
 *
 * A script takes `z`, `workflow` and `niwa` as globals and its types from `@niwa-labs/script`, which the check maps
 * wherever the script is. A package it imports by name is found as the runtime and the check find any: in a
 * `node_modules` above the file. `<home>/workflows/node_modules` is a link to the packages niwa runs with, so a
 * copy finds the ones a script in niwa's own tree finds.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { z } from "zod";

import { modulesDir } from "./installation.ts";
import { closureOf, versionOf, versionOfClosure } from "./registry.ts";
import type { WorkflowId, WorkflowVersion } from "./records.ts";

/** The folder of the stored workflows in a home. */
export const WORKFLOWS_DIR = "workflows";

const Manifest = z.object({
  /** The entry of the script, relative to the folder of the version. */
  entry: z.string(),
  /** The file the version was registered from. */
  from: z.string(),
});

/** Link `<home>/workflows/node_modules` to the packages niwa runs with, when it is not that link already. */
function linkPackages(home: string): void {
  const modules = modulesDir();
  if (modules === undefined) return;
  const target = realpathSync(modules);
  const link = join(home, WORKFLOWS_DIR, "node_modules");
  const present = lstatSync(link, { throwIfNoEntry: false });
  if (present?.isSymbolicLink() === true && readlinkSync(link) === target) return;
  mkdirSync(dirname(link), { recursive: true });
  const aside = `${link}.tmp-${String(process.pid)}`;
  rmSync(aside, { force: true });
  symlinkSync(target, aside, "dir");
  renameSync(aside, link);
}

const versionDir = (home: string, id: WorkflowId, version: WorkflowVersion): string => join(home, WORKFLOWS_DIR, id, version);
const manifestOf = (home: string, id: WorkflowId, version: WorkflowVersion): string => join(home, WORKFLOWS_DIR, id, `${version}.json`);

/** The entry of the stored copy of a version, or undefined when niwa holds no copy of it. */
export function storedEntry(home: string, id: WorkflowId, version: WorkflowVersion): string | undefined {
  const manifest = manifestOf(home, id, version);
  if (!existsSync(manifest)) return undefined;
  return join(versionDir(home, id, version), Manifest.parse(JSON.parse(readFileSync(manifest, "utf8"))).entry);
}

/** The folder all the files of a closure are under. */
function commonRoot(paths: readonly string[]): string {
  const [first, ...rest] = paths.map((path) => dirname(path).split(sep));
  let common = first ?? [];
  for (const parts of rest) {
    let at = 0;
    while (at < common.length && at < parts.length && common[at] === parts[at]) at += 1;
    common = common.slice(0, at);
  }
  return common.join(sep) || sep;
}

/**
 * Keep the code of a version: copy the source closure of `file` into the home and answer the entry of the copy.
 * The closure must be the version (a script edited since its check is not stored); a version already stored is
 * left as it is.
 */
export function storeVersion(home: string, id: WorkflowId, version: WorkflowVersion, file: string): string {
  linkPackages(home);
  const known = storedEntry(home, id, version);
  if (known !== undefined) return known;
  const closure = closureOf(file);
  if (closure === undefined || versionOfClosure(closure) !== version) {
    throw new Error(`the script "${file}" changed while it was registered: register it again`);
  }
  const root = commonRoot([...closure.files.keys()]);
  const dir = versionDir(home, id, version);
  const entry = relative(root, closure.entry);
  if (!existsSync(dir)) {
    // The folder is written aside and moved in whole: a version is never half a copy.
    const aside = `${dir}.tmp-${String(process.pid)}-${String(Date.now())}`;
    for (const [path, bytes] of closure.files) {
      const target = join(aside, relative(root, path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (versionOf(join(aside, entry)) !== version) {
      rmSync(aside, { recursive: true, force: true });
      throw new Error(`the copy of "${file}" is not its version ${version}`);
    }
    try {
      renameSync(aside, dir);
    } catch (error) {
      rmSync(aside, { recursive: true, force: true });
      // Another registration of the same version moved its copy in first: it is the same code.
      if (!existsSync(dir)) throw error;
    }
  }
  const manifest = manifestOf(home, id, version);
  const aside = `${manifest}.tmp-${String(process.pid)}`;
  writeFileSync(aside, `${JSON.stringify({ entry, from: closure.entry } satisfies z.infer<typeof Manifest>, null, 2)}\n`);
  renameSync(aside, manifest);
  return join(dir, entry);
}
