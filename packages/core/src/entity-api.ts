/**
 * The shape every entity's `list` and `get` actions share.
 *
 * `list` takes no id and answers the general view: the ids and descriptions of what exists, so a caller
 * that lost its memory finds an entity again. `get` takes an id, or any text that names one id (a
 * unique prefix or suffix, the short form), and answers that one entity. A module declares both
 * with `listRef` and `getRef` and gets the same input, the same output wrapper and the same
 * description wording as every other module.
 */

import { z } from "zod";

import { actionRef } from "./action.ts";
import { idSchema } from "./ids.ts";
import type { Id, IdKind } from "./ids.ts";

/** A description is a few words a person reads in a list: not empty, not a wall, one line. */
export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 60;

export const EntityDescription = z
  .string()
  .trim()
  .min(DESCRIPTION_MIN)
  .max(DESCRIPTION_MAX)
  .regex(/^[^\r\n]*$/, "a description is one line")
  .brand<"EntityDescription">();
export type EntityDescription = z.infer<typeof EntityDescription>;

/** What a person typed to name one entity: an id, a unique prefix or suffix of it, or its short form. */
export const IdText = z.string().min(1).brand<"IdText">();
export type IdText = z.infer<typeof IdText>;

type Empty = Record<never, never>;

/** The fields a module did not name: none. `Empty` is the default of the shape a module may leave out. */
function shapeOrEmpty<S extends z.ZodRawShape>(shape: S | undefined): S {
  return shape ?? ({} as S);
}

/** The `list` action of a kind: no id, an optional filter of the module's own, the general view. */
export function listRef<K extends IdKind, Filter extends z.ZodRawShape = Empty, Item extends z.ZodRawShape = Empty>(
  name: `${string}.list`,
  spec: {
    readonly kind: K;
    /** What the entity is called in prose: "task", "workflow installation". */
    readonly noun: string;
    /** What `list` adds to the standard wording, such as what the filter does. */
    readonly detail?: string;
    readonly filter?: Filter;
    /** The module's fields of each entry, besides `id` and `description`. */
    readonly item?: Item;
  },
) {
  const filter = z.object(shapeOrEmpty(spec.filter));
  const item = z.object({ id: idSchema(spec.kind), description: EntityDescription }).extend(shapeOrEmpty(spec.item));
  return actionRef(name, {
    description: `List the ${spec.noun}s: the id and the description of each, and what else shows at a glance. Take an id from here to get one.${spec.detail === undefined ? "" : ` ${spec.detail}`}`,
    input: filter,
    output: z.object({ items: z.array(item) }),
  });
}

/** The `get` action of a kind: an id or any text that names one, and the whole entity, which carries its `id`. */
export function getRef<K extends IdKind, Entity extends { readonly id: Id<K> }>(
  name: `${string}.get`,
  spec: {
    readonly kind: K;
    /** What the entity is called in prose: "task", "workflow installation". */
    readonly noun: string;
    /** What `get` adds to the standard wording. */
    readonly detail?: string;
    readonly entity: z.ZodType<Entity>;
  },
) {
  return actionRef(name, {
    description: `Get one ${spec.noun}: its id or any text that names it, such as the start or the end of the id. A text that fits several is refused with the candidates.${spec.detail === undefined ? "" : ` ${spec.detail}`}`,
    input: z.object({ id: IdText }),
    output: spec.entity,
  });
}
