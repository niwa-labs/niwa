/**
 * The actions of access: profiles, a grant changed or
 * closed, the switch, and the two that say what a subject may do and why a call was refused.
 *
 * What changes a grant or a profile is the owner's: the host itself and its handlers are too,
 * a client that is not the owner is not. Whether a subject may call these at all is its grant's
 * business, like any other action.
 */

import { z } from "zod";

import {
  accessMine,
  principalSchema,
  action,
  actionName,
  RuleSpecSchema,
  match,
  specsOf,
  DeniedError,
  recordId,
} from "@niwa-labs/core";
import type { Doors } from "./doors.ts";
import type { AccessControl } from "./access-control.ts";
import type { Action, Caller } from "@niwa-labs/core";

const PROFILE_SET = actionName("access.profile.set");
const PROFILE_GET = actionName("access.profile.get");
const GRANT_CHANGE = actionName("access.grant.change");
const GRANT_CLOSE = actionName("access.grant.close");
const SWITCH = actionName("access.switch");
const EXPLAIN = actionName("access.explain");

const MINE = accessMine;

const Rules = z.array(RuleSpecSchema);

const GrantView = z.object({
  id: z.string(),
  principal: principalSchema,
  rules: Rules,
  closed: z.string().optional(),
  parent: z.object({ principal: principalSchema, grant: z.string() }).optional(),
});

function requireOwner(caller: Caller, what: string): void {
  if (caller.kind === "client" && caller.principal?.kind !== "owner") {
    throw new DeniedError(`only the owner ${what}`);
  }
}

/** The actions, over the control that keeps the table. */
export function accessActions(control: AccessControl, doors: () => Doors): Action<any, any>[] {
  return [
    action(PROFILE_SET, {
      description: "Sets a named grant that has no holder (default, rin, wf:<sub-…>). Only the owner. A subject that starts later gets a copy narrowed by its request; the ones that live are not touched.",
      input: z.object({ name: z.string().min(1), rules: Rules }),
      output: z.object({ name: z.string(), rules: Rules }),
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        requireOwner(ctx.caller, "sets a profile");
        return { name: input.name, rules: specsOf(control.setProfile(ctx.caller, input.name, input.rules)) };
      },
    }),
    action(PROFILE_GET, {
      description: "A named grant and whether the owner set it. Without a name: the names that have one.",
      input: z.object({ name: z.string().min(1).optional() }),
      output: z.object({
        names: z.array(z.string()),
        name: z.string().optional(),
        rules: Rules.optional(),
        set: z.boolean().optional(),
      }),
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (input) => {
        const names = control.profileNames();
        if (input.name === undefined) return { names };
        const found = control.profile(input.name);
        if (found === undefined) throw new TypeError(`there is no profile "${input.name}"`);
        return { names, name: input.name, rules: specsOf(found.rules), set: found.set };
      },
    }),
    action(GRANT_CHANGE, {
      description: "Gives a principal another grant. Only the owner. A grant that loses something closes its living children, except the runs that are going; one that only gains leaves them, and what starts next gets the new rights.",
      input: z.object({ principal: principalSchema, rules: Rules }),
      output: z.object({ grant: z.string(), closed: z.array(principalSchema) }),
      recovery: "do-not-repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        requireOwner(ctx.caller, "changes a grant");
        return control.change(ctx.caller, input.principal, input.rules);
      },
    }),
    action(GRANT_CLOSE, {
      description: "Closes the grant of a principal and, with it, the living ones that were born from it, except the runs that are going. Only the owner.",
      input: z.object({ principal: principalSchema, reason: z.string().min(1).optional() }),
      output: z.object({ closed: z.array(principalSchema) }),
      recovery: "do-not-repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        requireOwner(ctx.caller, "closes a grant");
        return { closed: control.close(ctx.caller, input.principal, input.reason ?? "closed by the owner") };
      },
    }),
    action(SWITCH, {
      description: "The emergency switch. `all: off` denies every call of anyone but the owner; `on` lifts it. Only the owner.",
      input: z.object({ all: z.enum(["on", "off"]) }),
      output: z.object({ all: z.enum(["on", "off"]) }),
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        requireOwner(ctx.caller, "moves the switch");
        control.setSwitch(ctx.caller, input.all);
        return { all: input.all };
      },
    }),
    action(MINE, {
      description: "What the caller may do: its own rules. A subject that nothing limits says so.",
      input: z.object({}),
      output: z.object({
        principal: principalSchema.optional(),
        grant: z.string().optional(),
        unlimited: z.boolean(),
        closed: z.string().optional(),
        rules: Rules,
      }),
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (_input, ctx) => control.mine(ctx.caller),
    }),
    action(EXPLAIN, {
      description: "Explains a decision: the rule that decided it, the grant, and the grants it came from. Takes the id of the decision record a refusal names, or of a record a subject wrote.",
      input: z.object({ record: z.string().min(1) }),
      output: z.object({
        record: z.string(),
        outcome: z.enum(["allowed", "denied", "written"]),
        verb: z.string().optional(),
        name: z.string().optional(),
        rule: z.string().optional(),
        reason: z.string().optional(),
        missing: z.string().optional(),
        grant: GrantView.optional(),
        chain: z.array(GrantView),
      }),
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (input) => {
        const table = doors();
        const at = control.recordOf(recordId(input.record));
        if (at === undefined) throw new TypeError(`there is no record "${input.record}"`);
        const view = (entry: ReturnType<typeof table.grantById>): z.infer<typeof GrantView> | undefined =>
          entry === undefined
            ? undefined
            : {
                id: entry.id,
                principal: entry.principal,
                rules: specsOf(entry.grant),
                ...(entry.closed === undefined ? {} : { closed: entry.closed }),
                ...(entry.parent === undefined ? {} : { parent: entry.parent }),
              };
        const decision = control.decisionOf(at);
        const id = decision?.grant ?? (at.actor.kind === "client" ? at.actor.grant : undefined);
        if (decision === undefined && id === undefined) {
          throw new TypeError(`"${input.record}" is neither a decision nor a record written under a grant`);
        }
        const own = id === undefined ? undefined : table.grantById(id);
        // A record a subject wrote has no decision of its own: the rule is the one for its type now.
        const written = decision === undefined && own !== undefined ? match(own.grant, "emit", at.type) : undefined;
        const chain = id === undefined ? [] : table.chainOf(id).slice(1);
        return {
          record: input.record,
          outcome: decision?.outcome ?? "written",
          ...(decision === undefined ? {} : { verb: decision.verb, name: decision.name }),
          ...(decision?.rule === undefined ? {} : { rule: decision.rule }),
          ...(written === undefined ? {} : { rule: `${written.verb}:${written.name}` }),
          ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision?.missing === undefined ? {} : { missing: decision.missing }),
          ...(view(own) === undefined ? {} : { grant: view(own) }),
          chain: chain.flatMap((entry) => view(entry) ?? []),
        };
      },
    }),
  ];
}
