/**
 * What a session of a harness kind takes at its start besides the model, the effort and the mode:
 * one block of options per kind, named by the kind.
 *
 * The block is the kind's own: the package of a kind declares its name and its schema
 * (`kindOptions`), and `defineHarnessKind({ options })` carries it. Nothing here lists the kinds, so
 * a kind from another package has a block as typed as the ones niwa ships. A start that carries the
 * block of its own kind has it checked by that schema and applied; a start that carries the block
 * of another kind is refused, and so is a field the block does not have. The schemas are strict
 * for that reason: a key a kind does not know is an error, never ignored.
 *
 * A block travels beside the fields of a start (`claude: { advisor: false }`): every key of an input
 * that is not one of its fields is a block (`blocksOf`).
 */

import { z } from "zod";

/** The name of a block: the key in workflow session options, `session.start` and on the command line. */
export const OptionsBlockNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "a block name is lower case letters, digits and dashes, starting with a letter");
export type OptionsBlock = z.output<typeof OptionsBlockNameSchema>;

/** One block, as it is carried: an object, checked against the schema of its kind before it is used. */
export type OptionsBlockValue = Readonly<Record<string, unknown>>;

/** The blocks a start, a question or a record carries, by name. A session carries the block of its own kind, or none. */
export type OptionBlocks = Readonly<Record<OptionsBlock, OptionsBlockValue>>;

/** The blocks as a record keeps them. */
export const OptionBlocksSchema = z.record(OptionsBlockNameSchema, z.record(z.string(), z.unknown()));

/** What a kind declares of its options: the name of its block, and the schema the block is checked by. */
export interface KindOptions {
  readonly block: OptionsBlock;
  readonly schema: z.ZodType<OptionsBlockValue, OptionsBlockValue>;
}

/** The block of a kind that has no option of its own yet: it takes nothing, and is checked all the same. */
export const NoOptions = z.strictObject({});

/** The options a kind declares: its block's name and schema. */
export function kindOptions(block: string, schema: z.ZodType<OptionsBlockValue, OptionsBlockValue>): KindOptions {
  return { block: OptionsBlockNameSchema.parse(block), schema };
}

/** Is this a block: a plain object? */
function isBlock(value: unknown): value is OptionsBlockValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The schema of an input that carries options blocks beside its `fields`: every other key is a block, an object
 * named after its kind. What is in a block is its kind's schema to check, once the harness is known; a key that is
 * no field and holds anything but an object is refused here, with `refuse` saying so.
 */
export function withBlocks<Shape extends z.ZodRawShape>(
  fields: z.ZodObject<Shape>,
  refuse: (key: string) => string = (key) => `there is no field "${key}", and an options block is an object`,
) {
  const known = new Set(Object.keys(fields.shape));
  return fields.catchall(z.unknown()).superRefine((input, ctx) => {
    for (const [key, value] of Object.entries(input)) {
      if (known.has(key) || value === undefined || isBlock(value)) continue;
      ctx.addIssue({ code: "custom", message: refuse(key), path: [key] });
    }
  });
}

/**
 * The blocks an input carries: every key that is not one of its `fields` and has a value. A key that
 * is not a field and holds anything but an object is neither a field nor a block, and is refused.
 */
export function blocksOf(input: object, fields: Iterable<string>): OptionBlocks {
  const known = new Set(fields);
  const blocks: Record<string, OptionsBlockValue> = {};
  for (const [name, value] of Object.entries(input)) {
    if (known.has(name) || value === undefined) continue;
    if (!isBlock(value)) throw new Error(`there is no field "${name}", and an options block is an object`);
    blocks[OptionsBlockNameSchema.parse(name)] = value;
  }
  return blocks;
}
