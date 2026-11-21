/**
 * The pi harness kind: the reading side, the control side and the insert side.
 *
 * pi keeps its sessions in files under its agent directory, and the reading side reads them. The
 * control side drives pi in its RPC mode, in pi's own dialect. The insert side is a plugin inside
 * pi: it reports what cannot be seen from outside — a session opened by hand, a compaction, and a
 * prompt that asks the person.
 *
 * The reading side lives in reading.ts, the control side in control.ts, the insert side in
 * insert/; this file names the kind and says where pi's sessions are.
 */

import { dirname, resolve } from "node:path";

import { ADMITTED, KIND_OPTIONS, UNSUPPORTED, VERIFIED, defineHarnessKind } from "@niwa-labs/harness";
import type { HarnessKindDefinition, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { installPiInsert } from "./insert/index.ts";
import { PI_LAUNCH, PiControl } from "./control.ts";
import type { PiControlOptions } from "./control.ts";
import { piReading } from "./reading.ts";
import type { PiReadingOptions } from "./reading.ts";

/** The id of the pi harness kind. */
export const PI_KIND = "pi";

/**
 * The sides a pi instance has by default.
 *
 * The reading side lists and reads the sessions pi writes; it does not follow a session while it
 * grows. The control side starts, resumes, sends, interrupts and stops a session, in pi's RPC
 * mode. It cannot ask: pi asks its questions through its own extension protocol, so a question
 * cannot be put to a pi session from here. Its `ask` returns no structured value either. What pi
 * asks in the middle of a run (the dialogs of its extensions) is routed as reverse requests.
 *
 * A session can be held to an allow-list of pi's own tools, but not to niwa's tools alone: pi's RPC
 * mode takes no MCP server, and the tools niwa would bring through an extension of pi are not wired
 * in, so such a session would have no tool at all. The role asking for it falls back to another kind.
 */
export const piSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: false,
    structuredOutput: false,
    launch: PI_LAUNCH,
    tools: { niwaOnly: false, allow: true },
  },
};

/**
 * What the kind declares it can serve, proved against a live pi. pi asks its questions through
 * its own extension protocol, so it cannot be asked from here.
 */
export const PI_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: UNSUPPORTED,
    structuredOutput: UNSUPPORTED,
    launch: { model: VERIFIED, effort: PI_LAUNCH.effort, modes: PI_LAUNCH.modes },
    tools: { niwaOnly: UNSUPPORTED, allow: ADMITTED },
  },
  // The insert is a file in pi's extensions directory. A pi opened by hand that loads it and reports to the
  // host is proved live (`manualOpen`); a compaction needs a model run and is admitted from pi's documented
  // event. A question pi asks the person is the person's to answer at pi's prompt: the answer cannot go back
  // from here, so the kind does not claim a permission route.
  insert: { nested: UNSUPPORTED, compaction: ADMITTED, manualOpen: VERIFIED, permission: UNSUPPORTED, end: ADMITTED },
};

/** What the kind needs: the installation that is read, and how its sides are set up. */
export interface PiKindOptions extends PiReadingOptions {
  /**
   * How the control side is set up: the pi it drives and the model it asks for.
   *
   * Its own defaults are used when it is absent: the `pi` on the PATH, and the model pi has of
   * its own.
   */
  readonly control?: Omit<PiControlOptions, "harness">;
}

/**
 * The pi kind, with its reading side, its control side and its insert side.
 *
 * The options say which installation is being read: the id the owner gave it, and where pi keeps
 * its sessions. The insert is put into the agent directory of that installation, which is the
 * parent of its sessions root (`<home>/sessions`): the extension is written to `<home>/extensions`.
 */
export function pi(options: PiKindOptions): HarnessKindDefinition {
  return defineHarnessKind({
    name: PI_KIND,
    reading: piReading(options),
    control: new PiControl({ harness: options.harness, ...(options.control ?? {}) }),
    insert: {
      install: async (opts) => {
        await installPiInsert(dirname(resolve(options.sessionsRoot)), {
          home: opts.home,
          harness: options.harness,
          ...(opts.cli === undefined ? {} : { cli: opts.cli }),
        });
      },
    },
    capabilities: PI_CAPABILITIES,
    detect: PI_DETECTION,
    options: KIND_OPTIONS.pi,
  });
}

/**
 * How a pi installation is found.
 *
 * pi is a library niwa reads the files of, and a program niwa runs: the program is the `pi` on
 * the PATH, and the directory pi keeps its sessions in is all there is.
 */
const PI_DETECTION = {
  binary: "pi",
  home: "~/.pi/agent",
} as const;

export { PI_RAW_SCHEMA, piReading } from "./reading.ts";
export type { PiReadingOptions } from "./reading.ts";
export { PiControl, PI_CONTROL_CAPABILITIES, PI_LAUNCH, piToolFlags, piToolsModeFlags } from "./control.ts";
export type { PiControlOptions, PiSessionControl } from "./control.ts";

export { piSkills } from "./skills.ts";

export { PI_EXTENSION_FILE, PI_HARNESS, PI_INSTANCE_ENV, PiInsert, installPiInsert, piExtensionSource, piSession, default as niwaPiExtension } from "./insert/index.ts";
export type {
  InsertReporter,
  PiExtensionApi,
  PiExtensionContext,
  PiInsertOptions,
  PiSessionCompact,
  PiSessionShutdown,
  PiSessionInfo,
  PiSessionStart,
  PiUiPromptStart,
} from "./insert/index.ts";
