/**
 * The harness instance: one concrete installation of a harness kind on one machine
 *. The id belongs to the instance, not to the kind.
 */

import { z } from "zod";

import { SideCapabilitiesSchema } from "./capabilities.ts";

/** The id of a harness instance: "claude-personal", "mcode-work". */
export const HarnessIdSchema = z
  .string()
  .regex(/^\S+$/, "a harness id must be non-empty and contain no whitespace")
  .brand<"HarnessId">();
export type HarnessId = z.output<typeof HarnessIdSchema>;

/** The id of a harness kind: the code that serves an instance. */
export const HarnessKindSchema = z
  .string()
  .regex(/^\S+$/, "a harness kind must be non-empty and contain no whitespace")
  .brand<"HarnessKind">();
export type HarnessKind = z.output<typeof HarnessKindSchema>;

/** The id of a machine: where an instance lives. */
export const MachineIdSchema = z
  .string()
  .regex(/^\S+$/, "a machine id must be non-empty and contain no whitespace")
  .brand<"MachineId">();
export type MachineId = z.output<typeof MachineIdSchema>;

/** The binary of an installation; an SDK has none. */
export const HarnessBinarySchema = z.object({
  path: z.string().min(1),
  version: z.string().min(1),
});
export type HarnessBinary = z.output<typeof HarnessBinarySchema>;

/** Which sides an installation has and what each can do. */
export const HarnessSidesSchema = SideCapabilitiesSchema;
export type HarnessSides = z.output<typeof HarnessSidesSchema>;

/** A harness instance, as it is declared. */
export const HarnessSchema = z.object({
  id: HarnessIdSchema,
  kind: HarnessKindSchema,
  machine: MachineIdSchema,
  binary: HarnessBinarySchema.optional(),
  /** The directory of its settings and sessions. */
  home: z.string().min(1),
  sides: HarnessSidesSchema,
});
export type Harness = z.output<typeof HarnessSchema>;

export function harnessId(value: string): HarnessId {
  return HarnessIdSchema.parse(value);
}

export function harnessKind(value: string): HarnessKind {
  return HarnessKindSchema.parse(value);
}

export function machineId(value: string): MachineId {
  return MachineIdSchema.parse(value);
}
