/**
 * The registry the cockpit is built from: the pages, slots and entity kinds its modules added.
 *
 * Each module registers into a draft of its own during setup. Assembling the drafts decides
 * conflicts in load order — the module loaded first keeps a path, a slot name, an entity kind
 * or a single slot — and leaves out a module whole when anything it registered cannot be
 * accepted, so no module is ever half installed. Leaving a module out can strand contributions
 * to the slots it declared, so assembly repeats until every remaining module fits.
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
import { pathProblem, pathShape } from "./paths.ts";

export type RegisteredPage = {
  plugin: string;
  path: string;
  title: string;
  component: ComponentType<PageProps>;
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
        draft.pages.push({
          plugin,
          path: page.path,
          title: page.title,
          component: page.component as ComponentType<PageProps>,
          nav: page.nav,
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
        if (spec.prefix !== undefined && !ENTITY_KIND.test(spec.prefix)) {
          throw new RegistrationError(`the id prefix of ${kind} is a lowercase word: "${spec.prefix}"`);
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

type Built = { registry: CockpitRegistry; rejected: PluginFault[] };

function build(base: ReadonlyArray<{ name: string; kind: SlotKind }>, drafts: readonly PluginDraft[]): Built {
  const rejected: PluginFault[] = [];
  const slots = new Map<string, { kind: SlotKind; owner: string }>(base.map((s) => [s.name, { kind: s.kind, owner: "cockpit" }]));
  const entities = new Map<string, RegisteredEntity>();
  const prefixes = new Map<string, string>();
  const shapes = new Map<string, string>();
  const pages: RegisteredPage[] = [];
  const accepted: PluginDraft[] = [];

  // First what modules own: slot names, entity kinds and their tab slots, page paths.
  for (const draft of drafts) {
    const reject = (place: string, message: string): void => {
      rejected.push({ plugin: draft.plugin, phase: "register", place, message });
    };
    const ownSlots = new Map<string, SlotKind>();
    const ownShapes = new Map<string, string>();
    const ownPrefixes = new Map<string, string>();
    let ok = true;
    const claimSlot = (name: string, kind: SlotKind): void => {
      const taken = slots.get(name)?.owner ?? (ownSlots.has(name) ? draft.plugin : undefined);
      if (taken !== undefined) {
        reject(name, `the slot ${name} is already declared by ${taken}`);
        ok = false;
      } else ownSlots.set(name, kind);
    };
    for (const d of draft.declarations) claimSlot(d.name, d.kind);
    const ownKinds = new Set<string>();
    for (const e of draft.entities) {
      const owner = entities.get(e.kind)?.plugin ?? (ownKinds.has(e.kind) ? draft.plugin : undefined);
      if (owner !== undefined) {
        reject(e.kind, `the entity kind ${e.kind} is already registered by ${owner}`);
        ok = false;
        continue;
      }
      ownKinds.add(e.kind);
      if (e.spec.prefix !== undefined) {
        const prefixOwner = prefixes.get(e.spec.prefix) ?? ownPrefixes.get(e.spec.prefix);
        if (prefixOwner !== undefined) {
          reject(e.kind, `the id prefix ${e.spec.prefix} already belongs to the entity kind ${prefixOwner}`);
          ok = false;
        } else ownPrefixes.set(e.spec.prefix, e.kind);
      }
      claimSlot(entityTabSlot(e.kind), "list");
    }
    for (const page of draft.pages) {
      const shape = pathShape(page.path);
      const owner = shapes.get(shape) ?? (ownShapes.has(shape) ? draft.plugin : undefined);
      if (owner !== undefined) {
        reject(page.path, `the path ${page.path} is already taken by ${owner}`);
        ok = false;
      } else ownShapes.set(shape, page.path);
    }
    if (!ok) continue;
    for (const [name, kind] of ownSlots) slots.set(name, { kind, owner: draft.plugin });
    for (const e of draft.entities) entities.set(e.kind, { ...e.spec, kind: e.kind, plugin: draft.plugin });
    for (const [prefix, kind] of ownPrefixes) prefixes.set(prefix, kind);
    for (const shape of ownShapes.keys()) shapes.set(shape, draft.plugin);
    pages.push(...draft.pages);
    accepted.push(draft);
  }

  // Then what modules contribute, against the slots that exist now.
  const filled = new Map<string, RegisteredContribution[]>();
  for (const draft of accepted) {
    const own = new Map<string, RegisteredContribution[]>();
    let fault: PluginFault | undefined;
    for (const { slot, contribution } of draft.contributions) {
      const declared = slots.get(slot);
      const existing = [...(filled.get(slot) ?? []), ...(own.get(slot) ?? [])];
      if (declared === undefined) {
        fault = { plugin: draft.plugin, phase: "register", place: slot, message: `no module declares the slot ${slot}` };
      } else if (declared.kind === "single" && existing.length > 0) {
        fault = { plugin: draft.plugin, phase: "register", place: slot, message: `the single slot ${slot} is already filled by ${existing[0]!.plugin}` };
      } else if (existing.some((c) => c.key === contribution.key)) {
        const other = existing.find((c) => c.key === contribution.key)!;
        fault = { plugin: draft.plugin, phase: "register", place: slot, message: `the key ${contribution.key} in ${slot} is already used by ${other.plugin}` };
      }
      if (fault !== undefined) break;
      own.set(slot, [...(own.get(slot) ?? []), { ...contribution, plugin: draft.plugin }]);
    }
    if (fault !== undefined) {
      rejected.push(fault);
      continue;
    }
    for (const [slot, list] of own) filled.set(slot, [...(filled.get(slot) ?? []), ...list]);
  }

  const plugins = accepted.map((d) => d.plugin).filter((id) => !rejected.some((f) => f.plugin === id));
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
      return entities.get(ref.kind)?.href(ref.id);
    },
  };

  const registry: CockpitRegistry = {
    plugins,
    pages,
    nav,
    entities: entityRegistry,
    slotKind: (name) => slots.get(name)?.kind,
    slot: <K extends SlotName>(name: K) => (filled.get(name) ?? []) as readonly RegisteredContribution<SlotPropsOf<K>>[],
  };
  return { registry, rejected };
}

/**
 * Assemble the drafts, in load order, over the slots the cockpit owns. A module that does not
 * fit is left out whole and reported; assembly repeats until the remaining modules all fit.
 */
export function assembleRegistry(
  base: ReadonlyArray<{ name: string; kind: SlotKind }>,
  drafts: readonly PluginDraft[],
): { registry: CockpitRegistry; faults: PluginFault[] } {
  const faults: PluginFault[] = [];
  let remaining = drafts;
  for (;;) {
    const { registry, rejected } = build(base, remaining);
    if (rejected.length === 0) return { registry, faults };
    faults.push(...rejected);
    const out = new Set(rejected.map((f) => f.plugin));
    remaining = remaining.filter((d) => !out.has(d.plugin));
  }
}

/** Run a module's setup into a draft. A setup that throws yields a fault and no draft. */
export async function runSetup(
  plugin: { id: string; setup: (ctx: PluginContext) => void | Promise<void> },
  services: Services,
): Promise<{ draft: PluginDraft } | { fault: PluginFault }> {
  const { ctx, draft, close } = draftContext(plugin.id, services);
  try {
    await plugin.setup(ctx);
    return { draft };
  } catch (error) {
    return { fault: { plugin: plugin.id, phase: "setup", message: faultMessage(error), error } };
  } finally {
    close();
  }
}
