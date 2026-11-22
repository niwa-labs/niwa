/**
 * The registry the cockpit is built from: the pages, slots and entity kinds its modules added.
 *
 * Each module registers into a draft of its own during setup. Assembling the drafts decides
 * conflicts in load order — the module loaded first keeps a path, a slot name, an entity kind
 * or a single slot — and leaves out a module whole when anything it registered cannot be
 * accepted, so no module is ever half installed. Leaving a module out can free what it took and
 * strand contributions to the slots it declared, so assembly leaves out one module at a time,
 * the first in load order that does not fit, and starts again.
 */

import type { ComponentType } from "react";

import {
  entityTabSlot,
  faultMessage,
  type EntityRef,
  type EntitySpec,
  type NavEntry,
  type PageProps,
  type PageSpec,
  type PluginContext,
  type PluginFault,
  type SlotContribution,
  type SlotKind,
  type SlotName,
  type SlotPropsOf,
} from "./contract.ts";
import { isReserved, pathProblem, pathShape } from "./paths.ts";

export type RegisteredPage = {
  plugin: string;
  path: string;
  title: string;
  component: ComponentType<PageProps>;
  commandHeading?: boolean;
  commands?: PageSpec["commands"];
  panel?: boolean;
  nav: NavEntry | undefined;
};

export type RegisteredContribution<P extends object = object> = SlotContribution<P> & { plugin: string };

export type RegisteredEntity = EntitySpec & { kind: string; plugin: string };

export type NavItem = { path: string; label: string; order: number; plugin: string; icon: NavEntry["icon"] };

export interface EntityRegistry {
  kinds(): readonly RegisteredEntity[];
  get(kind: string): RegisteredEntity | undefined;
  /** The entity an id refers to, by its prefix; undefined when no registered kind has that prefix. */
  resolve(id: string): EntityRef | undefined;
  /** The address of an entity's page, from a reference or from a prefixed id. */
  href(entity: EntityRef | string): string | undefined;
}

export interface CockpitRegistry {
  /** The modules that were installed, in load order. */
  readonly plugins: readonly string[];
  readonly pages: readonly RegisteredPage[];
  /** The pages shown in the navigation, in order. */
  readonly nav: readonly NavItem[];
  readonly entities: EntityRegistry;
  /** The kind of a declared slot, or undefined when nobody declared it. */
  slotKind(name: string): SlotKind | undefined;
  /** The contributions to a slot: in order for a list, in load order otherwise. */
  slot<K extends SlotName>(name: K): readonly RegisteredContribution<SlotPropsOf<K>>[];
}

/** What one module registered during its setup. */
export type PluginDraft = {
  readonly plugin: string;
  readonly declarations: Array<{ name: string; kind: SlotKind }>;
  readonly pages: RegisteredPage[];
  readonly contributions: Array<{ slot: string; contribution: SlotContribution<object> }>;
  readonly entities: Array<{ kind: string; spec: EntitySpec }>;
};

const SLOT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const ENTITY_KIND = /^[a-z][a-z0-9-]*$/;
/** An id prefix is one word: ids are split at their first dash. */
const ID_PREFIX = /^[a-z][a-z0-9]*$/;
const NO_CONTRIBUTIONS: readonly RegisteredContribution[] = Object.freeze([]);
const SLOT_KINDS: ReadonlySet<string> = new Set(["single", "list", "keyed"]);

function isComponent(value: unknown): boolean {
  // A function component, a class, or an exotic component such as `memo` or `lazy`.
  return typeof value === "function" || (value !== null && typeof value === "object" && "$$typeof" in value);
}

/** Thrown by a context method when a module registers something invalid in itself. */
export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
}

export type Services = Pick<PluginContext, "viewer" | "host" | "records">;

/**
 * A context whose registrations go into a fresh draft. What can be checked without looking at
 * other modules is checked at once and thrown, so the module's setup fails where the mistake is.
 * `close` ends the setup: a registration after it throws.
 */
export function draftContext(plugin: string, services: Services): { ctx: PluginContext; draft: PluginDraft; close(): void } {
  const draft: PluginDraft = { plugin, declarations: [], pages: [], contributions: [], entities: [] };
  let open = true;
  const guard = (what: string): void => {
    if (!open) throw new RegistrationError(`${plugin} registered ${what} after its setup ended`);
  };

  const ctx: PluginContext = {
    plugin: { id: plugin },
    ...services,
    pages: {
      add(page: PageSpec<string>) {
        guard(`the page ${page.path}`);
        const problem = pathProblem(page.path);
        if (problem !== undefined) throw new RegistrationError(problem);
        if (typeof page.title !== "string" || page.title === "") throw new RegistrationError(`the page ${page.path} has no title`);
        if (!isComponent(page.component)) throw new RegistrationError(`the page ${page.path} has no component`);
        if (page.nav !== undefined && page.path.includes("$")) {
          throw new RegistrationError(`the page ${page.path} has parameters and cannot be in the navigation`);
        }
        draft.pages.push({
          plugin,
          path: page.path,
          title: page.title,
          component: page.component as ComponentType<PageProps>,
          nav: page.nav,
          ...(page.panel && { panel: true }),
          ...(page.commandHeading && { commandHeading: true }),
          ...(page.commands && { commands: page.commands }),
        });
      },
    },
    slots: {
      declare(name, kind) {
        guard(`the slot ${name}`);
        if (!SLOT_NAME.test(name)) throw new RegistrationError(`a slot name is dotted lowercase words: "${name}"`);
        if (!SLOT_KINDS.has(kind)) throw new RegistrationError(`the slot ${name} has an unknown kind "${kind}"`);
        draft.declarations.push({ name, kind });
      },
      register(name, contribution) {
        guard(`a contribution to ${name}`);
        if (typeof contribution.key !== "string" || contribution.key === "") {
          throw new RegistrationError(`a contribution to ${name} has no key`);
        }
        if (!isComponent(contribution.component)) {
          throw new RegistrationError(`the contribution ${contribution.key} to ${name} has no component`);
        }
        draft.contributions.push({ slot: name, contribution: contribution as SlotContribution<object> });
      },
    },
    entities: {
      register(kind, spec) {
        guard(`the entity kind ${kind}`);
        if (!ENTITY_KIND.test(kind)) throw new RegistrationError(`an entity kind is a lowercase word: "${kind}"`);
        if (spec.prefix !== undefined && !ID_PREFIX.test(spec.prefix)) {
          throw new RegistrationError(`the id prefix of ${kind} is one lowercase word without dashes: "${spec.prefix}"`);
        }
        if (typeof spec.href !== "function") throw new RegistrationError(`the entity kind ${kind} has no href`);
        draft.entities.push({ kind, spec });
      },
    },
  };
  return {
    ctx,
    draft,
    close: () => {
      open = false;
    },
  };
}

/**
 * A module that does not fit, and the module whose presence makes it not fit, if any: the
 * earlier holder of a path, slot, kind or key, or the owner of a slot it needs that was itself
 * left out in this round.
 */
type Misfit = { fault: PluginFault; holder: string | undefined };

type Built = { registry: CockpitRegistry; misfits: Misfit[] };

/** What the cockpit owns, which modules cannot take: its slots, and the paths of its own pages. */
export type Owned = {
  readonly slots: ReadonlyArray<{ name: string; kind: SlotKind }>;
  readonly paths?: readonly string[] | undefined;
};

function build(base: Owned, drafts: readonly PluginDraft[]): Built {
  const misfits: Misfit[] = [];
  const slots = new Map<string, { kind: SlotKind; owner: string }>(base.slots.map((s) => [s.name, { kind: s.kind, owner: "cockpit" }]));
  const entities = new Map<string, RegisteredEntity>();
  const prefixes = new Map<string, string>();
  const shapes = new Map<string, string>((base.paths ?? []).map((path) => [pathShape(path), "cockpit"]));
  const pages: RegisteredPage[] = [];
  const accepted: PluginDraft[] = [];
  const left: PluginDraft[] = [];

  // First what modules own: slot names, entity kinds and their tab slots, page paths.
  for (const draft of drafts) {
    let ok = true;
    const reject = (place: string, message: string, holder: string): void => {
      misfits.push({ fault: { plugin: draft.plugin, phase: "register", place, message }, holder });
      ok = false;
    };
    const ownSlots = new Map<string, SlotKind>();
    const ownShapes = new Map<string, string>();
    const ownPrefixes = new Map<string, string>();
    const claimSlot = (name: string, kind: SlotKind): void => {
      const taken = slots.get(name)?.owner ?? (ownSlots.has(name) ? draft.plugin : undefined);
      if (taken !== undefined) reject(name, `the slot ${name} is already declared by ${taken}`, taken);
      else ownSlots.set(name, kind);
    };
    for (const d of draft.declarations) claimSlot(d.name, d.kind);
    const ownKinds = new Set<string>();
    for (const e of draft.entities) {
      const owner = entities.get(e.kind)?.plugin ?? (ownKinds.has(e.kind) ? draft.plugin : undefined);
      if (owner !== undefined) {
        reject(e.kind, `the entity kind ${e.kind} is already registered by ${owner}`, owner);
        continue;
      }
      ownKinds.add(e.kind);
      if (e.spec.prefix !== undefined) {
        const prefixKind = prefixes.get(e.spec.prefix) ?? ownPrefixes.get(e.spec.prefix);
        if (prefixKind !== undefined) {
          const holder = entities.get(prefixKind)?.plugin ?? draft.plugin;
          reject(e.kind, `the id prefix ${e.spec.prefix} already belongs to the entity kind ${prefixKind}`, holder);
        } else ownPrefixes.set(e.spec.prefix, e.kind);
      }
      claimSlot(entityTabSlot(e.kind), "list");
    }
    for (const page of draft.pages) {
      const shape = pathShape(page.path);
      const owner = shapes.get(shape) ?? (ownShapes.has(shape) ? draft.plugin : undefined);
      if (owner !== undefined) reject(page.path, `the path ${page.path} is already taken by ${owner}`, owner);
      else if (isReserved(page.path)) reject(page.path, `the path ${page.path} belongs to the cockpit`, "cockpit");
      else ownShapes.set(shape, page.path);
    }
    if (!ok) {
      left.push(draft);
      continue;
    }
    for (const [name, kind] of ownSlots) slots.set(name, { kind, owner: draft.plugin });
    for (const e of draft.entities) entities.set(e.kind, { ...e.spec, kind: e.kind, plugin: draft.plugin });
    for (const [prefix, kind] of ownPrefixes) prefixes.set(prefix, kind);
    for (const shape of ownShapes.keys()) shapes.set(shape, draft.plugin);
    pages.push(...draft.pages);
    accepted.push(draft);
  }

  /** The module left out in this round that would have declared the slot. */
  const lostOwner = (slot: string): string | undefined =>
    left.find((d) => d.declarations.some((x) => x.name === slot) || d.entities.some((x) => entityTabSlot(x.kind) === slot))?.plugin;

  // Then what modules contribute, against the slots that exist now.
  const filled = new Map<string, RegisteredContribution[]>();
  for (const draft of accepted) {
    const own = new Map<string, RegisteredContribution[]>();
    let misfit: Misfit | undefined;
    for (const { slot, contribution } of draft.contributions) {
      const declared = slots.get(slot);
      const existing = [...(filled.get(slot) ?? []), ...(own.get(slot) ?? [])];
      const fault = (message: string, holder: string | undefined): Misfit => ({
        fault: { plugin: draft.plugin, phase: "register", place: slot, message },
        holder,
      });
      // Keys of a keyed slot are what it is looked up by, so they are unique across modules;
      // elsewhere a key only has to be unique within its module.
      const clash = existing.find((c) => c.key === contribution.key && (declared?.kind === "keyed" || c.plugin === draft.plugin));
      if (declared === undefined) {
        misfit = fault(`no module declares the slot ${slot}`, lostOwner(slot));
      } else if (declared.kind === "single" && existing.length > 0) {
        misfit = fault(`the single slot ${slot} is already filled by ${existing[0]!.plugin}`, existing[0]!.plugin);
      } else if (clash !== undefined) {
        misfit = fault(`the key ${contribution.key} in ${slot} is already used by ${clash.plugin}`, clash.plugin);
      }
      if (misfit !== undefined) break;
      own.set(slot, [...(own.get(slot) ?? []), { ...contribution, plugin: draft.plugin }]);
    }
    if (misfit !== undefined) {
      misfits.push(misfit);
      continue;
    }
    for (const [slot, list] of own) filled.set(slot, [...(filled.get(slot) ?? []), ...list]);
  }

  const plugins = accepted.map((d) => d.plugin).filter((id) => !misfits.some((m) => m.fault.plugin === id));
  for (const [slot, list] of filled) {
    if (slots.get(slot)?.kind === "list") {
      // A stable sort: equal orders keep load order.
      filled.set(slot, [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    }
  }

  const nav = pages
    .filter((p) => p.nav !== undefined)
    .map((p, index) => ({ page: p, index }))
    .sort((a, b) => (a.page.nav!.order ?? 0) - (b.page.nav!.order ?? 0) || a.index - b.index)
    .map(({ page }) => ({
      path: page.path,
      label: page.nav!.label ?? page.title,
      order: page.nav!.order ?? 0,
      plugin: page.plugin,
      icon: page.nav!.icon,
    }));

  const entityRegistry: EntityRegistry = {
    kinds: () => [...entities.values()],
    get: (kind) => entities.get(kind),
    resolve(id) {
      const dash = id.indexOf("-");
      if (dash <= 0) return undefined;
      const kind = prefixes.get(id.slice(0, dash));
      return kind === undefined ? undefined : { kind, id };
    },
    href(entity) {
      const ref = typeof entity === "string" ? entityRegistry.resolve(entity) : entity;
      if (ref === undefined) return undefined;
      const kind = entities.get(ref.kind);
      try {
        return kind?.href(ref.id);
      } catch (error) {
        // A module's own code: a link it cannot build is no link, not a broken page.
        console.error(`niwa cockpit: ${kind?.plugin} could not link ${ref.kind} ${ref.id}`, error);
        return undefined;
      }
    },
  };

  const registry: CockpitRegistry = {
    plugins,
    pages,
    nav,
    entities: entityRegistry,
    slotKind: (name) => slots.get(name)?.kind,
    slot: <K extends SlotName>(name: K) => (filled.get(name) ?? NO_CONTRIBUTIONS) as readonly RegisteredContribution<SlotPropsOf<K>>[],
  };
  return { registry, misfits };
}

/**
 * Assemble the drafts, in load order, over what the cockpit owns. A module that does not fit is
 * left out whole and reported, and assembly starts again without it.
 *
 * Each round leaves out one module: the first in load order whose misfit is certain — caused by
 * nothing, by the cockpit, by itself, or by a module that fits. A module that only clashes with
 * a module that is itself about to go, or needs a slot of one, waits: it may fit once that one
 * is gone. When every misfit waits on another, the first in load order goes.
 *
 * A module left out early may have lost only to modules that were left out after it, so the
 * ones left out are offered again, in load order, and kept when everything still fits; a module
 * that comes back may be what another one needed, so they are offered again until none comes back.
 */
export function assembleRegistry(
  owned: Owned | ReadonlyArray<{ name: string; kind: SlotKind }>,
  drafts: readonly PluginDraft[],
): { registry: CockpitRegistry; faults: PluginFault[] } {
  const base: Owned = "slots" in owned ? owned : { slots: owned };
  const faults: PluginFault[] = [];
  let remaining = drafts;
  for (;;) {
    const { registry, misfits } = build(base, remaining);
    if (misfits.length === 0) return readmit(base, drafts, remaining, registry, faults);
    const failing = new Set(misfits.map((m) => m.fault.plugin));
    const certain = misfits.filter(
      (m) => m.holder === undefined || m.holder === m.fault.plugin || !failing.has(m.holder),
    );
    const order = new Map(remaining.map((d, index) => [d.plugin, index]));
    const pool = certain.length > 0 ? certain : misfits;
    const first = pool.reduce((a, b) => (order.get(b.fault.plugin)! < order.get(a.fault.plugin)! ? b : a));
    faults.push(first.fault);
    remaining = remaining.filter((d) => d.plugin !== first.fault.plugin);
  }
}

function readmit(
  base: Owned,
  drafts: readonly PluginDraft[],
  kept: readonly PluginDraft[],
  registry: CockpitRegistry,
  faults: PluginFault[],
): { registry: CockpitRegistry; faults: PluginFault[] } {
  let inside = new Set(kept);
  let current = registry;
  let left = faults;
  for (let changed = true; changed; ) {
    changed = false;
    for (const draft of drafts) {
      if (inside.has(draft)) continue;
      const trial = drafts.filter((d) => inside.has(d) || d === draft);
      const built = build(base, trial);
      if (built.misfits.length > 0) continue;
      inside = new Set(trial);
      current = built.registry;
      left = left.filter((f) => f.plugin !== draft.plugin);
      changed = true;
    }
  }
  // A module may have been left out for a slot nobody declared because its owner was out at the
  // time; the owner is back, so that is no longer what is wrong. Say what is: the module comes
  // last, so the modules that stayed keep what they hold.
  left = left.map((fault) => {
    if (fault.place === undefined || current.slotKind(fault.place) === undefined) return fault;
    const draft = drafts.find((d) => d.plugin === fault.plugin && !inside.has(d));
    if (draft === undefined) return fault;
    const now = build(base, [...drafts.filter((d) => inside.has(d)), draft]).misfits.find((m) => m.fault.plugin === fault.plugin);
    return now?.fault ?? fault;
  });
  return { registry: current, faults: left };
}

/** Run a module's setup into a draft. A setup that throws yields a fault and no draft. */
export async function runSetup(
  plugin: { id: string; setup: (ctx: PluginContext) => void | Promise<void> },
  services: Services,
  /** Bounds the setup, e.g. with a deadline; the draft closes when it settles either way. */
  bound: (setup: Promise<void>) => Promise<void> = (setup) => setup,
): Promise<{ draft: PluginDraft } | { fault: PluginFault }> {
  const { ctx, draft, close } = draftContext(plugin.id, services);
  try {
    await bound(Promise.resolve().then(() => plugin.setup(ctx)));
    return { draft };
  } catch (error) {
    return { fault: { plugin: plugin.id, phase: "setup", message: faultMessage(error), error } };
  } finally {
    close();
  }
}
