/**
 * Doors: who a connection is, and what it may do.
 *
 * A token is a short random string a client shows in `hello`. The host keeps `HMAC(host.key,
 * token)` in the journal, never the token, and the table folds from those records, so a restart
 * knows every token it made. What a connection is called does not matter: only the token says
 * who it is. The grants, the profiles and the switch are records too; the table is what they say.
 */

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import {
  GrantedData,
  ClosedData,
  HOST_KEY_FILE,
  OWNER,
  grantIdSchema,
  principalSchema,
  OWNER_GRANT,
  OWNER_GRANT_ID,
  RuleSpecSchema,
  grant,
  grantId,
  ASK_SCOPES,
  CORE,
} from "@niwa-labs/core";
import type { GrantEntry, Standing, Caller, Grant, GrantId, Principal, StoredRecord, Token, TokenMac } from "@niwa-labs/core";

/** The longest a token is, in characters. Short on purpose: the label of "who I am", not a vault. */
const TOKEN_LENGTH = 4;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A new random token. */
export function newToken(): Token {
  let text = "";
  for (let at = 0; at < TOKEN_LENGTH; at += 1) text += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return text as Token;
}

/** The key the host signs tokens with, kept in the home with rights for the owner only. */
export function loadHostKey(home: string): Buffer {
  const path = `${home}/${HOST_KEY_FILE}`;
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("hex")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** The data of a `niwa.access.issued` record. */
export const IssuedData = z.object({
  mac: z.string().min(1),
  principal: principalSchema,
});

/** The grant the owner has: it is the host's own, not a record. */
export { OWNER_GRANT_ID };

/** The grant of a connection with no token, or one the host did not make: the `default` profile, not a record. */
export const DEFAULT_GRANT_ID: GrantId = grantId("default");

/** The data of a `niwa.access.profile` record. */
export const ProfileData = z.strictObject({
  name: z.string().min(1),
  rules: z.array(RuleSpecSchema),
});

/** The data of a `niwa.access.switched` record. */
export const SwitchedData = z.strictObject({ all: z.enum(["on", "off"]) });

/**
 * The data of a `niwa.access.answered` record: the owner's answer to a call that asked.
 *
 * `run` stays in force while the grant lives; `once` and `always` are written down as they were
 * given, and `always` also writes a grant.
 */
export const AnsweredData = z.strictObject({
  grant: grantIdSchema,
  principal: principalSchema,
  name: z.string().min(1),
  target: z.string().min(1).optional(),
  scope: z.enum(ASK_SCOPES),
});

/** The data of a `niwa.access.decided` record. */
export const DecidedData = z.object({
  principal: principalSchema,
  verb: z.string(),
  name: z.string(),
  grant: grantIdSchema.optional(),
  outcome: z.enum(["allowed", "denied"]),
  rule: z.string().optional(),
  /** The scope of the owner's answer that let the call through, when the rule asked. */
  answered: z.enum(ASK_SCOPES).optional(),
  reason: z.string().optional(),
  missing: z.string().optional(),
});

const answerKey = (id: GrantId, name: string, target: string | undefined): string =>
  `${id}\u0000${name}${target === undefined ? "" : `@${target}`}`;

const keyOf = (principal: Principal): string => `${principal.kind}:${principal.id}`;

/** The tokens, the grants, the profiles and the switch the host made, folded from the journal. */
export class Doors {
  private readonly holders = new Map<TokenMac, Principal>();
  private readonly grants = new Map<GrantId, GrantEntry>();
  /** The latest grant of each principal: a session that is resumed gets a new token and a new grant. */
  private readonly current = new Map<string, GrantId>();
  private readonly profiles = new Map<string, Grant>();
  /** What the owner answered `run` to: an action and its target, by the grant they were answered for. */
  private readonly runAnswers = new Set<string>();
  private all: "on" | "off" = "on";

  constructor(private readonly key: Buffer) {}

  /** The MAC the journal keeps for a token. */
  macOf(secret: Token): TokenMac {
    return createHmac("sha256", this.key).update(secret).digest("hex") as TokenMac;
  }

  /** Take a record of the journal in: the table is what the records, in order, say. */
  fold(stored: StoredRecord): void {
    switch (stored.type) {
      case CORE.accessIssued: {
        const issued = IssuedData.safeParse(stored.data);
        if (issued.success) this.hold(issued.data.mac as TokenMac, issued.data.principal);
        return;
      }
      case CORE.accessGranted: {
        const granted = GrantedData.safeParse(stored.data);
        if (!granted.success) return;
        const id = grantId(stored.id);
        this.grants.set(id, {
          id,
          principal: granted.data.principal,
          grant: grant(granted.data.rules),
          ...(granted.data.parent === undefined ? {} : { parent: granted.data.parent }),
        });
        this.current.set(keyOf(granted.data.principal), id);
        return;
      }
      case CORE.accessClosed: {
        const closed = ClosedData.safeParse(stored.data);
        const held = closed.success ? this.grants.get(closed.data.grant) : undefined;
        if (closed.success && held !== undefined) this.grants.set(held.id, { ...held, closed: closed.data.reason });
        return;
      }
      case CORE.accessProfile: {
        const set = ProfileData.safeParse(stored.data);
        if (set.success) this.profiles.set(set.data.name, grant(set.data.rules));
        return;
      }
      case CORE.accessAnswered: {
        const answered = AnsweredData.safeParse(stored.data);
        if (answered.success && answered.data.scope === "run") {
          this.runAnswers.add(answerKey(answered.data.grant, answered.data.name, answered.data.target));
        }
        return;
      }
      case CORE.accessSwitched: {
        const switched = SwitchedData.safeParse(stored.data);
        if (switched.success) this.all = switched.data.all;
        return;
      }
    }
  }

  /** Is this token one of the table's? A token the host never made is nobody's. */
  holderOf(secret: Token | undefined): Principal | undefined {
    if (secret === undefined) return undefined;
    return this.holders.get(this.macOf(secret));
  }

  /** Did the host make a token for this principal? A connection with no token, or one the host did not make, holds none. */
  holds(principal: Principal): boolean {
    for (const held of this.holders.values()) if (keyOf(held) === keyOf(principal)) return true;
    return false;
  }

  /** Does this MAC belong to a token already made? */
  has(mac: TokenMac): boolean {
    return this.holders.has(mac);
  }

  /** A token that is not in the table yet: the token is short, so a draw that hits one is made again. */
  fresh(): Token {
    for (;;) {
      const candidate = newToken();
      if (!this.holders.has(this.macOf(candidate))) return candidate;
    }
  }

  /** The grant a principal holds now, closed or not; undefined when nothing ever limited it. */
  grantOf(principal: Principal): GrantEntry | undefined {
    const id = this.current.get(keyOf(principal));
    return id === undefined ? undefined : this.grants.get(id);
  }

  /** A grant by its id. The owner's is the host's own. */
  grantById(id: GrantId): GrantEntry | undefined {
    if (id === OWNER_GRANT_ID) return { id, principal: OWNER, grant: OWNER_GRANT };
    return this.grants.get(id);
  }

  /** The grants a grant came from, nearest first. */
  chainOf(id: GrantId): GrantEntry[] {
    const chain: GrantEntry[] = [];
    for (let at = this.grantById(id); at !== undefined && chain.length < 64; ) {
      chain.push(at);
      at = at.parent === undefined ? undefined : this.grantById(at.parent.grant);
    }
    return chain;
  }

  /** The principals that were born from this one and still hold a living grant. */
  childrenOf(principal: Principal): GrantEntry[] {
    const children: GrantEntry[] = [];
    for (const id of this.current.values()) {
      const held = this.grants.get(id);
      if (held === undefined || held.closed !== undefined) continue;
      if (held.parent !== undefined && keyOf(held.parent.principal) === keyOf(principal)) children.push(held);
    }
    return children;
  }

  /** Did the owner answer `run` for this action, with this target, for this grant? */
  answeredRun(id: GrantId, name: string, target: string | undefined): boolean {
    return this.runAnswers.has(answerKey(id, name, target));
  }

  /** The profile of this name, when the owner set one. */
  profileOf(name: string): Grant | undefined {
    return this.profiles.get(name);
  }

  /** The profiles the owner set. */
  profileNames(): string[] {
    return [...this.profiles.keys()];
  }

  /** The emergency switch. */
  switched(): "on" | "off" {
    return this.all;
  }

  /** What a caller stands on: its own grant, or nothing at all when nothing limits it. A connection with no token is left to the access control, which puts it on the `default` profile. */
  standing(caller: Caller): Standing {
    if (caller.kind !== "client") return { kind: "unlimited" };
    const principal = caller.principal;
    if (principal?.kind === "owner") return { kind: "limited", id: OWNER_GRANT_ID, grant: OWNER_GRANT };
    if (this.all === "off") return { kind: "off" };
    const held = principal === undefined ? undefined : this.grantOf(principal);
    if (held === undefined) return { kind: "unlimited" };
    if (held.closed !== undefined) return { kind: "closed", id: held.id, reason: held.closed };
    return { kind: "limited", id: held.id, grant: held.grant };
  }

  /** The owner has one token at a time: a new one drops the earlier, so an old token stops working. */
  private hold(mac: TokenMac, principal: Principal): void {
    if (principal.kind === "owner") {
      for (const [known, other] of this.holders) if (other.kind === "owner") this.holders.delete(known);
    }
    this.holders.set(mac, principal);
  }
}
