/**
 * Intercepts: what runs before an action.
 *
 * `decide` is the one point every call passes through. The order is the contract:
 * validate the requested input, run the adjusts, validate the result, match the caller's grant,
 * ask the guards about that final input. The caller records the decision, then the intent, and
 * only then runs the action.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Standing } from "../access.ts";
import { NOT_ANSWERED, REFUSED_BY_OWNER } from "../denied.ts";
import { OWNER_GRANT_ID, isCallTarget, match, ruleText } from "../grant.ts";
import type {
  Action,
  ActionName,
  AdjustFn,
  Ask,
  AskScope,
  Caller,
  Denial,
  Effect,
  GrantId,
  GuardFn,
  InterceptContext,
  Step,
  Verb,
} from "../types.ts";

/** The issues of a schema that refused a value: what the schema reported. */
export type Issues = readonly { path: readonly PropertyKey[]; message: string }[];

/** What the grant of a caller said about one verb on one name. */
export type Permit =
  /** It may go on; `rule` is the one that allowed it, `answered` the answer of the owner that let it through. */
  | { readonly allowed: true; readonly grant?: GrantId; readonly rule?: string; readonly answered?: AskScope }
  /** It may not: `reason` says why, `missing` the rule that would have allowed it; `asks` says the rule asks. */
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly grant?: GrantId;
      readonly rule?: string;
      readonly missing?: string;
      readonly asks?: true;
    };

/**
 * The grant's match for one `call` or `emit`: no rule is a denial, a rule allows, and a rule
 * with `ask` is a denial that says it asks: `decide` puts the question to the owner for a call.
 * Whatever else decides with `permit` (an `emit`) takes it as the denial it is. A call of an
 * irreversible action is matched only by a rule that names it, except under the owner's grant.
 */
export function permit(standing: Standing, verb: Verb, name: string, target?: string, effect?: Effect): Permit {
  const wanted = `${verb}:${name}${target === undefined ? "" : `@${target}`}`;
  switch (standing.kind) {
    case "unlimited":
      return { allowed: true };
    case "off":
      return { allowed: false, reason: "all access is switched off", missing: wanted };
    case "closed":
      return { allowed: false, reason: `its grant was closed: ${standing.reason}`, grant: standing.id, missing: wanted };
    case "limited": {
      // Data cannot widen a rule: a target with a wildcard or an empty segment is not one place.
      if (target !== undefined && !isCallTarget(target)) {
        return { allowed: false, reason: `${JSON.stringify(target)} is not the target of a call`, grant: standing.id, missing: wanted };
      }
      // The owner's `*` is the owner's own: for anyone else a mask does not grant an irreversible action.
      const irreversible = effect === "irreversible" && standing.id !== OWNER_GRANT_ID;
      const found = match(standing.grant, verb, name, target, { irreversible });
      if (found === undefined) {
        const reason = irreversible && match(standing.grant, verb, name, target) !== undefined
          ? `"${name}" is irreversible: only a rule that names it grants it, not a mask`
          : `"${name}" is not in the grant`;
        return { allowed: false, reason, grant: standing.id, missing: wanted };
      }
      if (found.ask) {
        return { allowed: false, reason: "ask", asks: true, grant: standing.id, rule: ruleText(found), missing: wanted };
      }
      return { allowed: true, grant: standing.id, rule: ruleText(found) };
    }
  }
}

/** What a rule that asks needs to put its question to the owner. */
export interface SettleAsk {
  readonly caller: Caller;
  readonly name: string;
  readonly target?: string;
  readonly input: unknown;
  readonly reason?: string;
  /** Without it, a rule that asks is a denial: nobody is asked. */
  readonly ask?: Ask;
}

/**
 * The answer of a `permit` that asks, settled: the owner is asked about the call and the answer
 * lets it through or not. Anything else a `permit` said is returned as it is. Only a client with a
 * principal is asked for; for any other caller a rule that asks is a call nobody answered.
 */
export async function settleAsk(access: Permit, call: SettleAsk): Promise<Permit> {
  if (access.allowed || access.asks !== true || access.grant === undefined || access.rule === undefined) return access;
  const { grant, rule } = access;
  const { caller } = call;
  const outcome =
    call.ask === undefined || caller.kind !== "client" || caller.principal === undefined
      ? "unanswered"
      : await call.ask({
          principal: caller.principal,
          grant,
          name: call.name,
          ...(call.target === undefined ? {} : { target: call.target }),
          rule,
          input: call.input,
          ...(call.reason === undefined ? {} : { reason: call.reason }),
        });
  return outcome === "unanswered" || outcome === "refused"
    ? { ...access, reason: outcome === "refused" ? REFUSED_BY_OWNER : NOT_ANSWERED }
    : { allowed: true, grant, rule, answered: outcome };
}

/** The intercepts registered on one action: the adjusts and the guards, in registration order. */
export interface Intercepts {
  readonly adjusts: AdjustFn<any>[];
  readonly guards: GuardFn<any>[];
}

/** No intercepts at all: what an action nobody touched runs with. */
export const NO_INTERCEPTS: Intercepts = { adjusts: [], guards: [] };

/** A fresh set of intercepts for one action. */
export function newIntercepts(): Intercepts {
  return { adjusts: [], guards: [] };
}

/** The actions whose intercepts are running right now, outermost first. */
const CHAIN = new AsyncLocalStorage<readonly ActionName[]>();

/** Is this value a denial? A guard returns it, and nothing else is a refusal. */
export function isDenial(value: unknown): value is Denial {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "denial" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

/** What was decided about one call. */
export type Decision<I> =
  /** The call may run, with this input. */
  | {
      readonly kind: "allowed";
      readonly requested: I;
      readonly final: I;
      /** What the grant said, when one decided the call. */
      readonly access?: Permit;
    }
  /** A guard refused the call, with this reason. */
  | {
      readonly kind: "denied";
      readonly requested: I;
      readonly final: I;
      readonly reason: string;
      /** What the grant said, when the grant is what refused it. */
      readonly access?: Extract<Permit, { allowed: false }>;
    }
  /** The input did not fit: the requested one, or the one an adjust produced. */
  | {
      readonly kind: "invalid";
      /** Which input did not fit. */
      readonly which: "requested" | "final";
      /** The input as it was requested. */
      readonly requested: unknown;
      /** The input that did not fit. */
      readonly final: unknown;
      /** The issues of the schema that refused it. */
      readonly issues: Issues;
    };

/** What one call needs to be decided. */
export interface DecideOptions<I, In = I> {
  /** The intercepts registered on the action. */
  readonly intercepts: Intercepts;
  /** The action that is being called. */
  readonly action: Action<I, any, In>;
  /** The input as it was requested. */
  readonly input: unknown;
  /** Who is calling. */
  readonly caller: Caller;
  /**
   * The step function of the invocation that is calling the action.
   *
   * It is absent when the call is made outside an invocation: there is no invocation whose step
   * the intercept could make its own call as.
   */
  readonly step?: Step;
  /**
   * What the caller stands on. Given for the call a client makes at the door: a call a running
   * action makes inside itself is the plugin's own work and is not matched against the grant again.
   */
  readonly standing?: Standing;
  /** Why the caller makes the call: it is shown in the question the owner is asked. */
  readonly reason?: string;
  /**
   * Put a question to the owner. Given for the call a client makes at the door; without it a rule
   * that asks is a denial: a step inside an invocation never waits for the owner.
   */
  readonly ask?: Ask;
}

/** Decide one call: a step inside an invocation and a call from outside both come here. */
export async function decide<I, In = I>(opts: DecideOptions<I, In>): Promise<Decision<I>> {
  // An intercept that calls an action whose intercepts are already running is a cycle: it would
  // never end, so the inner call is refused.
  const chain = CHAIN.getStore() ?? [];
  if (chain.includes(opts.action.name)) {
    return {
      kind: "denied",
      requested: opts.input as I,
      final: opts.input as I,
      reason: `intercept cycle: ${[...chain, opts.action.name].join(" -> ")}`,
    };
  }
  return CHAIN.run([...chain, opts.action.name], () => decideIn(opts));
}

async function decideIn<I, In = I>(opts: DecideOptions<I, In>): Promise<Decision<I>> {
  const ctx: InterceptContext = {
    caller: opts.caller,
    action: opts.action.name,
    ...(opts.step === undefined ? {} : { step: opts.step }),
  };

  // 1. The requested input is validated.
  const requested = opts.action.input.safeParse(opts.input);
  if (!requested.success) {
    return {
      kind: "invalid",
      which: "requested",
      requested: opts.input,
      final: opts.input,
      issues: requested.error.issues,
    };
  }

  // 2. The adjusts run, in registration order. An adjust that returns nothing leaves the input
  // as it was: what it changed in the copy it was given is still a change.
  let adjusted: I = requested.data;
  for (const adjust of opts.intercepts.adjusts) {
    // Every adjust gets its own deep copy of the input. An adjust that changes the input in
    // place cannot change what the decision records as the requested input: the copy it
    // changed is not the one the decision holds.
    const own = copyOf(adjusted);
    const changed = await adjust(own, ctx);
    adjusted = changed === undefined ? own : (changed as I);
  }

  // 3. The resulting input is validated again: an adjust cannot smuggle in what the action
  // would refuse. It is validated whatever the adjusts returned: an adjust that changes the input
  // in place has changed it, whether it says so or not. With no adjust at all nothing could have
  // changed it: the input is the one just parsed, and a schema whose output is not its input is
  // not made to parse its own output.
  const checked =
    opts.intercepts.adjusts.length === 0
      ? ({ success: true, data: requested.data } as const)
      : opts.action.input.safeParse(adjusted);
  if (!checked.success) {
    return {
      kind: "invalid",
      which: "final",
      requested: requested.data,
      final: adjusted,
      issues: checked.error.issues,
    };
  }

  // 4. The grant's match: what is not listed is forbidden. It comes before the guards, and a guard
  // cannot lift it: guards only add refusals.
  const target = opts.action.target?.(checked.data);
  let access = opts.standing === undefined ? undefined : permit(opts.standing, "call", opts.action.name, target, opts.action.effect);
  // 4b. A rule that asks: the owner answers, now, about this call. The answer lets it through to
  // the guards, which may still refuse it.
  if (access !== undefined) {
    access = await settleAsk(access, {
      caller: opts.caller,
      name: opts.action.name,
      input: checked.data,
      ...(opts.ask === undefined ? {} : { ask: opts.ask }),
      ...(target === undefined ? {} : { target }),
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    });
  }
  if (access !== undefined && !access.allowed) {
    return { kind: "denied", requested: requested.data, final: checked.data, reason: access.reason, access };
  }

  // 5. The guards run against that final input; one denial is enough.
  for (const guard of opts.intercepts.guards) {
    const answer = await guard(checked.data, ctx);
    if (isDenial(answer)) {
      return {
        kind: "denied",
        requested: requested.data,
        final: checked.data,
        reason: answer.reason,
        ...(access === undefined
          ? {}
          : {
              access: {
                allowed: false as const,
                reason: answer.reason,
                ...(access.grant === undefined ? {} : { grant: access.grant }),
                ...(access.rule === undefined ? {} : { rule: access.rule }),
              },
            }),
      };
    }
  }

  return {
    kind: "allowed",
    requested: requested.data,
    final: checked.data,
    ...(access === undefined ? {} : { access }),
  };
}

/**
 * A deep copy of the input, for one adjust.
 *
 * The copy is what an adjust may change in place: the input the decision records as the
 * requested one is the one the caller asked for, and an adjust that changes its own copy
 * cannot change that.
 *
 * Plain objects, arrays, dates, maps and sets are copied all the way down. Anything else — a
 * question holds its schemas, an input may hold a function or an instance of a class — is a
 * leaf and is passed on as it is: `structuredClone` would refuse the whole input for one such
 * value, and the plain fields next to it would then be changed in place, in the requested input.
 * A leaf that an adjust changes in place is changed for everyone; the input is validated again
 * either way.
 */
function copyOf<I>(input: I): I {
  return copyValue(input, new Map()) as I;
}

function copyValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array<unknown>(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = copyValue(value[i], seen);
    return copy;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(copyValue(k, seen), copyValue(v, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const v of value) copy.add(copyValue(v, seen));
    return copy;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<PropertyKey, unknown> = Object.create(proto) as Record<PropertyKey, unknown>;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) continue;
    copy[key] = copyValue((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return copy;
}
