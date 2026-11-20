/**
 * The filter of a wait and of a subscription: equality on fields of a record's data.
 *
 * A name is a field of the data, or a dotted path into it (`task.id` is the field `id` of the
 * field `task`). A field that is itself named with a dot wins over the path.
 */

import { stableJson } from "./record.ts";

/** The value at a field name or a dotted path, `undefined` when there is none. */
function valueAt(fields: Record<string, unknown>, name: string): unknown {
  if (name in fields) return fields[name];
  let value: unknown = fields;
  for (const part of name.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Whether the data holds every field of the filter. */
export function holds(data: unknown, filter: Record<string, unknown> | undefined): boolean {
  if (filter === undefined) return true;
  if (data === null || typeof data !== "object") return Object.keys(filter).length === 0;
  const fields = data as Record<string, unknown>;
  return Object.entries(filter).every(([name, expected]) => stableJson(valueAt(fields, name)) === stableJson(expected));
}
