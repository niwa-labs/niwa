// A plugin: the unit the host installs, replaces and unloads.
//
// A plugin owns its name, its version and its registrations. The version is
// what pins work in flight to the code that started it: when a plugin is
// replaced, the host keeps the handlers of the earlier version under
// `${handlerId}@${version}`, so an invocation admitted on one version finishes
// on that version and new records are handled by the new one.
//
// The version is derived from the code by default: the setup source and the source of every
// handler it registers, wherever the handler is defined. Changed code is a new version, the same
// code after a restart is the same version. A plugin whose behavior changes without that text
// changing passes an explicit version.

import { actionName, CannotRemoveHandler } from "@niwa-labs/core";
import type { HandlerOptions, OfferKey, Plugin, PluginApi } from "./plugin-types.ts";
import type { Subscribable } from "./trigger.ts";
import type { Handler, PluginName, PluginVersion, RecordType } from "@niwa-labs/core";

/** The name of the action that installs a plugin from a file. */
export const PLUGIN_INSTALL = actionName("plugin.install");

/**
 * Plugin names: lowercase words joined by dashes (`night-digest`), grouped by `/` (`rin/memory`).
 *
 * The group is what a grant's `@target` can name (`plugin.install@rin/*`). The name is everything
 * before the last `/` of the handler id (`${pluginName}/${handlerName}`), so a handler name has no
 * `/`, and the name must be stable: the handler id is written into the journal and read back by
 * every later run.
 */
const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

/**
 * The name of a plugin. Constructed only here.
 *
 * @throws when the name cannot be part of a handler id.
 */
export function pluginName(name: string): PluginName {
  if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `plugin name "${String(name)}" must match ${PLUGIN_NAME_PATTERN.source}`,
    );
  }
  return name as PluginName;
}

/**
 * A point where plugins offer values that the plugin `reader` reads (`api.offer`, `api.offers`). Two keys
 * of one name are one point: the offering plugin makes its own key and need not import the reader.
 */
export function offerKey<T>(name: string, reader: string): OfferKey<T> {
  if (name.length === 0) throw new Error("an offer key has a name");
  return { kind: "offer", name, reader };
}

/**
 * The version of a plugin. Constructed only here.
 *
 * The version is compared for equality and written into the journal, so it is
 * an opaque non-empty string: `1.0.0`, `r3`, or the hash below.
 *
 * @throws when the version is empty.
 */
export function pluginVersion(version: string): PluginVersion {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("plugin version must not be empty");
  }
  return version as PluginVersion;
}

/** A hash of the code, so a version depends only on the code, not on the process or the time. */
function hashOfCode(parts: readonly string[]): PluginVersion {
  return pluginVersion(BigInt.asUintN(64, BigInt(Bun.hash(parts.join("\n\0\n")))).toString(16));
}

/**
 * The text of a handler as the version sees it: its id and its source. A handler defined outside
 * the setup function is not in the setup's text, so the host hands the handlers over when it runs
 * the setup (`sealVersion`).
 */
export function handlerSource(id: string, run: Handler<any>): string {
  return `${id}\n${run.toString()}`;
}

/**
 * The key of the method a plugin made by `plugin()` carries to finish its default version. It is
 * a registry symbol, so the host finds it on a plugin built by another copy of this package.
 */
export const SEAL_VERSION: unique symbol = Symbol.for("niwa.plugin.sealVersion") as never;

/**
 * Finish the default version of a plugin once its setup has run: it then covers the handlers too.
 *
 * A plugin with an explicit version, or one that was not made by `plugin()`, keeps its version.
 * Until the setup has run the version is the hash of the setup text alone.
 */
export function sealVersion(source: Plugin, handlers: readonly string[]): void {
  source[SEAL_VERSION]?.(handlers);
}

/**
 * What a setup function may be: one that returns nothing. A function that returns a promise, or one
 * that may (`void | Promise<void>`), is refused when the plugin is made, because the host runs the setup and goes on without waiting for
 * it, so everything an asynchronous setup declared after its first `await` would be lost.
 */
type SynchronousSetup<S extends (api: PluginApi) => unknown> =
  [Extract<ReturnType<S>, PromiseLike<unknown>>] extends [never] ? unknown : never;

/** Did the setup return a promise (or any thenable)? */
function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

interface PluginOptions {
  /**
   * The explicit version of the plugin. Default: a hash of the setup code and of
   * its handlers' code once the host has run the setup, so the same code always
   * carries the same version and changed code carries a new one.
   */
  version?: string;
}

/**
 * A plugin: a name, a version and a setup function that declares record types,
 * actions and handlers through the api it receives.
 *
 * The setup function is not called here. The host calls it when the plugin is
 * installed, so that a plugin can be created before the host exists and
 * installed later.
 *
 * @throws when the name is not a valid plugin name, when the version is empty,
 * or when there is no setup function.
 */
export function plugin<S extends (api: PluginApi) => void>(
  name: string,
  setup: S & SynchronousSetup<S>,
  opts?: PluginOptions,
): Plugin {
  if (typeof setup !== "function") {
    throw new Error(`plugin "${String(name)}" needs a setup function`);
  }
  const explicit = opts?.version === undefined ? undefined : pluginVersion(opts.version);
  let derived: PluginVersion | undefined;
  return {
    kind: "plugin",
    name: pluginName(name),
    get version() {
      return explicit ?? derived ?? hashOfCode([setup.toString()]);
    },
    setup,
    ...(explicit === undefined && {
      [SEAL_VERSION]: (handlers: readonly string[]) => {
        derived = hashOfCode([setup.toString(), ...handlers]);
      },
    }),
  };
}

/**
 * The plugin without one of its handlers: the same name, the same registrations, and a version
 * of its own, so installing it replaces the plugin and work in flight finishes on the old one.
 *
 * The handler is named as the plugin names it, by the id it gives it (or the name of the type).
 *
 * @throws {CannotRemoveHandler} when the plugin declares no handler of that name, or when that is
 * its only handler.
 */
export function withoutHandler(source: Plugin, handler: string): Plugin {
  return {
    kind: "plugin",
    name: source.name,
    // Read when asked: the version of the source is final only once its setup has run, and it is
    // the setup of this plugin that runs it (below).
    get version() {
      // The pair is hashed from its JSON text: whatever the handler is called, one pair has one text,
      // so "a" then "b" never meets a single handler named "a-without-b", and the version stays the
      // same length however many handlers were taken away one after another.
      return hashOfCode([JSON.stringify([source.version, "without", handler])]);
    },
    setup(api) {
      let removed = false;
      let kept = 0;
      const sources: string[] = [];
      const on = (
        type: Subscribable<any>,
        optsOrHandler: HandlerOptions<any> | Handler<any>,
        maybeHandler?: Handler<any>,
      ): void => {
        const [options, run]: [HandlerOptions<any>, Handler<any> | undefined] =
          typeof optsOrHandler === "function" ? [{}, optsOrHandler] : [optsOrHandler, maybeHandler];
        if (run === undefined) throw new TypeError(`a handler of "${type.name}" is missing`);
        const name = options.id ?? type.name;
        sources.push(handlerSource(name, run));
        if (name === handler) {
          removed = true;
          return;
        }
        kept += 1;
        api.on(type, options, run);
      };
      const returned: unknown = source.setup({ ...api, on });
      if (isThenable(returned)) {
        // What the promise does later is nobody's to see: it must not fail the process on its own.
        Promise.resolve(returned).catch(() => undefined);
        throw new TypeError(
          `plugin "${source.name}" has an asynchronous setup: a setup runs to its end before the plugin is installed, so it must not return a promise`,
        );
      }
      // The source's own version covers all its handlers, the removed one too: the same code has
      // the same version whether it is installed whole or without a handler.
      sealVersion(source, sources);
      if (!removed) throw new CannotRemoveHandler(source.name, handler, "unknown");
      if (kept === 0) throw new CannotRemoveHandler(source.name, handler, "last");
    },
  };
}
