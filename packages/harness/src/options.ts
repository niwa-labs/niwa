/**
 * What a session of each harness kind takes at its start besides the model, the effort and the
 * mode: one block of options per kind, named after the kind.
 *
 * A kind declares the block it takes (`defineHarnessKind({ options })`). A start that carries the
 * block of its own kind has it checked and applied; a start that carries the block of another
 * kind is refused, and so is a field the block does not have. The schemas are strict for that
 * reason: a key a kind does not know is an error, never ignored.
 *
 * Only Claude Code has options of its own. The other kinds have an empty block each: what their
 * control sides take at the instance (the binary, the home, the timeouts, the account profile)
 * belongs to the installation, and what a permission request is answered with is decided by niwa
 * for every session it starts, so none of it is a choice of one session. The block is declared
 * anyway, so the day a kind has an option per session it is typed in one place.
 */

import { z } from "zod";

/** The options of a Claude Code session (kinds `claude-code` and `claude-sdk`). */
export const ClaudeOptions = z.strictObject({
  /** False takes Claude Code's advisor tool away from the session; absent, the owner's own configuration stands. */
  advisor: z.boolean().optional(),
});
export type ClaudeOptions = z.infer<typeof ClaudeOptions>;

/** The block of a kind that has no option of its own: it takes nothing, and is checked all the same. */
const NoOptions = z.strictObject({});

/** The options each kind declares: the name of its block, and the schema the block is checked by. */
export const KIND_OPTIONS = {
  claude: { block: "claude", schema: ClaudeOptions },
  codex: { block: "codex", schema: NoOptions },
  mcode: { block: "mcode", schema: NoOptions },
  ncode: { block: "ncode", schema: NoOptions },
  pi: { block: "pi", schema: NoOptions },
  zcode: { block: "zcode", schema: NoOptions },
} as const;

/** The name of a block: the key it is written under in `agent()`, `session.start` and on the command line. */
export type OptionsBlock = keyof typeof KIND_OPTIONS;

/** What a kind declares of its options. */
export type KindOptions = (typeof KIND_OPTIONS)[OptionsBlock];

/** Every block a start may carry, each optional: the shape `session.start` and `agent()` take, and the typing of a script is made from. */
export const OptionBlocks = z.strictObject({
  claude: KIND_OPTIONS.claude.schema.optional(),
  codex: KIND_OPTIONS.codex.schema.optional(),
  mcode: KIND_OPTIONS.mcode.schema.optional(),
  ncode: KIND_OPTIONS.ncode.schema.optional(),
  pi: KIND_OPTIONS.pi.schema.optional(),
  zcode: KIND_OPTIONS.zcode.schema.optional(),
});
export type OptionBlocks = z.infer<typeof OptionBlocks>;

/** The blocks of a start or a record, and nothing else of it. */
const BlocksOnly = z.object(OptionBlocks.shape);

/** The blocks an input carries, checked: its other fields, and a block that is not there, are left out. */
export function blocksOf(input: object): OptionBlocks {
  return Object.fromEntries(Object.entries(BlocksOnly.parse(input)).filter(([, block]) => block !== undefined));
}
