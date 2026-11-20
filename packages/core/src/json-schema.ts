/**
 * Rendering a zod schema as JSON Schema: the one conversion the descriptions, the tool catalogues
 * and the surfaces share.
 */

import { z } from "zod";

import type { JsonSchema } from "./types.ts";

/**
 * Render a zod schema as JSON Schema. An action's input is what the caller writes and its
 * output is what the caller reads, so the two use the matching side of the schema.
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
}
