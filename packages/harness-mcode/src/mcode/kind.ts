/**
 * What the two MiniMax Code kinds share: `mcode`, the published
 * `@minimax-ai/code`, and `ncode`, the owner's fork of it. They read the same files and speak the
 * same Agent Client Protocol; they differ in the program, the lineage the control side is set up
 * for, and the name of the kind.
 */

import { existsSync } from "node:fs";

import { ADMITTED, KIND_OPTIONS, NO_INSERT, UNSUPPORTED, VERIFIED, defineHarnessKind, harnessId } from "@niwa-labs/harness";
import type { HarnessDetection, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { MCODE_LAUNCH, mcodeControl } from "./control.ts";
import type { McodeControlOptions, MinimaxLineage } from "./control.ts";
import { durablePathOf } from "./durable.ts";
import { DEFAULT_PROFILE, homeOfProfile } from "./paths.ts";
import { McodeReading } from "./reading.ts";
import type { McodeReadingOptions } from "./reading.ts";

/**
 * The sides a MiniMax Code instance has by default.
 *
 * The reading side lists and reads the files MiniMax Code writes; it does not follow a session
 * while it grows. The control side starts, resumes, sends, interrupts and asks; the agent is
 * asked for JSON that matches the schema and the control side validates the answer: `ask` returns
 * a value that passed the schema.
 */
export function minimaxSides(): SideCapabilities {
  return {
    reading: { list: true, read: true, watch: false },
    control: {
      start: true,
      resume: true,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: true,
      launch: MCODE_LAUNCH,
      tools: { niwaOnly: false, allow: false },
    },
  };
}

/**
 * What the two kinds declare they can serve. The upstream build is proved against a live
 * MiniMax Code; of the fork, only a start with a permission answered is proved live, and the rest
 * is taken from the code it shares with the upstream build.
 */
export function minimaxCapabilities(lineage: MinimaxLineage): KindCapabilities {
  const proved = lineage === "upstream" ? VERIFIED : ADMITTED;
  return {
    reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
    control: {
      start: VERIFIED,
      resume: proved,
      send: proved,
      interrupt: proved,
      ask: proved,
      structuredOutput: proved,
      launch: { model: proved, effort: MCODE_LAUNCH.effort, modes: MCODE_LAUNCH.modes },
      tools: { niwaOnly: UNSUPPORTED, allow: UNSUPPORTED },
    },
    insert: NO_INSERT,
  };
}

/** What a kind needs: the installation, and how its control side is set up. */
export interface McodeKindOptions extends McodeReadingOptions {
  /**
   * The account profile the installation belongs to. The control side is started with it, and
   * `mcode()` derives the home from it (`default` is `~/.minimax`, any other `~/.minimax-<profile>`)
   * when no home is given. Without a profile the control side is started with `--profile default`
   * when the home holds a durable history (the fork of the harness, whose wrapper has a default
   * profile of its own that could move sessions to another home), and without one otherwise.
   */
  readonly profile?: string;
  /**
   * How the control side is set up: the model it uses, the account profile it drives and what it
   * does with a permission request. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<McodeControlOptions, "harness" | "lineage">;
}

/** What the caller names of a kind: every part has a default. */
export type McodeOptions = Partial<McodeKindOptions>;

/** One of the two kinds: its name, its lineage and how its installation is found. */
export interface MinimaxKindSpec {
  readonly name: "mcode" | "ncode";
  readonly lineage: MinimaxLineage;
  readonly detect: HarnessDetection;
}

/** The kind of `spec`, bound to the installation the options name. */
export function minimaxKind(spec: MinimaxKindSpec, options: McodeKindOptions) {
  return defineHarnessKind({
    name: spec.name,
    reading: new McodeReading(options),
    control: mcodeControl({
      harness: options.harness,
      ...(options.control ?? {}),
      ...profileOf(options, spec.lineage),
      lineage: spec.lineage,
    }),
    capabilities: minimaxCapabilities(spec.lineage),
    detect: spec.detect,
    options: KIND_OPTIONS[spec.name],
  });
}

/** The kind of `spec` for the installation at `home` (default: the home of the profile, `~/.minimax`). */
export function minimaxInstance(spec: MinimaxKindSpec, options: McodeOptions) {
  const profile = options.profile ?? options.control?.profile;
  return minimaxKind(spec, {
    ...options,
    harness: options.harness ?? harnessId(spec.name),
    home: options.home ?? homeOfProfile(profile),
    ...(profile === undefined ? {} : { profile }),
  });
}

/**
 * The profile the control side is started with. A profile that is named is passed. Without one the
 * fork of the harness (the one with a durable history in the home) is started with `--profile
 * default`, so that the default profile of its wrapper cannot move sessions to another home; the
 * upstream harness is started without one, whatever its home holds.
 */
function profileOf(options: McodeKindOptions, lineage: MinimaxLineage): { profile?: string } {
  const named = options.profile ?? options.control?.profile;
  if (named !== undefined) return { profile: named };
  // Upstream `mcode acp` has no --profile option (it exits with its usage text), and its home may hold a
  // durable history too: only the fork's wrapper has a profile of its own to pin.
  if (lineage !== "fork") return {};
  return existsSync(durablePathOf(options.home)) ? { profile: DEFAULT_PROFILE } : {};
}
