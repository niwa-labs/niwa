/**
 * The smallest value a zod schema takes: the required fields of an object only, and the first
 * option of a union that takes it. A test that needs one message of every variant of a protocol,
 * and has a real one for only some, makes the rest with this.
 */

import { z } from "zod";

export function minimalInstance(schema: z.core.$ZodType): unknown {
  if (schema instanceof z.ZodObject) {
    const made: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) continue;
      made[key] = minimalInstance(field);
    }
    return made;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      const value = minimalInstance(option);
      if (z.safeParse(schema, value).success) return value;
    }
    throw new Error("no option of the union takes its smallest value");
  }
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodString) return "x";
  if (schema instanceof z.ZodNumber) return 1;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodNull) return null;
  if (schema instanceof z.ZodArray) return [];
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodLazy) return minimalInstance(schema.unwrap());
  throw new Error(`no smallest value is known for ${schema.constructor.name}`);
}
