/**
 * The contract between the cockpit and the modules it loads.
 *
 * A module's default export is a plugin made with `definePlugin`. Before the cockpit builds its
 * routes it runs every plugin's `setup`, which adds pages, declares and fills slots, and
 * registers entity kinds. Every module is trusted: it runs in the cockpit's own document with
 * the same React, the same SDK and the same rights as the cockpit itself.
 */

import type { ComponentType } from "react";

import type { HostClient } from "./host-client.ts";
import type { PathParams, SearchParams } from "./paths.ts";
import type { StoredRecord } from "./records.ts";
import type { RecordFeed } from "./record-stream.ts";

// ---------------------------------------------------------------------------------------------
// Who is looking

/** The person or client the cockpit acts for, and what it may call. */
export type Viewer = {
  /** The id the host knows this client by. */
  readonly id: string;
  /** The viewer speaks for the owner. */
  readonly owner: boolean;
  /** The actions the viewer may call through the web server. */
  readonly actions: ReadonlySet<string>;
  /** Whether the viewer may call an action, by name or by reference. */
  can(action: string | { readonly name: string }): boolean;
};

export function createViewer(spec: { id: string; owner: boolean; actions: Iterable<string> }): Viewer {
  const actions: ReadonlySet<string> = new Set(spec.actions);
  return {
    id: spec.id,
    owner: spec.owner,
    actions,
    can: (action) => actions.has(typeof action === "string" ? action : action.name),
  };
}

// ---------------------------------------------------------------------------------------------
// Pages

/**
 * What a page receives. The query is given as strings, as written in the address; the cockpit
 * does not turn `?n=1` into a number, the page parses what it needs.
 */
export type PageProps<P extends string = string> = {
  params: PathParams<P>;
  search: SearchParams;
};

export type NavEntry = {
  /** The label in the navigation; the page title by default. */
  label?: string | undefined;
  /** Lower comes first. */
  order?: number | undefined;
  icon?: ComponentType<{ className?: string }> | undefined;
};

export type PageSpec<P extends string = string> = {
  /** The path pattern, with `$name` parameters: `/runs/$runId`. */
  path: P;
  title: string;
  component: ComponentType<PageProps<P>>;
  /** Open above the referring list. A direct URL still opens as its own page. */
  panel?: boolean;
  /** Render the registered page title together with its available commands. */
  commandHeading?: boolean;
  commands?: readonly import("./commands.tsx").PageCommand[] | ((props: PageProps<P>) => readonly import("./commands.tsx").PageCommand[]);
  /** Show the page in the navigation. Pages with parameters are reached by links instead. */
  nav?: NavEntry | undefined;
};

// ---------------------------------------------------------------------------------------------
// Slots

/**
 * How a slot holds its contributions.
 *
 * - `single`: one contribution at most; a second is a conflict.
 * - `list`: any number, shown in `order`, then in load order.
 * - `keyed`: looked up by key, e.g. the view of a record type; a repeated key is a conflict.
 */
export type SlotKind = "single" | "list" | "keyed";

/** What a slot is: its kind and the props its owner passes to every contribution. */
export type SlotSpec<K extends SlotKind = SlotKind, P extends object = object> = { kind: K; props: P };

export interface HomeTileProps {
  project?: string | undefined;
  reportProjects?: (directories: readonly string[]) => void;
}

/**
 * The slots and their props, by name. The cockpit's own slots are listed here; a module that
 * owns a place declares its slot at setup and adds it to this interface:
 *
 * ```ts
 * declare module "@niwa-labs/cockpit-sdk" {
 *   interface SlotMap {
 *     "rin.panel": SlotSpec<"list", { agent: string }>;
 *   }
 * }
 * ```
 */
export interface SlotMap {
  /** Tiles on the home page. */
  "home.tile": SlotSpec<"list", HomeTileProps>;
  "home.main": SlotSpec<"list", HomeTileProps>;
  "home.summary": SlotSpec<"list", HomeTileProps>;
  /** Small items in the status bar of the frame. */
  "shell.status": SlotSpec<"list", Record<never, never>>;
  /** How a record is shown in the journal, keyed by record type name. */
  "record.view": SlotSpec<"keyed", { record: StoredRecord }>;
  /** Tabs on the page of an entity, e.g. `entity.session.tab`; declared with the entity kind. */
  [tab: `entity.${string}.tab`]: SlotSpec<"list", { id: string }>;
}

export type SlotName = keyof SlotMap & string;

export type SlotPropsOf<K extends SlotName> = SlotMap[K]["props"];

export type SlotContribution<P extends object = object> = {
  /** Unique within the slot. For a `keyed` slot it is the key the slot is looked up by. */
  key: string;
  component: ComponentType<P>;
  /** A title, for slots shown as tabs or sections. */
  title?: string | undefined;
  /** Lower comes first in a `list` slot. */
  order?: number | undefined;
};

/** The slots the cockpit itself owns. */
export const CORE_SLOTS: ReadonlyArray<{ name: SlotName; kind: SlotKind }> = [
  { name: "home.tile", kind: "list" },
  { name: "home.main", kind: "list" },
  { name: "home.summary", kind: "list" },
  { name: "shell.status", kind: "list" },
  { name: "record.view", kind: "keyed" },
];

/** The slot of tabs on the pages of an entity kind. */
export function entityTabSlot(kind: string): `entity.${string}.tab` {
  return `entity.${kind}.tab`;
}

// ---------------------------------------------------------------------------------------------
// Entities

/** A reference to an entity: a run, a session, a task, a request, or anything a module adds. */
export type EntityRef = { kind: string; id: string };

export type EntitySpec = {
  /** The name of the kind for people: "Run", "Session". */
  label: string;
  /**
   * The prefix of the kind's ids: ids written `<prefix>-<rest>` resolve to this kind. A kind
   * whose ids have no such prefix (a pull request `owner/repo#12`) is referred to explicitly
   * with an `EntityRef`.
   */
  prefix?: string | undefined;
  /** The address of an entity's page. */
  href: (id: string) => string;
  /** A chip of its own in place of the plain id chip. */
  chip?: ComponentType<EntityChipProps> | undefined;
  /** A short preview, for hover cards and lists. */
  card?: ComponentType<{ id: string }> | undefined;
};

/** What a kind's own chip receives: the link is resolved and navigation handled by the cockpit. */
export type EntityChipProps = {
  id: string;
  href: string;
  /** Navigate inside the cockpit; call it from a plain click instead of following the link. */
  navigate: () => void;
  label?: string | undefined;
  short?: boolean | undefined;
  className?: string | undefined;
};

// ---------------------------------------------------------------------------------------------
// The plugin

export interface PluginContext {
  readonly plugin: { readonly id: string };
  readonly viewer: Viewer;
  readonly host: HostClient;
  readonly records: RecordFeed;
  readonly pages: {
    add<P extends string>(page: PageSpec<P>): void;
  };
  readonly slots: {
    /** Own a place: other modules may contribute to it. */
    declare<K extends SlotName>(name: K, kind: SlotMap[K]["kind"]): void;
    /** Contribute to a declared slot. A slot nobody declares fails the module at load. */
    register<K extends SlotName>(name: K, contribution: SlotContribution<SlotPropsOf<K>>): void;
  };
  readonly entities: {
    register(kind: string, spec: EntitySpec): void;
  };
}

export type CockpitPlugin = {
  /** The module's id; the catalogue serves the module under the same id. */
  readonly id: string;
  /** Registers what the module adds. Runs once, before the cockpit builds its routes. */
  readonly setup: (ctx: PluginContext) => void | Promise<void>;
};

const PLUGIN = Symbol.for("niwa.cockpit.plugin");

/** Lowercase words joined by dashes or dots: `rin`, `sessions`, `git.forge`. */
export const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

export function definePlugin(plugin: CockpitPlugin): CockpitPlugin {
  if (!PLUGIN_ID.test(plugin.id)) throw new TypeError(`a plugin id must be lowercase words joined by - or .: "${plugin.id}"`);
  if (typeof plugin.setup !== "function") throw new TypeError(`the plugin ${plugin.id} has no setup function`);
  const defined = { id: plugin.id, setup: plugin.setup };
  Object.defineProperty(defined, PLUGIN, { value: true });
  return Object.freeze(defined);
}

export function isCockpitPlugin(value: unknown): value is CockpitPlugin {
  return value !== null && typeof value === "object" && (value as Record<symbol, unknown>)[PLUGIN] === true;
}

// ---------------------------------------------------------------------------------------------
// Faults

/**
 * Why a module, or one of its parts, is missing from the cockpit.
 *
 * - `load`: the module could not be imported or did not export a plugin.
 * - `setup`: its setup threw, or registered something invalid.
 * - `register`: what it registered conflicts with a module loaded before it, or contributes to
 *   a slot nobody declared. The module is left out whole.
 * - `render`: one of its components threw while rendering; the rest of the cockpit stays up.
 */
export type PluginFault = {
  plugin: string;
  phase: "load" | "setup" | "register" | "render";
  /** The slot, page or entity kind the fault is about. */
  place?: string | undefined;
  message: string;
  error?: unknown;
};

export function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
