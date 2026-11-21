/**
 * What a kind declares it can serve: every ability, one by one, with no default.
 *
 * A kind says of each ability that it is `supported` or `unsupported`; a supported one is
 * `verified` (proved against a live harness) or `admitted` (taken from the harness's own
 * documentation or code). A new ability in this contract is a new decision for every kind, and a
 * kind that leaves one out does not register.
 *
 * An instance is an installation of a kind, and what it may claim is bounded by the declaration:
 * what is found on a machine can narrow it, never widen it.
 */

import { z } from "zod";

import { SessionModeSchema } from "./capabilities.ts";
import type { SideCapabilities } from "./capabilities.ts";
import type { Harness } from "./instance.ts";

/** One ability, as a kind declares it. */
export const SupportSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false) }).strict(),
  z.object({ supported: z.literal(true), status: z.enum(["verified", "admitted"]) }).strict(),
]);
export type Support = z.output<typeof SupportSchema>;

/** Supported, and proved against a live harness. */
export const VERIFIED: Support = { supported: true, status: "verified" };
/** Supported by the harness's own documentation or code, not yet proved live. */
export const ADMITTED: Support = { supported: true, status: "admitted" };
/** Not supported. */
export const UNSUPPORTED: Support = { supported: false };

export const ReadingDeclarationSchema = z
  .object({ list: SupportSchema, read: SupportSchema, watch: SupportSchema })
  .strict();

export const LaunchDeclarationSchema = z
  .object({
    model: SupportSchema,
    /** The effort levels a session can be started with; none when the kind takes no effort. */
    effort: z.array(z.string().min(1)).readonly(),
    /** The working modes a session can be started in. */
    modes: z.array(SessionModeSchema).readonly(),
  })
  .strict();

/**
 * The tool modes a kind can hold a session to (`StartOptions.tools`) beyond `all`: only niwa's
 * tools, and an allow-list of the harness's own.
 */
export const ToolsDeclarationSchema = z.object({ niwaOnly: SupportSchema, allow: SupportSchema }).strict();

export const ControlDeclarationSchema = z
  .object({
    start: SupportSchema,
    resume: SupportSchema,
    send: SupportSchema,
    interrupt: SupportSchema,
    ask: SupportSchema,
    structuredOutput: SupportSchema,
    launch: LaunchDeclarationSchema,
    tools: ToolsDeclarationSchema,
  })
  .strict();

export const InsertDeclarationSchema = z
  .object({ nested: SupportSchema, compaction: SupportSchema, manualOpen: SupportSchema, permission: SupportSchema })
  .strict();

/** Every ability of every side. A side the kind has no code for declares all of its abilities unsupported. */
export const KindCapabilitiesSchema = z
  .object({
    reading: ReadingDeclarationSchema,
    control: ControlDeclarationSchema,
    insert: InsertDeclarationSchema,
  })
  .strict();
export type KindCapabilities = z.output<typeof KindCapabilitiesSchema>;

/** A control side that declares nothing: for a kind without one. */
export const NO_CONTROL: KindCapabilities["control"] = {
  start: UNSUPPORTED,
  resume: UNSUPPORTED,
  send: UNSUPPORTED,
  interrupt: UNSUPPORTED,
  ask: UNSUPPORTED,
  structuredOutput: UNSUPPORTED,
  launch: { model: UNSUPPORTED, effort: [], modes: [] },
  tools: { niwaOnly: UNSUPPORTED, allow: UNSUPPORTED },
};

/** An insert side that declares nothing: for a kind without one. */
export const NO_INSERT: KindCapabilities["insert"] = {
  nested: UNSUPPORTED,
  compaction: UNSUPPORTED,
  manualOpen: UNSUPPORTED,
  permission: UNSUPPORTED,
};

/** A reading side that declares nothing: for a kind without one. */
export const NO_READING: KindCapabilities["reading"] = { list: UNSUPPORTED, read: UNSUPPORTED, watch: UNSUPPORTED };

function on(support: Support): boolean {
  return support.supported;
}

function anyOn(side: Readonly<Record<string, unknown>>): boolean {
  return Object.values(side).some((value) => SupportSchema.safeParse(value).data?.supported === true);
}

/**
 * The sides an installation of the kind has when nothing narrows them: every supported ability
 * on, the rest off. A side with no supported ability is absent.
 */
export function sidesOf(declared: KindCapabilities): SideCapabilities {
  const { reading, control, insert } = declared;
  return {
    ...(anyOn(reading) ? { reading: { list: on(reading.list), read: on(reading.read), watch: on(reading.watch) } } : {}),
    ...(anyOn(control)
      ? {
          control: {
            start: on(control.start),
            resume: on(control.resume),
            send: on(control.send),
            interrupt: on(control.interrupt),
            ask: on(control.ask),
            structuredOutput: on(control.structuredOutput),
            launch: { model: on(control.launch.model), effort: [...control.launch.effort], modes: [...control.launch.modes] },
            tools: { niwaOnly: on(control.tools.niwaOnly), allow: on(control.tools.allow) },
          },
        }
      : {}),
    ...(anyOn(insert)
      ? {
          insert: {
            nested: on(insert.nested),
            compaction: on(insert.compaction),
            manualOpen: on(insert.manualOpen),
            permission: on(insert.permission),
          },
        }
      : {}),
  };
}

/**
 * What `sides` claims beyond the declaration, one line each: an ability the kind does not
 * support, a side whose code the kind does not have, a model choice, an effort level or a working
 * mode the kind does not declare. Empty when the sides stay within it.
 */
export function excessOf(
  sides: SideCapabilities,
  declared: KindCapabilities,
  implemented: { readonly reading: boolean; readonly control: boolean; readonly insert: boolean },
): string[] {
  const excess: string[] = [];
  const check = (side: string, claimed: Readonly<Record<string, unknown>> | undefined, allowed: Readonly<Record<string, unknown>>) => {
    if (claimed === undefined) return;
    for (const [ability, value] of Object.entries(claimed)) {
      if (value !== true) continue;
      const support = SupportSchema.safeParse(allowed[ability]);
      if (!support.success || !support.data.supported) excess.push(`${side}.${ability}`);
    }
  };
  for (const side of ["reading", "control", "insert"] as const) {
    if (sides[side] !== undefined && !implemented[side]) excess.push(`${side} (the kind has no ${side} side)`);
  }
  check("reading", sides.reading, declared.reading);
  check("insert", sides.insert, declared.insert);
  if (sides.control !== undefined) {
    const { launch, tools, ...abilities } = sides.control;
    check("control", abilities, declared.control);
    if (tools !== undefined) check("control.tools", tools, declared.control.tools);
    if (launch.model && !declared.control.launch.model.supported) excess.push("control.launch.model");
    for (const level of launch.effort) {
      if (!declared.control.launch.effort.includes(level)) excess.push(`control.launch.effort "${level}"`);
    }
    for (const mode of launch.modes) {
      if (!declared.control.launch.modes.includes(mode)) excess.push(`control.launch.modes "${mode}"`);
    }
  }
  return excess;
}

/** An installation claims what its kind cannot serve. */
export class CapabilityExceeded extends Error {
  override name = "CapabilityExceeded";
  readonly code = "CapabilityExceeded";

  constructor(
    readonly harness: Harness["id"],
    readonly kind: string,
    readonly excess: readonly string[],
  ) {
    super(`harness "${harness}" claims what its kind "${kind}" cannot serve: ${excess.join(", ")}`);
  }
}

/**
 * Narrow the declared sides by what was found on a machine. What was found may switch an ability
 * off; claiming one the declaration does not have is an error, never a widening.
 */
export function narrowSides(
  harness: Harness["id"],
  kind: string,
  declared: KindCapabilities,
  found: SideCapabilities,
  implemented: { readonly reading: boolean; readonly control: boolean; readonly insert: boolean },
): SideCapabilities {
  const excess = excessOf(found, declared, implemented);
  if (excess.length > 0) throw new CapabilityExceeded(harness, kind, excess);
  return found;
}
