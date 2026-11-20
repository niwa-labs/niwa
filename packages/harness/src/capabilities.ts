/**
 * What each side of a harness declares it can do, and how niwa refuses the rest
 *.
 *
 * - `Unsupported`: the ability is not declared. A fact about the kind, known before the call.
 * - `Unavailable`: the ability is declared, but this installation cannot serve it right now.
 *
 * An undeclared ability is never emulated: a side that cannot list sessions refuses, it does not
 * return an empty list.
 */

import { z } from "zod";

import type { Harness } from "./instance.ts";
import type { KindOptions, OptionBlocks } from "./options.ts";

/** The three sides of a harness. */
export type HarnessSide = "reading" | "control" | "insert";

export const ReadingCapabilitiesSchema = z.object({
  list: z.boolean(),
  read: z.boolean(),
  /** Following a session while it grows. */
  watch: z.boolean(),
});
export type ReadingCapabilities = z.output<typeof ReadingCapabilitiesSchema>;

/**
 * The working mode of a session, chosen once at its start: `ask` asks before file changes, `auto`
 * works freely in its working folder and leaves the rest to the harness's own mechanism, `full`
 * has full access and is never asked.
 */
export const SessionModeSchema = z.enum(["ask", "auto", "full"]);
export type SessionMode = z.output<typeof SessionModeSchema>;

/** The mode of a session started with none chosen, by the call or by the instance. */
export const DEFAULT_SESSION_MODE: SessionMode = "auto";

export const LaunchCapabilitiesSchema = z.object({
  model: z.boolean(),
  effort: z.array(z.string()),
  /** The modes the kind can give a session. */
  modes: z.array(SessionModeSchema).default([]),
});
export type LaunchCapabilities = z.output<typeof LaunchCapabilitiesSchema>;

export const ControlCapabilitiesSchema = z.object({
  start: z.boolean(),
  resume: z.boolean(),
  send: z.boolean(),
  interrupt: z.boolean(),
  /** An answer by schema, natively or through "submit answer". */
  ask: z.boolean(),
  /**
   * The control side's `ask` returns a value that already passed the schema.
   *
   * Without it the control side has no such `ask`: niwa gives the session the action to submit an
   * answer, and the session calls it. A kind declares it in the sides it offers by default; the
   * instance inherits it from there.
   */
  structuredOutput: z.boolean().default(false),
  /**
   * What the control side applies to a session when it starts it: the session keeps it for its
   * whole life, and no start with another value is made up for it.
   *
   * `model` says whether a model can be chosen; `effort` lists the levels it accepts, none when
   * it accepts no effort; `modes` lists the working modes it can give. A request outside this is
   * refused before the session is started.
   */
  launch: LaunchCapabilitiesSchema.default({ model: false, effort: [], modes: [] }),
});
export type ControlCapabilities = z.output<typeof ControlCapabilitiesSchema>;

export const InsertCapabilitiesSchema = z.object({
  /** Reports that a nested session was spawned. */
  nested: z.boolean(),
  /** Reports that the context was compacted. */
  compaction: z.boolean(),
  /** Reports that the owner opened a session by hand. */
  manualOpen: z.boolean(),
  /** Reports that a tool asks for permission. */
  permission: z.boolean(),
});
export type InsertCapabilities = z.output<typeof InsertCapabilitiesSchema>;

/**
 * Which sides an installation has and what each can do. An absent side does not exist; every call
 * to it is refused.
 */
export const SideCapabilitiesSchema = z.object({
  reading: ReadingCapabilitiesSchema.optional(),
  control: ControlCapabilitiesSchema.optional(),
  insert: InsertCapabilitiesSchema.optional(),
});
export type SideCapabilities = z.output<typeof SideCapabilitiesSchema>;

/** The ability names of each side. */
export interface SideAbilities {
  reading: keyof ReadingCapabilities;
  control: Exclude<keyof ControlCapabilities, "launch">;
  insert: keyof InsertCapabilities;
}

/** The ability is not declared for that side. */
export class Unsupported extends Error {
  override name = "Unsupported";
  readonly code = "Unsupported";

  constructor(
    readonly harness: Harness["id"],
    readonly side: HarnessSide,
    readonly ability: string,
    detail?: string,
  ) {
    super(
      `harness "${harness}" does not support ${side}.${ability}` + (detail ? `: ${detail}` : ""),
    );
  }
}

/** The ability is declared, but this installation cannot serve it right now. */
export class Unavailable extends Error {
  override name = "Unavailable";
  readonly code = "Unavailable";

  constructor(
    readonly harness: Harness["id"],
    readonly side: HarnessSide,
    readonly ability: string,
    detail?: string,
  ) {
    super(
      `harness "${harness}" cannot serve ${side}.${ability} right now` +
        (detail ? `: ${detail}` : ""),
    );
  }
}

/** Whether the instance declares the ability. */
export function supports<S extends HarnessSide>(
  instance: Harness,
  side: S,
  ability: SideAbilities[S],
): boolean {
  const declared: Partial<Record<string, unknown>> | undefined = instance.sides[side];
  return declared?.[ability] === true;
}

/** Refuse with `Unsupported`, before anything is attempted, when the ability is not declared. */
export function requireAbility<S extends HarnessSide>(
  instance: Harness,
  side: S,
  ability: SideAbilities[S],
): void {
  if (!supports(instance, side, ability)) {
    throw new Unsupported(
      instance.id,
      side,
      ability,
      instance.sides[side] === undefined ? `the ${side} side does not exist` : undefined,
    );
  }
}

/** The mode a session starts in: the call's, else the instance's, else the default for every harness. */
export function modeOf(requested: SessionMode | undefined, instance: SessionMode | undefined): SessionMode {
  return requested ?? instance ?? DEFAULT_SESSION_MODE;
}

/**
 * Refuse with `Unsupported`, before a session is started, a model, an effort or a mode the kind
 * cannot apply at launch. The error says what the kind does support; nothing is dropped.
 */
export function requireLaunch(
  harness: Harness["id"],
  launch: LaunchCapabilities,
  requested: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly mode?: SessionMode | undefined;
  },
): void {
  if (requested.mode !== undefined && !launch.modes.includes(requested.mode)) {
    throw new Unsupported(
      harness,
      "control",
      "start",
      launch.modes.length === 0
        ? `it has no working modes (asked for "${requested.mode}")`
        : `the mode "${requested.mode}" is not one of ${launch.modes.join(", ")}; ` +
            "choose one of them for the session, or set `control.mode` on the instance",
    );
  }
  if (requested.model !== undefined && requested.model !== "" && !launch.model) {
    throw new Unsupported(harness, "control", "start", `it cannot choose a model per session (asked for "${requested.model}")`);
  }
  if (requested.effort !== undefined && requested.effort !== "" && !launch.effort.includes(requested.effort)) {
    throw new Unsupported(
      harness,
      "control",
      "start",
      launch.effort.length === 0
        ? `it accepts no effort (asked for "${requested.effort}")`
        : `effort "${requested.effort}" is not one of ${launch.effort.join(", ")}`,
    );
  }
}

/**
 * Refuse with `Unsupported`, before a session is started, an options block that is not the one of
 * the kind: a kind takes the block it declares and no other, and nothing is ignored.
 */
export function requireOwnBlocks(harness: Harness["id"], kind: KindOptions | undefined, given: OptionBlocks): void {
  const foreign = Object.entries(given).flatMap(([name, value]) => (value !== undefined && name !== kind?.block ? [name] : []));
  if (foreign.length === 0) return;
  throw new Unsupported(
    harness,
    "control",
    "start",
    kind === undefined
      ? `it takes no options (asked for "${foreign.join('", "')}")`
      : `it takes the "${kind.block}" options block only (asked for "${foreign.join('", "')}")`,
  );
}
