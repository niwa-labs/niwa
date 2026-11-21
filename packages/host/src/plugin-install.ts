/**
 * Installing a plugin from a file: `plugin.install@<name>`.
 *
 * One core action for the install and the replacement of a plugin module. The target of a call is
 * the name of the plugin, so a grant can limit who may install which plugin (`plugin.install@rin/*`),
 * and the file is pinned by its hash: the call may name the hash the file is expected to have, and
 * the hash that was installed is written down.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { action, CORE_TYPES } from "@niwa-labs/core";
import { PLUGIN_INSTALL, pluginName } from "@niwa-labs/plugin";
import type { Action, Caller, JournalReader } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";

/** What was written down when a plugin was installed from a file. */
export const PluginInstalledData = z.object({
  plugin: z.string().min(1),
  version: z.string().min(1),
  /** The file the plugin came from, as an absolute path. */
  module: z.string().min(1),
  /** The hash of that file: a restart can install exactly this code. */
  hash: z.string().min(1),
});

/** One installation of a plugin from a file, as the journal holds it. */
export type PluginInstallation = z.infer<typeof PluginInstalledData>;

/** A plugin, as a module exports it. */
const PluginValue = z.custom<Plugin>(
  (value) => typeof value === "object" && value !== null && "kind" in value && value.kind === "plugin",
  { message: "a module that exports a plugin" },
);

/** The plugin a module exports and the hash of the file it came from. */
export interface LoadedPlugin {
  readonly plugin: Plugin;
  readonly hash: string;
}

/** The copy a module file is imported through: beside the file, named by its hash. */
function copyPathOf(module: string, hash: string): string {
  return join(dirname(module), `.${hash}${extname(module)}`);
}

/** The name of a copy, whatever its extension: a dot, the sha256 in hex, and the extension of the file. */
const COPY_NAME = /^\.[0-9a-f]{64}(\.[^.]*)?$/;

/** The installations the journal holds, oldest first; a record that is not one is not read. */
function installationsIn(journal: JournalReader): PluginInstallation[] {
  return journal.find({ type: CORE_TYPES.pluginInstalled }).flatMap((row) => {
    const read = PluginInstalledData.safeParse(row.data);
    return read.success ? [read.data] : [];
  });
}

/** Remove a copy; a copy that cannot be removed stays, and nothing else fails for it. */
async function removeCopy(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/** What each plugin is installed from now: the latest installation of its name. */
function currentOf(installations: readonly PluginInstallation[]): Map<string, PluginInstallation> {
  return new Map(installations.map((one) => [one.plugin, one]));
}

/** The copies the current installations are made from. */
function keptCopies(installations: readonly PluginInstallation[]): Set<string> {
  return new Set([...currentOf(installations).values()].map((one) => copyPathOf(one.module, one.hash)));
}

/** What a plugin is installed from now, if it was installed from a file. */
export function installationOf(journal: JournalReader, plugin: string): PluginInstallation | undefined {
  return currentOf(installationsIn(journal)).get(plugin);
}

/** Remove the copy an installation was made from, unless a current installation is made from it too. */
export async function removeCopyIfStale(journal: JournalReader, installation: PluginInstallation): Promise<void> {
  const copy = copyPathOf(installation.module, installation.hash);
  if (!keptCopies(installationsIn(journal)).has(copy)) await removeCopy(copy);
}

/**
 * Remove the copies no installation is made from any more.
 *
 * A host start looks beside every file a plugin was ever installed from, and takes away the copies
 * (`.<hash><ext>`) that the current installations do not name. A copy that is wanted again is made
 * again by the next load.
 */
export async function removeStaleCopies(journal: JournalReader): Promise<void> {
  const installations = installationsIn(journal);
  const kept = keptCopies(installations);
  for (const dir of new Set(installations.map((one) => dirname(one.module)))) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      const path = join(dir, name);
      if (COPY_NAME.test(name) && !kept.has(path)) await removeCopy(path);
    }
  }
}

/** Is there a file at this path? */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

/**
 * The plugin a module exports, with the hash of its file.
 *
 * The file is read once: the bytes that are hashed are the bytes that are imported, so a file that
 * changes between the two cannot be installed under the hash of another. The import is of a copy
 * addressed by that hash, beside the file so that its relative imports still resolve; Bun keeps a
 * module under its whole specifier, so the same path would also give the code it loaded the first
 * time. A relative path is taken from the working directory of the host.
 *
 * When a hash is expected, the bytes are checked against it first: a file that is not the approved
 * one is refused before a copy of it is written and before any of its code runs.
 */
export async function loadPluginModule(module: string, expected?: string): Promise<LoadedPlugin> {
  const path = isAbsolute(module) ? module : resolve(process.cwd(), module);
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (expected !== undefined && hash !== expected) {
    throw new Error(`${module} is not the file that was approved: it is ${hash}, the call has ${expected}`);
  }
  const copy = copyPathOf(path, hash);
  if (!(await exists(copy))) {
    // Written aside and renamed in: a load at the same time never imports half a file.
    const aside = `${copy}.${crypto.randomUUID()}`;
    try {
      await writeFile(aside, bytes);
      await rename(aside, copy);
    } finally {
      await rm(aside, { force: true });
    }
  }
  const loaded: { default?: unknown } = await import(copy);
  return { plugin: PluginValue.parse(loaded.default), hash };
}

/** What the action needs from the host. */
export interface PluginInstallDeps {
  /** Install the plugin, or replace the one of the same name. */
  install(plugin: Plugin): void;
  /**
   * Write down that a plugin was installed from a file, and take away what that made stale: the copy
   * of the file the plugin was installed from before, when nothing is made from it any more.
   */
  record(caller: Caller, data: PluginInstallation): Promise<void>;
}

const Input = z.object({
  /** The plugin the file is expected to export: the `@target` of the call. */
  plugin: z.string().min(1),
  /** The file that exports it. */
  module: z.string().min(1),
  /** The hash the file is expected to have: a file that changed since is refused. */
  hash: z.string().min(1).optional(),
});

const Output = z.object({ plugin: z.string(), version: z.string(), hash: z.string() });

/** The action `plugin.install`. */
export function pluginInstallAction(deps: PluginInstallDeps): Action<z.infer<typeof Input>, z.infer<typeof Output>> {
  return action(PLUGIN_INSTALL, {
    description:
      "Installs a plugin from a module file, or replaces the installed plugin of that name. The target is the plugin's name; the module has to export exactly that plugin, and, when a hash is given, to be the file with that hash.",
    input: Input,
    output: Output,
    recovery: "repeat",
    effect: "write",
    world: "local",
    target: (input) => input.plugin,
    async run(input, ctx) {
      const named = pluginName(input.plugin);
      const loaded = await loadPluginModule(input.module, input.hash);
      if (loaded.plugin.name !== named) {
        throw new Error(`${input.module} exports the plugin "${loaded.plugin.name}", not "${named}"`);
      }
      deps.install(loaded.plugin);
      const module = isAbsolute(input.module) ? input.module : resolve(process.cwd(), input.module);
      await deps.record(ctx.caller, { plugin: named, version: loaded.plugin.version, module, hash: loaded.hash });
      return { plugin: named, version: loaded.plugin.version, hash: loaded.hash };
    },
  });
}
