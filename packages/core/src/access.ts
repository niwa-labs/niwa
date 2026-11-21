/**
 * Access: who a principal is, and the records of grants.
 *
 * A token is a short random string a client shows in `hello`. The host keeps `HMAC(host.key,
 * token)` in the journal, never the token, and the table folds from those records, so a restart
 * knows every token it made. What a connection is called does not matter: only the token says
 * who it is. The grants, the profiles and the switch are records too; the table is what they say.
 */

import { z } from "zod";

import { actionName } from "./action.ts";
import { RuleSpecSchema, grantId } from "./grant.ts";
import { record } from "./record.ts";
import { CORE } from "./types.ts";
import type { Caller, ClientId, Grant, GrantId, Principal, PrincipalId, PrincipalKind } from "./types.ts";

/** The file of the host's key, in the home. */
export const HOST_KEY_FILE = "host.key";
/** The file of the owner's token, in the home: the owner's own tools read it by themselves. */
export const OWNER_TOKEN_FILE = "owner.token";

/** The journal's database, in the home: SQLite keeps its log and its shared memory beside it. */
export const JOURNAL_FILE = "journal.db";

/**
 * The places of a home a process in a box never reaches unless it is asked for by name: the host's
 * key, the owner's token and the journal. The secret store is the host's to add, wherever it is.
 */
export function closedPlacesOf(home: string): string[] {
  return [HOST_KEY_FILE, OWNER_TOKEN_FILE, JOURNAL_FILE, `${JOURNAL_FILE}-wal`, `${JOURNAL_FILE}-shm`].map((file) => `${home}/${file}`);
}

/** The environment variable that carries a session's token into the process it started. */
export const TOKEN_ENV = "NIWA_ID";

/** The id of a principal: not empty, no whitespace. */
export function principalId(text: string): PrincipalId {
  if (typeof text !== "string" || text.length === 0 || /\s/.test(text)) {
    throw new TypeError(`a principal id must be a non-empty string without whitespace: ${JSON.stringify(text)}`);
  }
  return text as PrincipalId;
}

/** The owner: one per host. */
export const OWNER: Principal = { kind: "owner", id: principalId("owner") };

/** A principal of a kind, called by an id. */
export function principalOf(kind: PrincipalKind, id: string): Principal {
  return { kind, id: principalId(id) };
}

/** The caller a principal is when a plugin acts for it: the grant of the principal decides what it may do. */
export function callerOf(principal: Principal): Caller {
  return { kind: "client", id: `${principal.kind}:${principal.id}` as ClientId, principal };
}

/** The schema of a principal as it is stored and travels. */
export const principalSchema = z.strictObject({
  kind: z.enum(["owner", "session", "run", "plugin", "client"]),
  id: z.string().min(1).transform((id) => principalId(id)),
});

export const grantIdSchema = z.string().min(1).transform((id) => grantId(id));

/** Whose grant a grant came from, for attribution and for the cascade. */
export const ParentSchema = z.strictObject({ principal: principalSchema, grant: grantIdSchema });

/** The data of a `niwa.access.granted` record: the record's own id is the grant's id. */
export const GrantedData = z.strictObject({
  principal: principalSchema,
  rules: z.array(RuleSpecSchema),
  parent: ParentSchema.optional(),
});

/** A grant was issued, or a principal was given another one: what a plugin that derived rights from it reacts to. */
export const AccessGranted = record(CORE.accessGranted, GrantedData);

/** The data of a `niwa.access.closed` record. */
export const ClosedData = z.strictObject({
  grant: grantIdSchema,
  principal: principalSchema,
  reason: z.string().min(1),
});

/** A grant was closed: what a plugin that started the subject reacts to by stopping it. */
export const AccessClosed = record(CORE.accessClosed, ClosedData);

/** A grant that was issued to a principal, and where it stands. */
export interface GrantEntry {
  readonly id: GrantId;
  readonly principal: Principal;
  readonly grant: Grant;
  readonly parent?: { readonly principal: Principal; readonly grant: GrantId };
  /** Why it was closed; undefined while it lives. */
  readonly closed?: string;
}

/** What a caller stands on when a call is decided. */
export type Standing =
  /** Nothing limits it: the host, a handler, a plugin, a principal the host made a token for and gave no grant. */
  | { readonly kind: "unlimited" }
  /** Its grant decides. */
  | { readonly kind: "limited"; readonly id: GrantId; readonly grant: Grant }
  /** Its grant was closed. */
  | { readonly kind: "closed"; readonly id: GrantId; readonly reason: string }
  /** The emergency switch is off and it is not the owner. */
  | { readonly kind: "off" };

/** `access.mine`: what a subject may do; the sessions module grants it to every session it starts. */
export const accessMine = actionName("access.mine");
