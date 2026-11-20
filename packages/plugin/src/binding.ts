// How a plugin knows what address a caller speaks as.

import type { Address, Caller } from "@niwa-labs/core";

/**
 * How the module knows what address a caller speaks as.
 *
 * The identity of a caller is bound by the transport, never taken from a payload a model
 * wrote. The binding is where that identity becomes an address:
 * the client of an MCP session is the session, the client of the owner is the owner.
 */
export type CallerBinding = (caller: Caller) => Address | undefined;

export interface MessagesOptions {
  /**
   * The address a caller speaks as.
   *
   * Return undefined for a caller that stands for nobody in particular: the host itself, or a
   * handler of a plugin that has no address of its own. Default: a client speaks as itself,
   * and nobody else speaks as anybody.
   */
  bind?: CallerBinding;
}

/**
 * The default binding: a client speaks as itself, unless its token says it is the owner.
 *
 * A connection whose principal is the owner speaks as the owner, so the owner can be answered
 * through a surface; every other client speaks as itself, whatever it calls itself. The host and
 * a handler stand for nobody: the host is the runtime, and a handler belongs to a plugin, not to
 * an address.
 *
 * The identity of a caller is bound by the transport, never by a payload: the principal comes from the
 * token the connection showed in `hello`.
 */
function defaultBind(caller: Caller): Address | undefined {
  if (caller.kind !== "client") return undefined;
  if (caller.principal?.kind === "owner") return { kind: "owner" };
  return { kind: "client", id: caller.id };
}

/** The binding the options ask for. */
export function bindingOf(opts?: MessagesOptions): CallerBinding {
  return opts?.bind ?? defaultBind;
}
