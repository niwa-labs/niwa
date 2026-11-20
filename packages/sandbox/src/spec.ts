/**
 * The BoxSpec: what a sandboxed process may reach.
 *
 * Writing and the network are allow-lists. The spec itself has no default prohibitions: `denyRead` is
 * empty unless the caller sets it (a session's box sets the owner's token and the host key). The environment is only what is listed; `process.env` is never inherited.
 */

import { z } from "zod";

/** A path as the grant wrote it. A leading `~` is expanded by the sandbox, not here, so the spec is a pure value. */
export const BoxPathSchema = z.string().min(1).brand<"BoxPath">();
export type BoxPath = z.output<typeof BoxPathSchema>;

/** A host the process may reach, as the sandbox's network filter spells it: "registry.npmjs.org", "*.example.com". */
export const NetHostSchema = z
  .string()
  .regex(/^\S+$/, "a net host must be non-empty and contain no whitespace")
  .brand<"NetHost">();
export type NetHost = z.output<typeof NetHostSchema>;

/** The name of an environment variable the process receives. */
export const EnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name")
  .brand<"EnvName">();
export type EnvName = z.output<typeof EnvNameSchema>;

export const BoxSpecSchema = z.object({
  /** The working directory of the process. It is not made writable by being the cwd: list it in `write`. */
  cwd: BoxPathSchema,
  /**
   * Places the process may read besides its `cwd`. Only a sandbox whose reading is an allow-list
   * (nono) holds it to them; where reads are open unless denied (srt) it changes nothing.
   */
  read: z.array(BoxPathSchema).default([]),
  /** The only places the process may write. */
  write: z.array(BoxPathSchema).default([]),
  /** Places the process may not read. Empty unless the caller sets it. */
  denyRead: z.array(BoxPathSchema).default([]),
  /** The only hosts the process may reach. Empty: no network. */
  net: z.array(NetHostSchema).default([]),
  /** The whole environment of the process. */
  env: z.record(EnvNameSchema, z.string()).default({}),
  /** Unix sockets the process may connect to (niwa's own socket must be reachable inside). */
  sockets: z.array(BoxPathSchema).default([]),
});

/** What the caller writes. */
export type BoxSpecInput = z.input<typeof BoxSpecSchema>;
/** A checked spec. */
export type BoxSpec = z.output<typeof BoxSpecSchema>;

/** Check a spec; a malformed one throws a ZodError naming the field. */
export function boxSpec(input: BoxSpecInput): BoxSpec {
  return BoxSpecSchema.parse(input);
}
