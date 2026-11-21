/**
 * Loading the cockpit's modules: import each, run its setup, assemble the registry.
 *
 * Modules load independently. One that cannot be imported, exports no plugin, throws in setup
 * or conflicts with a module loaded before it is left out and reported; the others load. The
 * cockpit builds its routes from the registry this returns, so modules are never added later.
 */

import type { CockpitCatalogue } from "./catalogue.ts";
import { CORE_SLOTS, faultMessage, isCockpitPlugin, type PluginFault, type SlotKind } from "./contract.ts";
import { assembleRegistry, runSetup, type CockpitRegistry, type PluginDraft, type Services } from "./registry.ts";

/** A module to load: its id, and how to import it. Modules built into the cockpit use the same shape. */
export type PluginSource = {
  id: string;
  load: () => Promise<unknown>;
};

export type LoadResult = {
  registry: CockpitRegistry;
  faults: PluginFault[];
};

/** The catalogue's modules as sources, imported by their content-addressed entries. */
export function catalogueSources(
  catalogue: CockpitCatalogue,
  importModule: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
): PluginSource[] {
  return catalogue.modules.map((module) => ({ id: module.id, load: () => importModule(module.entry) }));
}

/** How long a module may take to import, and then to set up, before it is left out. */
export const DEFAULT_MODULE_TIMEOUT_MS = 10_000;

class Timeout extends Error {}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout(`${what} took longer than ${ms}ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export async function loadPlugins(
  sources: readonly PluginSource[],
  services: Services,
  options: {
    slots?: ReadonlyArray<{ name: string; kind: SlotKind }> | undefined;
    /** Per module, for the import and again for the setup; a module that takes longer is left out. */
    timeoutMs?: number | undefined;
  } = {},
): Promise<LoadResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS;
  const faults: PluginFault[] = [];
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    if (seen.has(source.id)) {
      faults.push({ plugin: source.id, phase: "load", message: `the module ${source.id} is listed twice` });
      return false;
    }
    seen.add(source.id);
    return true;
  });

  const outcomes = await Promise.all(
    unique.map(async (source): Promise<{ draft: PluginDraft } | { fault: PluginFault }> => {
      let loaded: unknown;
      try {
        loaded = await within(source.load(), timeoutMs, `importing ${source.id}`);
      } catch (error) {
        return { fault: { plugin: source.id, phase: "load", message: faultMessage(error), error } };
      }
      const plugin = (loaded as { default?: unknown } | null)?.default;
      if (!isCockpitPlugin(plugin)) {
        return { fault: { plugin: source.id, phase: "load", message: `the module ${source.id} does not export a plugin made with definePlugin` } };
      }
      if (plugin.id !== source.id) {
        return { fault: { plugin: source.id, phase: "load", message: `the module ${source.id} exports the plugin ${plugin.id}` } };
      }
      return runSetup(plugin, services, (setup) => within(setup, timeoutMs, `the setup of ${source.id}`));
    }),
  );

  const drafts: PluginDraft[] = [];
  for (const outcome of outcomes) {
    if ("fault" in outcome) faults.push(outcome.fault);
    else drafts.push(outcome.draft);
  }
  const assembled = assembleRegistry(options.slots ?? CORE_SLOTS, drafts);
  return { registry: assembled.registry, faults: [...faults, ...assembled.faults] };
}
