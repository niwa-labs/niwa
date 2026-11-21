/**
 * The one way to say which records are wanted: a read of the history, a live continuation, a
 * wait and a subscription all take a `RecordQuery`.
 *
 * - `types`: exact names, or families written `prefix.*` (every type that begins `prefix.`).
 *   Absent means every type.
 * - `filter`: equality on fields of the data, by field name or dotted path (see `holds`).
 *   What equality cannot say — a prefix of an id, a field that is not empty — the consumer checks.
 * - `stream`: the stream the records belong to; every stream when absent.
 * - `from`: a position, exclusive: only records after it. The start of the journal when absent.
 *
 * The same query gives the same records wherever it is asked, so a snapshot followed by its live
 * continuation is one answer, not two that may disagree.
 */

import { z } from "zod";

import { holds } from "./filter.ts";
import { JsonValueSchema } from "./question.ts";
import type { RecordType, RecordTypeName, Seq, StoredRecord, StreamId } from "./types.ts";

/** A type name or a family: `task.done` is one type, `wf.*` is every type that begins `wf.`. */
export type TypeSelector = string;

/**
 * Whether a text is a type selector: a name without `*`, or a nonempty prefix ending `.*`. A
 * leading `!` is refused: a query keeps what it names, it has no negation.
 */
export function isTypeSelector(text: string): boolean {
  if (text.length === 0 || text.startsWith("!")) return false;
  if (text.endsWith(".*")) return text.length > 2 && !text.slice(0, -2).includes("*");
  return !text.includes("*");
}

/** Whether a selector names a family rather than one type. */
export function isFamily(selector: TypeSelector): boolean {
  return selector.endsWith(".*");
}

/** Does the selector select this type name? */
export function selects(selector: TypeSelector, name: string): boolean {
  return isFamily(selector) ? name.startsWith(selector.slice(0, -1)) : name === selector;
}

/** Do two selectors select a type in common: one name under the other's family, or two families that nest? */
export function overlaps(a: TypeSelector, b: TypeSelector): boolean {
  if (!isFamily(a)) return selects(b, a);
  if (!isFamily(b)) return selects(a, b);
  const pa = a.slice(0, -1);
  const pb = b.slice(0, -1);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** One type selector as it travels: checked, so a pattern of another language is refused, not read differently. */
export const TypeSelectorSchema = z
  .string()
  .min(1)
  .refine(isTypeSelector, { message: "a record type is an exact name or a family written prefix.*" });

/** The filter of a query as it travels: values for fields of the data, by field name or dotted path. */
export const DataFilterSchema = z.record(z.string().min(1), JsonValueSchema);
export type DataFilter = Readonly<Record<string, unknown>>;

/** A record query as it travels: on the wire, in an action's input, in a recorded wait. */
export const RecordQuerySchema = z.strictObject({
  /** Exact type names, or families written `prefix.*`. Every type when absent. */
  types: z.array(TypeSelectorSchema).optional(),
  /** Equality on fields of the data, by field name or dotted path. */
  filter: DataFilterSchema.optional(),
  /** The stream the records belong to. Every stream when absent. */
  stream: z.string().min(1).optional(),
  /** The position to read after, exclusive. The start of the journal when absent. */
  from: z.number().int().nonnegative().optional(),
});

/** The dotted paths into data: a field, or a field of a field, four levels deep at most. */
export type DataPath<D, Depth extends unknown[] = []> = Depth["length"] extends 4
  ? never
  : D extends readonly unknown[]
    ? never
    : D extends object
      ? { [K in keyof D & string]-?: K | `${K}.${DataPath<NonNullable<D[K]>, [...Depth, 0]>}` }[keyof D & string]
      : never;

/** The value at a dotted path into data. */
export type DataAt<D, P extends string> = D extends unknown
  ? P extends keyof D
    ? D[P]
    : P extends `${infer Head}.${infer Rest}`
      ? Head extends keyof D
        ? DataAt<NonNullable<D[Head]>, Rest>
        : never
      : never
  : never;

/**
 * The filter of a typed query: values for fields of the data, by field name or dotted path, each
 * of the type the data has there. Data of any shape takes any field.
 */
export type PathFilter<D> = unknown extends D ? DataFilter : { readonly [P in DataPath<D>]?: DataAt<D, P> };

/** What a query names a type by: a declared type, or its name (a family is a name). */
export type TypeOrName = RecordType<any> | string;

/**
 * Which records are wanted. `D` is the data of the types it names, so the filter is checked
 * against their fields.
 */
export interface RecordQuery<D = unknown> {
  readonly types?: readonly TypeOrName[];
  readonly filter?: PathFilter<D>;
  readonly stream?: StreamId | string;
  readonly from?: Seq | number;
}

/** A query with its types as names: what the journal and the wire take. */
export interface ResolvedQuery {
  readonly types?: readonly RecordTypeName[];
  readonly filter?: DataFilter;
  readonly stream?: StreamId;
  readonly from?: Seq;
}

/** The name a query gives a type by. */
function nameOf(type: TypeOrName): RecordTypeName {
  return (typeof type === "string" ? type : type.name) as RecordTypeName;
}

/**
 * The query with its types as names, each checked: a pattern that is neither a name nor a family is
 * refused here, so no consumer reads it its own way.
 */
export function resolveQuery(query: RecordQuery<any> | undefined): ResolvedQuery {
  if (query === undefined) return {};
  const types = query.types?.map(nameOf);
  for (const name of types ?? []) {
    if (!isTypeSelector(name)) {
      throw new TypeError(`"${name}" is not a record type: a type is an exact name or a family written prefix.*`);
    }
  }
  const from = query.from;
  if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
    throw new TypeError(`the position of a query is a whole number from 0, got ${String(from)}`);
  }
  return {
    ...(types === undefined ? {} : { types }),
    ...(query.filter === undefined ? {} : { filter: query.filter as DataFilter }),
    ...(query.stream === undefined ? {} : { stream: query.stream as StreamId }),
    ...(from === undefined ? {} : { from: from as Seq }),
  };
}

/** Does the query select the type of this name? A query that names no types selects every one. */
export function selectsType(query: Pick<ResolvedQuery, "types">, name: string): boolean {
  return query.types === undefined || query.types.length === 0 || query.types.some((selector) => selects(selector, name));
}

/** Does the record answer the query: after its position, of a type it selects, on its stream, with the data its filter holds? */
export function matchesQuery(query: ResolvedQuery, record: StoredRecord): boolean {
  if (query.from !== undefined && record.seq <= query.from) return false;
  if (!selectsType(query, record.type)) return false;
  if (query.stream !== undefined && record.stream !== query.stream) return false;
  return holds(record.data, query.filter);
}
