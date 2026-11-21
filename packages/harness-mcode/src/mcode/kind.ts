/**
 * What the two MiniMax Code kinds share: `mcode`, the published
 * `@minimax-ai/code`, and `ncode`, the owner's fork of it. They read the same files and speak the
 * same Agent Client Protocol; they differ in the program, the lineage the control side is set up
 * for, and the name of the kind.
 */

import { existsSync } from "node:fs";

import { ADMITTED, NO_INSERT, NoOptions, UNSUPPORTED, VERIFIED, defineHarnessKind, kindOptions } from "@niwa-labs/harness";
import type { HarnessDetection, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { DEFAULT_BINARIES, MCODE_LAUNCH, mcodeControl } from "./control.ts";
import type { McodeControlOptions, MinimaxLineage } from "./control.ts";
import { durablePathOf } from "./durable.ts";
import { DEFAULT_PROFILE, homeOfProfile } from "./paths.ts";
import { McodeReading } from "./reading.ts";

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

/** What an installation of a MiniMax Code kind is given: its id, home and model, and how its control side is set up. */
export interface McodeInstanceOptions extends InstanceOptions {
  /**
   * The account profile the installation belongs to. The control side is started with it, and the
   * home is derived from it (`default` is `~/.minimax`, any other `~/.minimax-<profile>`) when no
   * home is given. Without a profile the control side is started with `--profile default` when the
   * home holds a durable history (the fork of the harness, whose wrapper has a default profile of its
   * own that could move sessions to another home), and without one otherwise. The published build
   * takes no profile: naming one for `mcode` refuses its starts and resumes.
   */
  readonly profile?: string;
  /**
   * How the control side is set up: the account profile it drives and what it does with a permission
   * request. Its own defaults are used when it is absent.
   */
  readonly control?: Omit<McodeControlOptions, "harness" | "lineage" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type McodeOptions = Partial<McodeInstanceOptions>;

/** One of the two kinds: its name, its lineage and how its installation is found. */
export interface MinimaxKindSpec {
  readonly name: "mcode" | "ncode";
  readonly lineage: MinimaxLineage;
  readonly detect: HarnessDetection;
}

/** The profile an installation names, in its own options or its control side's. */
const profileNamed = (options: McodeInstanceOptions): string | undefined => options.profile ?? options.control?.profile;

/** The kind of `spec`. Each installation is bound to its own home, the home of its profile unless it names one. */
export function minimaxKind(spec: MinimaxKindSpec) {
  return defineHarnessKind<McodeInstanceOptions>({
    name: spec.name,
    capabilities: minimaxCapabilities(spec.lineage),
    implements: ["reading", "control"],
    sides: minimaxSides(),
    detect: spec.detect,
    options: kindOptions(spec.name, NoOptions),
    home: (options) => homeOfProfile(profileNamed(options)),
    // Its program, the runtime the program runs on, and the home of its profile (sign-in, sessions,
    // logs, configuration). Its model endpoint depends on the profile: the installation names it (`net`).
    // The published build ran a turn in a box closed to reading with this profile alone; the fork
    // has not been run so yet.
    profile: {
      status: spec.lineage === "upstream" ? "verified" : "admitted",
      of: (options) => ({ bin }) => ({
        read: [...bin(options.control?.binary ?? DEFAULT_BINARIES[spec.lineage]), ...bin("node")],
        write: [options.home],
      }),
    },
    bind: (options) => ({
      reading: new McodeReading({ harness: options.id, home: options.home }),
      control: mcodeControl({
        harness: options.id,
        ...(options.control ?? {}),
        ...(options.model === undefined ? {} : { model: options.model }),
        home: options.home,
        ...profileOf(options, spec.lineage),
        lineage: spec.lineage,
      }),
    }),
  });
}

/**
 * The profile the control side is started with. A profile that is named is passed. Without one the
 * fork of the harness (the one with a durable history in the home) is started with `--profile
 * default`, so that the default profile of its wrapper cannot move sessions to another home; the
 * upstream harness is started without one, whatever its home holds.
 */
function profileOf(options: McodeInstanceOptions & { readonly home: string }, lineage: MinimaxLineage): { profile?: string } {
  const named = profileNamed(options);
  if (named !== undefined) return { profile: named };
  // Upstream `mcode acp` has no --profile option (it exits with its usage text), and its home may hold a
  // durable history too: only the fork's wrapper has a profile of its own to pin.
  if (lineage !== "fork") return {};
  return existsSync(durablePathOf(options.home)) ? { profile: DEFAULT_PROFILE } : {};
}
