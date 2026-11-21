/**
 * Access: the grants, the profiles and the switch as the host keeps them.
 *
 * Every change is a record and the table is folded from the records, so what this class does is
 * write them: a grant issued for a principal, a grant closed, a profile set, the switch moved, a
 * decision recorded. The decision itself is the pure `permit` of `intercept.ts`.
 */

import type { z } from "zod";

import { DEFAULT_GRANT_ID, DecidedData, Doors, OWNER_GRANT_ID } from "./doors.ts";
import type {
  GrantEntry,
  Standing,
  Narrowed,
  RuleSpec,
  AskQuestion,
  AskScope,
  Caller,
  Grant,
  GrantId,
  NewRecord,
  Principal,
  RecordId,
  RecordTypeName,
  StoredRecord,
  Verb,
} from "@niwa-labs/core";
import {
  grant,
  grantId,
  narrow,
  narrowed,
  rule,
  ruleText,
  specOf,
  specsOf,
  CORE_TYPES,
  newRecordId,
  streamId,
} from "@niwa-labs/core";
import type { Permit } from "@niwa-labs/core/journal";

/** Whose grant a grant came from. */
interface Parent {
  readonly principal: Principal;
  readonly grant: GrantId;
}

/** What the control needs of the host: the table, and a way to commit records. */
export interface AccessHost {
  /** The table, while the host serves. */
  doors(): Doors;
  /** Commit records; the table takes them in. */
  commit(records: NewRecord[]): StoredRecord[];
  /** Read a record. */
  read(id: RecordId): StoredRecord | undefined;
}

/** The profile the owner has not set, as a plugin or the host declares it. */
type ProfileDefault = () => readonly RuleSpec[];

/**
 * What a connection with no token may do when the owner says nothing else.
 * `insert.report` is there because the hooks of a harness report what it did inside itself without a token.
 */
const DEFAULT_PROFILE: readonly RuleSpec[] = ["task.*", "message.send", "insert.report", "emit:wf.*", "net:registry.npmjs.org"];

/** The grants and the profiles of one host. */
export class AccessControl {
  private readonly defaults = new Map<string, ProfileDefault>([["default", () => DEFAULT_PROFILE]]);

  constructor(private readonly host: AccessHost) {}

  /** A plugin names the profile it owns; the owner's own setting wins over it. */
  declareProfile(name: string, rules: ProfileDefault): void {
    this.defaults.set(name, rules);
  }

  /** The profiles the plugins declared, as they are now: what an install that fails puts back. */
  declaredProfiles(): ReadonlyMap<string, ProfileDefault> {
    return new Map(this.defaults);
  }

  /** Put the declared profiles back as `declaredProfiles` took them. */
  restoreProfiles(declared: ReadonlyMap<string, ProfileDefault>): void {
    this.defaults.clear();
    for (const [name, rules] of declared) this.defaults.set(name, rules);
  }

  /**
   * What a caller stands on. A connection with no token, or one the host did not make, is a client
   * the host never issued a token to: it stands on the `default` profile, and only the owner's
   * token is unlimited by it.
   */
  standing(caller: Caller): Standing {
    const doors = this.host.doors();
    const standing = doors.standing(caller);
    if (standing.kind !== "unlimited" || caller.kind !== "client") return standing;
    const principal = caller.principal;
    if (principal !== undefined && (principal.kind !== "client" || doors.holds(principal))) return standing;
    return { kind: "limited", id: DEFAULT_GRANT_ID, grant: this.profile("default")?.rules ?? grant(DEFAULT_PROFILE) };
  }

  /**
   * What a caller may do, as a grant, or `"unlimited"` when nothing limits it. A caller whose grant
   * was closed, or that the emergency switch stopped, has a grant with no rules.
   */
  rightsOf(caller: Caller): Grant | "unlimited" {
    const standing = this.standing(caller);
    switch (standing.kind) {
      case "unlimited":
        return "unlimited";
      case "limited":
        return standing.grant;
      case "closed":
      case "off":
        return grant([]);
    }
  }

  /** The grant of the caller as the records carry it: set for a subject a grant limits. */
  grantIdOf(caller: Caller): GrantId | undefined {
    const standing = this.standing(caller);
    if (standing.kind === "limited" || standing.kind === "closed") {
      return standing.id === OWNER_GRANT_ID || standing.id === DEFAULT_GRANT_ID ? undefined : standing.id;
    }
    return undefined;
  }

  /** The rights of a subject started at the request of `caller`, or the masks it may not have. */
  narrowFor(caller: Caller, requested: readonly RuleSpec[]): Narrowed {
    const standing = this.standing(caller);
    switch (standing.kind) {
      case "unlimited":
        return { rules: grant(requested) };
      case "limited":
        // The owner starts what it likes: its grant is `call:*`, and the verbs beyond calls are its own to hand out.
        return standing.id === OWNER_GRANT_ID ? { rules: grant(requested) } : narrow(standing.grant, requested);
      case "closed":
      case "off":
        return { refused: requested.map((spec) => ruleText(rule(spec))) };
    }
  }

  /** The record that issues a grant to a principal, with the grant it came from for attribution. */
  grantRecord(principal: Principal, given: Grant, parent: Parent | undefined, actor: Caller = { kind: "host" }): NewRecord {
    return this.record(CORE_TYPES.accessGranted, actor, {
      principal,
      rules: specsOf(given),
      ...(parent === undefined ? {} : { parent }),
    });
  }

  /** The grant of a caller, as the parent of the subjects it starts. */
  parentOf(caller: Caller): Parent | undefined {
    if (caller.kind !== "client" || caller.principal === undefined) return undefined;
    const standing = this.standing(caller);
    if (standing.kind !== "limited" && standing.kind !== "closed") return undefined;
    return { principal: caller.principal, grant: standing.id };
  }

  /** The profile of this name: the owner's setting, else what was declared for it. */
  profile(name: string): { rules: Grant; set: boolean } | undefined {
    const set = this.host.doors().profileOf(name);
    if (set !== undefined) return { rules: set, set: true };
    const declared = this.defaults.get(name);
    return declared === undefined ? undefined : { rules: grant(declared()), set: false };
  }

  /** The names that have a profile. */
  profileNames(): string[] {
    return [...new Set([...this.defaults.keys(), ...this.host.doors().profileNames()])].sort();
  }

  /** The owner sets a profile. */
  setProfile(by: Caller, name: string, rules: readonly RuleSpec[]): Grant {
    const checked = grant(rules);
    this.host.commit([this.record(CORE_TYPES.accessProfile, by, { name, rules: specsOf(checked) })]);
    return checked;
  }

  /**
   * The owner moves the emergency switch: `off` denies every call of anyone but the owner.
   */
  setSwitch(by: Caller, all: "on" | "off"): void {
    this.host.commit([this.record(CORE_TYPES.accessSwitched, by, { all })]);
  }

  /**
   * Give a principal another grant. A grant that lost something closes its living children, except
   * runs; one that only gained leaves them as they are, and what starts next gets the new rights.
   */
  change(by: Caller, principal: Principal, rules: readonly RuleSpec[]): { grant: GrantId; closed: Principal[] } {
    const doors = this.host.doors();
    const before = doors.grantOf(principal);
    if (before === undefined || before.closed !== undefined) {
      throw new TypeError(`${principal.kind} "${principal.id}" holds no living grant`);
    }
    const after = grant(rules);
    const issued = this.grantRecord(principal, after, before.parent, by);
    const records: NewRecord[] = [issued];
    const closed: Principal[] = [];
    if (narrowed(before.grant, after)) records.push(...this.closing(by, before, "its parent's grant was narrowed", closed, false));
    this.host.commit(records);
    return { grant: grantId(issued.id), closed };
  }

  /** Close the grant of a principal and, with it, the grants of everything that was born from it. */
  close(by: Caller, principal: Principal, reason: string): Principal[] {
    const held = this.host.doors().grantOf(principal);
    if (held === undefined || held.closed !== undefined) {
      throw new TypeError(`${principal.kind} "${principal.id}" holds no living grant`);
    }
    const closed: Principal[] = [];
    this.host.commit(this.closing(by, held, reason, closed, true));
    return closed;
  }

  /**
   * The records that close a grant (when `self`) and the living ones below it, the deepest first.
   * A run that is going keeps the grant it was born with: the cascade passes over it, and what is under it.
   */
  private closing(by: Caller, from: GrantEntry, reason: string, closed: Principal[], self: boolean): NewRecord[] {
    const records: NewRecord[] = [];
    const doors = this.host.doors();
    const below = (entry: GrantEntry): void => {
      for (const child of doors.childrenOf(entry.principal)) {
        if (child.principal.kind === "run") continue;
        below(child);
        records.push(this.record(CORE_TYPES.accessClosed, by, { grant: child.id, principal: child.principal, reason }));
        closed.push(child.principal);
      }
    };
    below(from);
    if (self) {
      records.push(this.record(CORE_TYPES.accessClosed, by, { grant: from.id, principal: from.principal, reason }));
      closed.push(from.principal);
    }
    return records;
  }

  /** Does an answer of the owner already stand for this call: `run`, as long as the grant lives? */
  answeredRun(question: AskQuestion): boolean {
    return this.host.doors().answeredRun(question.grant, question.name, question.target);
  }

  /**
   * Write down the owner's answer to a call that asked. `run` stays in force with the
   * grant; `always` also gives the subject a grant with the exact action and target and no `ask`,
   * a widening that touches nothing living. The rule that asked stays as it is: a sibling the
   * owner was not asked about asks again.
   */
  answered(question: AskQuestion, scope: AskScope): void {
    const records: NewRecord[] = [
      this.record(CORE_TYPES.accessAnswered, { kind: "host" }, {
        grant: question.grant,
        principal: question.principal,
        name: question.name,
        ...(question.target === undefined ? {} : { target: question.target }),
        scope,
      }),
    ];
    const held = this.host.doors().grantOf(question.principal);
    if (scope === "always" && held !== undefined && held.closed === undefined && held.id === question.grant) {
      const exact = `call:${question.name}${question.target === undefined ? "" : `@${question.target}`}`;
      const kept = held.grant.rules.filter((have) => ruleText(have) !== exact).map(specOf);
      records.push(this.grantRecord(question.principal, grant([...kept, exact]), held.parent));
    }
    this.host.commit(records);
  }

  /** Record one decision of a grant: who, what, which rule, and the outcome. */
  decided(caller: Caller, standing: Standing, verb: Verb, name: string, answer: Permit): RecordId | undefined {
    if (caller.kind !== "client" || caller.principal === undefined) return undefined;
    if (standing.kind === "unlimited" || (standing.kind === "limited" && standing.id === OWNER_GRANT_ID)) return undefined;
    const data = {
      principal: caller.principal,
      verb,
      name,
      ...(answer.grant === undefined ? {} : { grant: answer.grant }),
      outcome: answer.allowed ? "allowed" : "denied",
      ...(answer.rule === undefined ? {} : { rule: answer.rule }),
      ...(answer.allowed && answer.answered !== undefined ? { answered: answer.answered } : {}),
      ...(answer.allowed ? {} : { reason: answer.reason }),
      ...(answer.allowed || answer.missing === undefined ? {} : { missing: answer.missing }),
    };
    const [stored] = this.host.commit([this.record(CORE_TYPES.accessDecided, caller, data)]);
    return stored?.id;
  }

  /** The rules a subject has: what it may see of its own rights. */
  mine(caller: Caller): { principal?: Principal; grant?: GrantId; unlimited: boolean; closed?: string; rules: RuleSpec[] } {
    const principal = caller.kind === "client" ? caller.principal : undefined;
    const standing = this.standing(caller);
    const who = principal === undefined ? {} : { principal };
    switch (standing.kind) {
      case "unlimited":
        return { ...who, unlimited: true, rules: [] };
      case "off":
        return { ...who, unlimited: false, rules: [] };
      case "closed":
        return { ...who, grant: standing.id, unlimited: false, closed: standing.reason, rules: [] };
      case "limited":
        return { ...who, grant: standing.id, unlimited: false, rules: specsOf(standing.grant) };
    }
  }

  /** A record of the journal. */
  recordOf(id: RecordId): StoredRecord | undefined {
    return this.host.read(id);
  }

  /** What a decision record says; undefined for any other record. */
  decisionOf(stored: StoredRecord): z.infer<typeof DecidedData> | undefined {
    if (stored.type !== CORE_TYPES.accessDecided) return undefined;
    const parsed = DecidedData.safeParse(stored.data);
    return parsed.success ? parsed.data : undefined;
  }

  private record(type: RecordTypeName, actor: Caller, data: unknown): NewRecord {
    const id = newRecordId("acc");
    return { id, stream: streamId("access"), type, schema: 1, data, actor, cause: null, root: id };
  }
}
