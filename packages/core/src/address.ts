/**
 * Addresses: where a message can be sent.
 *
 * An address is a tagged value, never a bare string. The tag says what kind of thing is being
 * addressed, and the payload says which one. A bare string cannot say which kind it meant, so it
 * is refused here rather than guessed at somewhere later.
 *
 * There is no shared channel: one agent writes to another by address.
 */

import { z } from "zod";

/** The kinds of address: an agent, a session, a task, the owner, a client, a strategy. */
export const ADDRESS_KINDS = [
  "agent",
  "session",
  "task",
  "owner",
  "client",
  "strategy",
] as const;

/** One kind of address. */
export type AddressKind = (typeof ADDRESS_KINDS)[number];

/**
 * The id of the thing an address names.
 *
 * It is a plain string: what makes it an id of an agent or of a task is the tag of the address
 * it is written in, not the shape of the id itself.
 */
const Identifier = z.string().min(1);

/** An agent: a lasting actor with a name. */
export const AgentAddress = z.strictObject({
  kind: z.literal("agent"),
  id: Identifier,
});

/**
 * The id of the harness a session runs in: no whitespace, the rule of the id of a harness
 * installation. A session is named by the harness and the native id joined with a space, so a
 * harness with a space in it would name another session once the pair is joined and split again.
 */
const HarnessIdentifier = z.string().regex(/^\S+$/, "the harness of a session address must be non-empty and contain no whitespace");

/** A session: one conversation inside a harness. Its identity is the harness id and the harness's own id. */
export const SessionAddress = z.strictObject({
  kind: z.literal("session"),
  harness: HarnessIdentifier,
  id: Identifier,
});

/** A task: a contract about work. */
export const TaskAddress = z.strictObject({
  kind: z.literal("task"),
  id: Identifier,
});

/** The owner: the person niwa runs for. One address among others. */
export const OwnerAddress = z.strictObject({
  kind: z.literal("owner"),
});

/** An external client: a program that connects to the host. */
export const ClientAddress = z.strictObject({
  kind: z.literal("client"),
  id: Identifier,
});

/** A strategy: a plugin that accepts a task as the responsible party. */
export const StrategyAddress = z.strictObject({
  kind: z.literal("strategy"),
  id: Identifier,
});

/**
 * An address, as a schema.
 *
 * The error of the union names the rule: an address is a tagged value, not a bare string. The
 * refusal is the same wherever it is checked, so a message with `"to": "rin"` is refused with
 * the same words wherever it was written.
 */
export const Address = z.discriminatedUnion(
  "kind",
  [AgentAddress, SessionAddress, TaskAddress, OwnerAddress, ClientAddress, StrategyAddress],
  { error: "an address is a tagged value, not a bare string" },
);

/** One address. */
export type Address = z.infer<typeof Address>;

/** The address of an agent. */
export type AgentAddress = z.infer<typeof AgentAddress>;
/** The address of a session. */
export type SessionAddress = z.infer<typeof SessionAddress>;
/** The address of a task. */
export type TaskAddress = z.infer<typeof TaskAddress>;
/** The address of the owner. */
export type OwnerAddress = z.infer<typeof OwnerAddress>;
/** The address of an external client. */
export type ClientAddress = z.infer<typeof ClientAddress>;
/** The address of a strategy. */
export type StrategyAddress = z.infer<typeof StrategyAddress>;

/** The address of the owner: the one address every other address is not. */
export const owner: OwnerAddress = { kind: "owner" };

/** The address of an agent. */
export function agent(id: string): AgentAddress {
  return { kind: "agent", id };
}

/** The address of a session: the harness it runs in and the id the harness gave it. */
export function session(harness: string, id: string): SessionAddress {
  return { kind: "session", harness, id };
}

/** The address of a task. */
export function task(id: string): TaskAddress {
  return { kind: "task", id };
}

/** The address of an external client. */
export function client(id: string): ClientAddress {
  return { kind: "client", id };
}

/** The address of a strategy. */
export function strategy(id: string): StrategyAddress {
  return { kind: "strategy", id };
}

/**
 * Is this value an address?
 *
 * The check is the schema's own: a bare string is not an address, whatever it says.
 */
export function isAddress(value: unknown): value is Address {
  return Address.safeParse(value).success;
}

/**
 * The name of an address, as a person reads it.
 *
 * It is for a human eye and for the text an agent reads; it is not an address itself, and it
 * cannot be turned back into one.
 */
export function addressText(address: Address): string {
  switch (address.kind) {
    case "agent":
      return `agent ${address.id}`;
    case "session":
      return `session ${address.harness}/${address.id}`;
    case "task":
      return `task ${address.id}`;
    case "owner":
      return "the owner";
    case "client":
      return `client ${address.id}`;
    case "strategy":
      return `strategy ${address.id}`;
  }
}
