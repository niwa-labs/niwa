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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { ADMITTED, NoOptions, UNSUPPORTED, VERIFIED, defineHarnessKind, kindOptions } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { installPiInsert } from "./insert/index.ts";
import { PI_LAUNCH, PiControl } from "./control.ts";
import type { PiControlOptions } from "./control.ts";
import { piReading } from "./reading.ts";

/** The id of the pi harness kind. */
export const PI_KIND = "pi";

/**
 * The sides a pi instance has by default.
 *
 * The reading side lists and reads the sessions pi writes; it does not follow a session while it
 * grows. The control side starts, resumes, sends, interrupts and stops a session, in pi's RPC
 * mode. pi's RPC mode takes no MCP server, but an extension of pi registers one for a session, so a
 * session is given niwa's actions as pi tools. That is also how it answers a question: pi has no
 * structured output of its own, so it is asked by a request and answers through niwa's `submit-answer`
 * action, which is why `ask` is declared and `structuredOutput` is not. What pi asks in the middle of
 * a run (the dialogs of its extensions) is routed as reverse requests.
 *
 * A session can be held to niwa's tools alone, or to an allow-list of pi's own tools besides them.
 */
export const piSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: false,
    launch: PI_LAUNCH,
    tools: { niwaOnly: true, allow: true },
  },
};

/**
 * What the kind declares it can serve, proved against a live pi: a session that sees niwa's actions
 * calls them, answers a question through `submit-answer`, with niwa's tools alone uses none of
 * pi's own, and with an allow-list of pi's own tools uses those and no other.
 */
export const PI_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: UNSUPPORTED,
    launch: { model: VERIFIED, effort: PI_LAUNCH.effort, modes: PI_LAUNCH.modes },
    tools: { niwaOnly: VERIFIED, allow: VERIFIED },
  },
  // The insert is a file in pi's extensions directory. A pi opened by hand that loads it and reports to the
  // host is proved live (`manualOpen`), and so is the report of a session's end (`end`); a compaction needs a model
  // run and is admitted from pi's documented event. A question pi asks the person is the person's to answer at pi's prompt: the answer cannot go back
  // from here, so the kind does not claim a permission route.
  insert: { nested: UNSUPPORTED, compaction: ADMITTED, manualOpen: VERIFIED, permission: UNSUPPORTED, end: VERIFIED },
};

/** The block a pi session takes at its start: `pi`, with no option of its own yet. */
export const PI_OPTIONS = kindOptions("pi", NoOptions);

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

/** What an installation of pi is given: its id, its agent directory (`home`) and model, and how its control side is set up. */
export interface PiInstanceOptions extends InstanceOptions {
  /** Where pi keeps the sessions, when not in `<home>/sessions`. */
  readonly sessionsRoot?: string;
  /**
   * How the control side is set up: the pi it drives, the thinking level and the environment it
   * runs in. Its own defaults are used when it is absent. The model of the installation (`model`) is
   * in pi's own words (`provider/model`).
   */
  readonly control?: Omit<PiControlOptions, "harness" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type PiOptions = Partial<PiInstanceOptions>;

/**
 * The pi kind. Each installation is bound to its own agent directory (`home`, default
 * `~/.pi/agent`): its sessions are read from `<home>/sessions`, its processes run with that home, and
 * its insert is put into `<home>/extensions`.
 */
export const piKind = defineHarnessKind<PiInstanceOptions>({
  name: PI_KIND,
  capabilities: PI_CAPABILITIES,
  implements: ["reading", "control", "insert"],
  sides: piSides,
  detect: PI_DETECTION,
  options: PI_OPTIONS,
  home: () => join(homedir(), ".pi", "agent"),
  // Its launcher, the managed install the launcher runs (beside the launcher's real path) with the
  // runtime pi's installer put in place, and the agent directory: sign-in, sessions, settings,
  // extensions. Its model endpoint is the provider's: the installation names it (`net`). A session
  // ran a turn in a box closed to reading with this profile alone.
  profile: {
    status: "verified",
    of: ({ home, sessionsRoot, control }) => ({ home: user, env, bin }) => {
      const launcher = bin(control?.binary ?? "pi");
      const installs = launcher
        .filter((path) => basename(dirname(path)) === "bin")
        .map((path) => join(dirname(dirname(path)), "install"))
        .filter((install) => existsSync(join(install, "current-version")));
      // The install and the runtime are programs too: through `bin`, so no other box finds them closed.
      const runtime = join(env["XDG_DATA_HOME"] ?? join(user, ".local", "share"), "pi-node");
      return {
        read: [...launcher, ...installs.flatMap((install) => bin(install)), ...bin(runtime), ...bin("node")],
        write: [home, ...(sessionsRoot === undefined ? [] : [sessionsRoot])],
      };
    },
  },
  bind: ({ id, home, model, sessionsRoot, control }) => {
    const root = sessionsRoot ?? join(home, "sessions");
    return {
      reading: piReading({ harness: id, sessionsRoot: root }),
      control: new PiControl({ ...(control ?? {}), ...(model === undefined ? {} : { model }), harness: id, home }),
      insert: {
        install: async (opts) => {
          await installPiInsert(dirname(resolve(root)), {
            home: opts.home,
            harness: id,
            ...(opts.cli === undefined ? {} : { cli: opts.cli }),
          });
        },
      },
    };
  },
});

/** One installation of pi: `pi` at `~/.pi/agent` unless the options say otherwise. */
export function pi(options: PiOptions = {}): HarnessBinding {
  return piKind.bind({ ...options, id: options.id ?? PI_KIND });
}

export { PI_RAW_SCHEMA, piReading } from "./reading.ts";
export type { PiReadingOptions } from "./reading.ts";
export { PiControl, PI_CONTROL_CAPABILITIES, PI_LAUNCH, piToolFlags, piToolsModeFlags } from "./control.ts";
export type { PiControlOptions, PiSessionControl } from "./control.ts";

export { default as niwaPiTools, PI_MCP_SERVERS_ENV, decodeServers, encodeServers, piToolPattern } from "./mcp/index.ts";
export type { PiMcpApi, PiMcpServer, PiMcpServerConfig } from "./mcp/index.ts";

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
