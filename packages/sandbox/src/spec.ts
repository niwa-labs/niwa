/**
 * The BoxSpec: what a sandboxed process may reach.
 *
 * Writing and the network are allow-lists. The spec itself has no default prohibitions: `closed` is
 * empty unless the caller sets it (a box resolved from profiles closes the places of the profiles it
 * did not take). The environment is only what is listed; `process.env` is never inherited.
 */

import { z } from "zod";

/** A path as the grant wrote it. A leading `~` is expanded by the sandbox, not here, so the spec is a pure value; the working directory's is expanded once when paths are anchored to it. */
export const BoxPathSchema = z.string().min(1).brand<"BoxPath">();
export type BoxPath = z.output<typeof BoxPathSchema>;

/** A host the process may reach, as the sandbox's network filter spells it: "registry.npmjs.org", "*.example.com". */
export const NetHostSchema = z
  .string()
  .regex(/^\S+$/, "a net host must be non-empty and contain no whitespace")
  .brand<"NetHost">();
export type NetHost = z.output<typeof NetHostSchema>;

/** One inbound TCP listener, reachable from the host only on this IP and port. */
export const LoopbackListenSchema = z.strictObject({
  host: z.enum(["127.0.0.1", "::1"]),
  /** Zero permits one ephemeral port chosen by the OS at bind time. */
  port: z.int().min(0).max(65535),
});
export type LoopbackListen = Readonly<z.output<typeof LoopbackListenSchema>>;

export const ListenNeedSchema = LoopbackListenSchema.extend({ from: z.string().min(1) });
export type ListenNeed = Readonly<z.output<typeof ListenNeedSchema>>;

export function sameListener(one: LoopbackListen, another: LoopbackListen): boolean {
  return one.host === another.host && one.port === another.port;
}

export function listenerName(listener: LoopbackListen): string {
  const host = listener.host === "::1" ? "[::1]" : listener.host;
  return `TCP ${host}:${listener.port}`;
}

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
  /**
   * Places the process may neither read nor write, whatever else the spec lists: the sandbox keeps
   * them closed or refuses the spec. Empty unless the caller sets it.
   */
  closed: z.array(BoxPathSchema).default([]),
  /** The only hosts the process may connect to. Empty: no outbound hosts. */
  net: z.array(NetHostSchema).default([]),
  /** The required inbound TCP listener. Absent: no host-reachable listener is granted. */
  listen: ListenNeedSchema.optional(),
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
