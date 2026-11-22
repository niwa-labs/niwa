/**
 * The OpenCode harness kind.
 *
 * It reads local history from SQLite and controls sessions over the OpenCode v2 HTTP server,
 * with one `opencode serve --stdio` child per controlled session. It has no insert side.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { NO_INSERT, NoOptions, UNSUPPORTED, VERIFIED, defineHarnessKind, kindOptions } from "@niwa-labs/harness";
import type { HarnessBinding, InstanceOptions, KindCapabilities, SideCapabilities } from "@niwa-labs/harness";

import { OPENCODE_LISTENER, xdgRootsOf } from "./box.ts";
import { OPENCODE_LAUNCH, opencodeControl } from "./control.ts";
import type { OpenCodeControlOptions } from "./control.ts";
import { OpenCodeReading } from "./reading.ts";
import { installationHome } from "./server.ts";

export { OpenCodeReading } from "./reading.ts";
export type { OpenCodeReadingOptions } from "./reading.ts";
export { opencodeControl, OPENCODE_LAUNCH } from "./control.ts";
export type { OpenCodeControlOptions, OpenCodePermissionPolicy, OpenCodeSessionControl } from "./control.ts";

/**
 * The sides an OpenCode instance has by default.
 *
 * The reading side lists and reads the sessions opencode keeps; it does not follow a session while
 * it grows. The control side starts, resumes, sends, interrupts and asks; the session is asked for
 * JSON that matches the schema, and the control side validates the answer: `ask` returns a value
 * that passed the schema.
 */
export const opencodeSides: SideCapabilities = {
  reading: { list: true, read: true, watch: false },
  control: {
    start: true,
    resume: true,
    send: true,
    interrupt: true,
    ask: true,
    structuredOutput: true,
    launch: OPENCODE_LAUNCH,
    tools: { niwaOnly: false, allow: false },
  },
};

/**
 * What the kind declares it can serve. Everything but watch and tools was proved against a live
 * opencode v2 server (`test/live/control.test.ts`): sessions started, resumed, sent, interrupted
 * and asked by schema, and read back from the server's own storage. Watching a session while it
 * grows and holding one to a tool set are not served.
 */
export const OPENCODE_CAPABILITIES: KindCapabilities = {
  reading: { list: VERIFIED, read: VERIFIED, watch: UNSUPPORTED },
  control: {
    start: VERIFIED,
    resume: VERIFIED,
    send: VERIFIED,
    interrupt: VERIFIED,
    ask: VERIFIED,
    structuredOutput: VERIFIED,
    launch: { model: VERIFIED, effort: [], modes: OPENCODE_LAUNCH.modes },
    tools: { niwaOnly: UNSUPPORTED, allow: UNSUPPORTED },
  },
  insert: NO_INSERT,
};

/** The block an OpenCode session takes at its start: `opencode`, with no option of its own yet. */
export const OPENCODE_OPTIONS = kindOptions("opencode", NoOptions);

/** How an OpenCode installation is found: the program that runs it, and the directory it keeps its state in. */
const OPENCODE_DETECTION = {
  binary: "opencode",
  home: "~/.local/share/opencode",
  homeFromEnv: { variable: "XDG_DATA_HOME", subdirectory: "opencode" },
  majorVersion: 2,
} as const;

/** What an installation of OpenCode is given: its id, home and model, and how its control side is set up. */
export interface OpenCodeInstanceOptions extends InstanceOptions {
  /** The state directory, ending in `opencode`. Defaults to `$XDG_DATA_HOME/opencode`. */
  readonly home?: string;
  /**
   * Launch settings for this installation. Both sides use the same data directory and database
   * selection. The model of the installation (`model`) is a `providerId/modelId`.
   */
  readonly control?: Omit<OpenCodeControlOptions, "harness" | "home" | "model">;
}

/** What the caller names of one installation: every part has a default. */
export type OpenCodeOptions = Partial<OpenCodeInstanceOptions>;

function binaryOf({ binary, control }: OpenCodeOptions): string {
  const named = control?.binary ?? binary?.path ?? OPENCODE_DETECTION.binary;
  // The executable must resolve before a session changes the working directory.
  if (/[\\/]/.test(named)) return resolve(named.startsWith("~/") ? join(homedir(), named.slice(2)) : named);
  return Bun.which(named, { PATH: control?.env?.["PATH"] ?? process.env["PATH"] }) ?? named;
}

function defaultHome({ control }: OpenCodeInstanceOptions): string {
  const { variable, subdirectory } = OPENCODE_DETECTION.homeFromEnv;
  const data = control?.env?.[variable] ?? process.env[variable];
  const userHome = control?.env?.[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
  return resolve(data || join(userHome, ".local", "share"), subdirectory);
}

/**
 * The kind "opencode". Both sides use the installation's data directory.
 * OpenCode stores data under `$XDG_DATA_HOME/opencode`, defaulting to `~/.local/share/opencode`.
 */
export const opencodeKind = defineHarnessKind<OpenCodeInstanceOptions>({
  name: "opencode",
  capabilities: OPENCODE_CAPABILITIES,
  implements: ["reading", "control"],
  sides: opencodeSides,
  detect: OPENCODE_DETECTION,
  options: OPENCODE_OPTIONS,
  home: defaultHome,
  // OpenCode initializes its app directories on boot. The host provides a separate temporary directory.
  profile: {
    status: "admitted",
    of: (options) => {
      const binary = binaryOf(options);
      const data = installationHome(options.home);
      const configured = options.control?.env;
      return ({ home, env, bin }) => {
        const roots = xdgRootsOf({ ...env, ...configured }, home, process.cwd());
        return {
          read: bin(binary),
          write: [
            data,
            join(roots.XDG_CONFIG_HOME, "opencode"),
            join(roots.XDG_STATE_HOME, "opencode"),
            join(roots.XDG_CACHE_HOME, "opencode"),
          ],
          listen: OPENCODE_LISTENER,
        };
      };
    },
  },
  bind: (options) => {
    const { id, home, model, control } = options;
    const shared = {
      harness: id,
      home,
      ...(control?.env === undefined ? {} : { env: control.env }),
    };
    return {
      reading: new OpenCodeReading(shared),
      control: opencodeControl({ ...control, ...shared, binary: binaryOf(options), ...(model === undefined ? {} : { model }) }),
    };
  },
});

/** One OpenCode installation, with the default id `opencode`. */
export function opencode(options: OpenCodeOptions = {}): HarnessBinding {
  return opencodeKind.bind({ ...options, id: options.id ?? "opencode" });
}

export { opencodeSkills } from "./skills.ts";
