/**
 * Whether a schema that only reads a value can read everything another schema allows to be written.
 *
 * A client module cannot import the schemas of the actions it calls, so it keeps a narrower copy of them. This tells a
 * test where the copy has drifted: a field the real output may lack, a type it changed, a value its enum gained.
 */

import { z } from "zod";

type Json = {
  type?: string | string[];
  properties?: Record<string, Json>;
  required?: string[];
  items?: Json;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Json[];
  oneOf?: Json[];
};

const variantsOf = (schema: Json): Json[] | undefined => schema.anyOf ?? schema.oneOf;

const typesOf = (schema: Json): string[] | undefined => (schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type]);

/** The reasons `reader` cannot read what `writer` produces, at the path they were found; none when it can. */
function problems(reader: Json, writer: Json, path: string, ofVariant = false): string[] {
  const written = variantsOf(writer);
  if (written !== undefined) {
    // A field one variant lacks is read as absent there; it must still be a field of some variant.
    const named = new Set(written.flatMap((variant) => Object.keys(variant.properties ?? {})));
    const lost = Object.keys(reader.properties ?? {})
      .filter((name) => !named.has(name) && written.every((variant) => variant.properties !== undefined))
      .map((name) => `${path}.${name}: no variant of the writer has such a field`);
    return [...lost, ...written.flatMap((variant, index) => problems(reader, variant, `${path}|${String(index)}`, true))];
  }
  const read = variantsOf(reader);
  if (read !== undefined) {
    const attempts = read.map((variant) => problems(variant, writer, path, ofVariant));
    return attempts.some((one) => one.length === 0) ? [] : [`${path}: no variant of the reader takes it`, ...attempts.flat()];
  }
  if (Object.keys(reader).length === 0) return [];
  const known = reader.enum ?? (reader.const === undefined ? undefined : [reader.const]);
  const values = writer.enum ?? (writer.const === undefined ? undefined : [writer.const]);
  if (known !== undefined) {
    if (values === undefined) return [`${path}: the writer allows values the reader does not name`];
    const missing = values.filter((value) => !known.includes(value));
    return missing.length === 0 ? [] : [`${path}: the values ${JSON.stringify(missing)} are not read`];
  }
  const readTypes = typesOf(reader);
  const writeTypes = typesOf(writer);
  if (readTypes !== undefined) {
    if (writeTypes === undefined) return [`${path}: the writer allows any value`];
    const fits = (type: string): boolean => readTypes.includes(type) || (type === "integer" && readTypes.includes("number"));
    const wrong = writeTypes.filter((type) => !fits(type));
    if (wrong.length > 0) return [`${path}: the type ${wrong.join("|")} is not read as ${readTypes.join("|")}`];
  }
  const found: string[] = [];
  if (reader.properties !== undefined) {
    for (const [name, property] of Object.entries(reader.properties)) {
      const there = writer.properties?.[name];
      if (there === undefined) {
        // In a variant, an optional field the variant lacks is read as absent; the union as a whole was checked for it.
        if (ofVariant && !(reader.required ?? []).includes(name)) continue;
        found.push(`${path}.${name}: the writer has no such field`);
        continue;
      }
      if ((reader.required ?? []).includes(name) && !(writer.required ?? []).includes(name)) found.push(`${path}.${name}: the reader needs it, the writer may leave it out`);
      found.push(...problems(property, there, `${path}.${name}`));
    }
  }
  if (reader.items !== undefined && writer.items !== undefined) found.push(...problems(reader.items, writer.items, `${path}[]`));
  return found;
}

const jsonOf = (schema: z.ZodType): Json => z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Json;

/** The reasons `reader` cannot read the output of `writer`; empty when it reads all of it. */
export function unreadable(reader: z.ZodType, writer: z.ZodType): string[] {
  return problems(jsonOf(reader), jsonOf(writer), "$");
}

/**
 * The reasons the input a client module builds is not one the real action takes: a field the action does not have, or one it
 * needs that the module never sends. Only the fields are compared, one level deep.
 */
export function unsendable(sends: z.ZodType, real: z.ZodType): string[] {
  const mine = z.toJSONSchema(sends, { io: "input", unrepresentable: "any" }) as Json;
  const theirs = z.toJSONSchema(real, { io: "input", unrepresentable: "any" }) as Json;
  const found = Object.keys(mine.properties ?? {})
    .filter((name) => theirs.properties?.[name] === undefined)
    .map((name) => `$.${name}: the action takes no such field`);
  for (const name of theirs.required ?? []) if (mine.properties?.[name] === undefined) found.push(`$.${name}: the action needs it and the module never sends it`);
  return found;
}
