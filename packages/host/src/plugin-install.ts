/**
 * Installing a plugin from a file: `plugin.install@<name>`.
 *
 * One core action for the install and the replacement of a plugin module. The target of a call is
 * the name of the plugin, so a grant can limit who may install which plugin (`plugin.install@rin/*`),
 * and the file is pinned by its hash: the call may name the hash the file is expected to have, and
 * the hash that was installed is written down.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { action, CORE_TYPES, NotSent, recordId, seq } from "@niwa-labs/core";
import { PLUGIN_INSTALL, PLUGIN_UNINSTALL, pluginName } from "@niwa-labs/plugin";
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

/** The currently installed modules, in their original registration order. */
export function currentInstallations(journal: JournalReader): Map<string, PluginInstallation> {
  const current = new Map<string, PluginInstallation>();
  for (const row of journal.since(seq(0), [CORE_TYPES.pluginInstalled, CORE_TYPES.pluginUninstalled])) {
    if (row.type === CORE_TYPES.pluginInstalled) {
      const data = PluginInstalledData.safeParse(row.data);
      if (data.success) current.set(data.data.plugin, data.data);
    } else {
      const data = UninstallInput.safeParse(row.data);
      if (data.success) current.delete(data.data.plugin);
    }
  }
  return current;
}

/** What a plugin is installed from now, if it was installed from a file. */
export function installationOf(journal: JournalReader, plugin: string): PluginInstallation | undefined {
  return currentInstallations(journal).get(plugin);
}

function keptCopies(journal: JournalReader): Set<string> {
  return new Set([...currentInstallations(journal).values()].map((one) => copyPathOf(one.module, one.hash)));
}

/** Remove the copy an installation was made from, unless a current installation is made from it too. */
export async function removeCopyIfStale(journal: JournalReader, installation: PluginInstallation): Promise<void> {
  const copy = copyPathOf(installation.module, installation.hash);
  if (!keptCopies(journal).has(copy)) await removeCopy(copy);
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
  const kept = keptCopies(journal);
  for (const dir of new Set(installations.map((one) => dirname(one.module)))) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      const path = join(dir, name);
      if (COPY_NAME.test(name) && !kept.has(path)) await removeCopy(path);
    }
  }
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
    throw new NotSent(`${module} is not the file that was approved: it is ${hash}, the call has ${expected}`);
  }
  const copy = copyPathOf(path, hash);
  const existing = await readCopy(copy, hash);
  if (existing === undefined) {
    // Written aside and renamed in: a load at the same time never imports half a file.
    const aside = `${copy}.${crypto.randomUUID()}`;
    try {
      await writeFile(aside, bytes);
      await rename(aside, copy);
    } finally {
      await rm(aside, { force: true });
    }
  }
  return { plugin: await importPlugin(copy), hash };
}

async function importPlugin(file: string): Promise<Plugin> {
  const loaded: { default?: unknown } = await import(file);
  return PluginValue.parse(loaded.default);
}

/** Restore the installed bytes even when the original has been edited or removed. */
export async function restorePlugin(installation: PluginInstallation): Promise<Plugin> {
  const { plugin, module, hash } = installation;
  const copy = copyPathOf(module, hash);
  const bytes = await readCopy(copy, hash);
  const restored = bytes === undefined ? (await loadPluginModule(module, hash)).plugin : await importPlugin(copy);
  if (restored.name !== plugin) throw new Error(`the installed file for "${plugin}" exports a different plugin`);
  return restored;
}

async function readCopy(copy: string, hash: string): Promise<Buffer | undefined> {
  const bytes = await readFile(copy).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (bytes !== undefined && createHash("sha256").update(bytes).digest("hex") !== hash) {
    throw new Error(`plugin copy "${copy}" does not match its expected hash`);
  }
  return bytes;
}

/** What the action needs from the host. */
export interface PluginInstallDeps {
  install(caller: Caller, plugin: Plugin, data: Omit<PluginInstallation, "version">, id: ReturnType<typeof recordId>): Promise<void>;
  recorded(id: ReturnType<typeof recordId>): PluginInstallation | undefined;
  check(plugin: string): void;
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
      const id = recordId(`${ctx.operationId}/installed`);
      const done = deps.recorded(id);
      if (done !== undefined) return done;
      const named = pluginName(input.plugin);
      deps.check(named);
      const loaded = await loadPluginModule(input.module, input.hash);
      if (loaded.plugin.name !== named) {
        throw new Error(`${input.module} exports the plugin "${loaded.plugin.name}", not "${named}"`);
      }
      const module = isAbsolute(input.module) ? input.module : resolve(process.cwd(), input.module);
      await deps.install(ctx.caller, loaded.plugin, { plugin: named, module, hash: loaded.hash }, id);
      return { plugin: named, version: loaded.plugin.version, hash: loaded.hash };
    },
  });
}

const UninstallInput = z.object({ plugin: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) });

export function pluginUninstallAction(
  journal: () => JournalReader,
  remove: (caller: Caller, installation: PluginInstallation, id: ReturnType<typeof recordId>) => Promise<void>,
) {
  return action(PLUGIN_UNINSTALL, {
    description: "Uninstalls a module-installed plugin at its current hash. Only the owner can uninstall.",
    input: UninstallInput,
    output: UninstallInput,
    recovery: "repeat",
    effect: "write",
    world: "local",
    target: (input) => input.plugin,
    async run(input, ctx) {
      if (ctx.caller.kind !== "client" || ctx.caller.principal?.kind !== "owner") throw new Error("only the owner can uninstall a plugin");
      const name = pluginName(input.plugin);
      const id = recordId(`${ctx.operationId}/uninstalled`);
      const log = journal();
      if (log.get(id) !== undefined) return input;
      const installation = installationOf(log, name);
      if (installation === undefined) throw new Error(`"${name}" is not installed from a module`);
      if (installation.hash !== input.hash) throw new Error(`"${name}" no longer has the selected hash`);
      await remove(ctx.caller, installation, id);
      return input;
    },
  });
}
