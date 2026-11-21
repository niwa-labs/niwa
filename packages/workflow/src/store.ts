/**
 * The code of the registered workflows, kept in the home of the host.
 *
 * A registration copies the source closure of its version — exactly the files whose hash is the version — under
 * `<home>/workflows/<wf-id>/<version>/`, laid out as they were relative to each other, so the relative imports
 * resolve in the copy as they did in the original. Next to the folder, `<version>.json` names the entry in it and
 * the file the version was registered from; it is written last, so a version is stored once it is there.
 *
 * The manifest is what the version is: the sha256 of every code file and of every data file of the copy, the
 * packages it imports by name with the version of each as it was found, and the script ABI it was registered
 * for. A start, a check and a run read the copy through it: a copy whose files are not the ones it names, or
 * one made for another ABI, is refused. A manifest that names only the entry is completed from the copy,
 * which is the version when its hash says so.
 *
 * What a registered version runs, is checked and resumed on is its copy: the file it was registered from may be
 * edited or deleted. A version is written once: the same version is the same folder, it is not written again.
 *
 * A script takes `z`, `workflow` and `niwa` as globals and its types from `@niwa-labs/script`, which the check maps
 * wherever the script is. A package it imports by name is found as the runtime and the check find any: in a
 * `node_modules` above the file. `<home>/workflows/node_modules` is a link to the packages niwa runs with, so a
 * copy finds the ones a script in niwa's own tree finds.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { SCRIPT_ABI } from "@niwa-labs/script";
import { z } from "zod";

import { modulesDir } from "./installation.ts";
import { closureOf, isCode, packageImportsOf, versionOf, versionOfClosure } from "./registry.ts";
import type { SourceClosure } from "./registry.ts";
import type { WorkflowId, WorkflowVersion } from "./records.ts";

/** The folder of the stored workflows in a home. */
export const WORKFLOWS_DIR = "workflows";

const Manifest = z.object({
  /** The entry of the script, relative to the folder of the version. */
  entry: z.string(),
  /** The file the version was registered from. */
  from: z.string(),
  /** The script ABI the version was registered for. */
  abi: z.number().int().positive(),
  /** The code files of the copy, by their path in it, with their sha256. */
  files: z.record(z.string(), z.string()),
  /** The data files the code imports, by their path in the copy, with their sha256. */
  data: z.record(z.string(), z.string()),
  /** The packages the code imports by name, with the version of each as it was found; null for one that was not. */
  imports: z.record(z.string(), z.string().nullable()),
});
type Manifest = z.infer<typeof Manifest>;

/** A manifest written before it said more than where the entry is. */
const EntryOnly = Manifest.pick({ entry: true, from: true });

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The version of the package a specifier names, as it is found from `from`; null when it is not found. */
function packageVersionOf(specifier: string, from: string): string | null {
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier);
  let entry: string;
  try {
    entry = Bun.resolveSync(specifier, from);
  } catch {
    return null;
  }
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const found = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
    if (found.name === name) return found.version ?? null;
  }
  return null;
}

/** The manifest of a closure laid out under `root`. */
function manifestOfClosure(closure: SourceClosure, root: string, from: string): Manifest {
  const files: Record<string, string> = {};
  const data: Record<string, string> = {};
  for (const [path, bytes] of [...closure.files].sort(([a], [b]) => a.localeCompare(b))) {
    (isCode(path) ? files : data)[relative(root, path)] = sha256(bytes);
  }
  const imports = Object.fromEntries(packageImportsOf(closure).map((specifier) => [specifier, packageVersionOf(specifier, closure.entry)]));
  return { entry: relative(root, closure.entry), from, abi: SCRIPT_ABI, files, data, imports };
}

function writeManifest(path: string, manifest: Manifest): void {
  const aside = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(aside, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(aside, path);
}

/**
 * The folder of the stored copies in a home. A box that runs a copy may read it: the copy finds the packages
 * it imports by name by looking for `node_modules` in the folders above it, up to the link in this one.
 */
export const workflowsDir = (home: string): string => join(home, WORKFLOWS_DIR);

/** Link `<home>/workflows/node_modules` to the packages niwa runs with, when it is not that link already. */
function linkPackages(home: string): void {
  const modules = modulesDir();
  if (modules === undefined) return;
  const target = realpathSync(modules);
  const link = join(workflowsDir(home), "node_modules");
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

/** A stored version read through its manifest: the entry of its copy, or why the copy does not run. */
export type StoredVersion = { entry: string } | { problem: string };

/**
 * The stored copy of a version as its manifest says it is: its entry, or why it is not what was registered.
 * Undefined when niwa holds no copy of it.
 */
export function storedVersion(home: string, id: WorkflowId, version: WorkflowVersion): StoredVersion | undefined {
  const path = manifestOf(home, id, version);
  if (!existsSync(path)) return undefined;
  const dir = versionDir(home, id, version);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  let manifest: Manifest;
  const full = Manifest.safeParse(raw);
  if (full.success) {
    manifest = full.data;
  } else {
    const { entry, from } = EntryOnly.parse(raw);
    const closure = closureOf(join(dir, entry));
    if (closure === undefined || versionOfClosure(closure) !== version) return { problem: `the copy of the version ${version} of ${id} is not that version: register it again` };
    manifest = manifestOfClosure(closure, dir, from);
    writeManifest(path, manifest);
  }
  if (manifest.abi !== SCRIPT_ABI) {
    return { problem: `the version ${version} of ${id} was registered for the script ABI ${String(manifest.abi)}, and niwa reads ${String(SCRIPT_ABI)}: register it again` };
  }
  for (const [file, hash] of [...Object.entries(manifest.files), ...Object.entries(manifest.data)]) {
    const at = join(dir, file);
    if (!existsSync(at) || sha256(readFileSync(at)) !== hash) {
      return { problem: `the copy of the version ${version} of ${id} changed: "${file}" is not the file it was registered with` };
    }
  }
  return { entry: join(dir, manifest.entry) };
}

/** The entry of the stored copy of a version, or undefined when niwa holds no copy of it that is the version. */
export function storedEntry(home: string, id: WorkflowId, version: WorkflowVersion): string | undefined {
  const stored = storedVersion(home, id, version);
  return stored !== undefined && "entry" in stored ? stored.entry : undefined;
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
  const known = storedVersion(home, id, version);
  if (known !== undefined) {
    if ("problem" in known) throw new Error(known.problem);
    return known.entry;
  }
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
  writeManifest(manifestOf(home, id, version), manifestOfClosure(closure, root, closure.entry));
  return join(dir, entry);
}
