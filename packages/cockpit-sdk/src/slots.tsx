/** Rendering slots, pages and entity links, each module's part inside its own boundary. */

import { IdChip } from "@niwa-labs/ui-kit";
import { Fragment, type ComponentType, type ReactNode } from "react";

import { PluginBoundary } from "./boundary.tsx";
import type { EntityRef, SlotName, SlotPropsOf } from "./contract.ts";
import type { SearchParams } from "./paths.ts";
import type { RegisteredContribution, RegisteredPage } from "./registry.ts";
import { useCockpit, useRegistry } from "./runtime.tsx";

/** A slot whose props are all optional may be rendered without them. */
type PropsArg<K extends SlotName> = Record<never, never> extends SlotPropsOf<K> ? { props?: SlotPropsOf<K> } : { props: SlotPropsOf<K> };

/** The contributions to a slot, for a layout of the caller's own such as tabs. */
export function useSlot<K extends SlotName>(name: K): readonly RegisteredContribution<SlotPropsOf<K>>[] {
  return useRegistry().slot(name);
}

/** One contribution, inside its module's boundary. */
export function SlotPart<P extends object>({ place, contribution, props }: { place: string; contribution: RegisteredContribution<P>; props: P }) {
  const Part = contribution.component as ComponentType<P>;
  return (
    <PluginBoundary plugin={contribution.plugin} place={place}>
      <Part {...props} />
    </PluginBoundary>
  );
}

export type SlotProps<K extends SlotName> = { name: K } & PropsArg<K> & {
  /** Wraps each part, e.g. in a card; the part is already inside its boundary. */
  wrap?: ((part: ReactNode, contribution: RegisteredContribution<SlotPropsOf<K>>) => ReactNode) | undefined;
  /** Shown when nothing is contributed. */
  empty?: ReactNode;
};

/** Every contribution to a slot, in the slot's order. */
export function Slot<K extends SlotName>(props: SlotProps<K>) {
  const parts = useSlot(props.name);
  if (parts.length === 0) return <>{props.empty}</>;
  const slotProps = (props.props ?? {}) as SlotPropsOf<K>;
  return (
    <>
      {parts.map((contribution) => {
        const part = <SlotPart place={props.name} contribution={contribution} props={slotProps} />;
        return (
          <Fragment key={`${contribution.plugin}:${contribution.key}`}>
            {props.wrap === undefined ? part : props.wrap(part, contribution)}
          </Fragment>
        );
      })}
    </>
  );
}

/** The contribution under one key of a keyed slot, or `fallback` when there is none. */
export function SlotItem<K extends SlotName>(props: { name: K; itemKey: string; fallback?: ReactNode } & PropsArg<K>) {
  const part = useSlot(props.name).find((c) => c.key === props.itemKey);
  if (part === undefined) return <>{props.fallback}</>;
  return <SlotPart place={`${props.name}#${props.itemKey}`} contribution={part} props={(props.props ?? {}) as SlotPropsOf<K>} />;
}

/** A registered page with its parameters, inside its module's boundary. */
export function PageView({ page, params, search }: { page: RegisteredPage; params: Readonly<Record<string, string>>; search: SearchParams }) {
  const Page = page.component;
  const resetKey = JSON.stringify([params, search]);
  return (
    <PluginBoundary plugin={page.plugin} place={page.path} resetKey={resetKey}>
      <Page params={params} search={search} />
    </PluginBoundary>
  );
}

/** The address of an entity's page, from a reference or a prefixed id. */
export function useEntityHref(entity: EntityRef | string): string | undefined {
  return useRegistry().entities.href(entity);
}

export type EntityLinkProps = {
  entity: EntityRef | string;
  label?: string | undefined;
  short?: boolean | undefined;
  className?: string | undefined;
};

/**
 * An entity as a chip that leads to its page: the kind's own chip when it registered one, else
 * the id chip. An id of no registered kind is shown as plain text.
 */
export function EntityLink({ entity, label, short, className }: EntityLinkProps) {
  const { registry, navigator } = useCockpit();
  const ref = typeof entity === "string" ? registry.entities.resolve(entity) : entity;
  const id = typeof entity === "string" ? entity : entity.id;
  const kind = ref === undefined ? undefined : registry.entities.get(ref.kind);
  const href = ref === undefined ? undefined : kind?.href(ref.id);
  if (kind?.chip !== undefined && href !== undefined) {
    const Chip = kind.chip;
    return (
      <PluginBoundary
        plugin={kind.plugin}
        place={`entity.${kind.kind}.chip`}
        fallback={() => (
          <IdChip id={id} label={label} short={short} className={className} href={href} onNavigate={() => navigator.navigate(href)} />
        )}
      >
        <Chip id={id} href={href} navigate={() => navigator.navigate(href)} label={label} short={short} className={className} />
      </PluginBoundary>
    );
  }
  return (
    <IdChip
      id={id}
      label={label}
      short={short}
      className={className}
      href={href}
      onNavigate={href === undefined ? undefined : () => navigator.navigate(href)}
    />
  );
}

/** A link to a cockpit page that navigates without reloading on a plain click. */
export function PageLink({ to, replace, className, children }: { to: string; replace?: boolean; className?: string; children?: ReactNode }) {
  const { navigator } = useCockpit();
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigator.navigate(to, { replace });
      }}
    >
      {children}
    </a>
  );
}
