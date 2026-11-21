/**
 * What a script declares, read once for one version of its code.
 *
 * Reading a module is a process of its own (`describe.ts`), and a check, an install, a registration and the start
 * of a run each ask for it. The same code declares the same thing, so what was read is kept under the version of the
 * script, the hash of its source closure (`registry.ts`): an edit of the script or of a file it imports is another
 * version, and is read again. A version a registration of the journal holds is known without reading it.
 *
 * Only what a module did declare is kept; a module that could not be read is read again by the next ask. The box
 * is part of the key: a module that reads outside its folder is read in a box, and fails there.
 *
 * The readings that are going are bounded: each is a process, and the checker shares the cores with them.
 */

import type { WorkflowVersion } from "./records.ts";
import { versionOf } from "./registry.ts";
import { describeScript } from "./describe.ts";
import type { DescribeResult, Described } from "./describe.ts";
import type { ScriptBox } from "./runner.ts";

/** Read a script's module: `describeScript`, or what stands in for it. */
export type ReadModule = (file: string, box?: ScriptBox, run?: string) => Promise<DescribeResult>;

/** How many modules are read at once. */
const READ_BOUND = 4;

/** How many versions are kept. */
const KEPT_LIMIT = 256;

/** Run the work when fewer than `bound` are going; the rest wait their turn, in the order they came. */
function bounded(bound: number): <T>(work: () => Promise<T>) => Promise<T> {
  let going = 0;
  const waiting: Array<() => void> = [];
  return async (work) => {
    // A slot that is handed over stays counted: it goes from the one that ends to the one that waited longest.
    if (going >= bound) await new Promise<void>((turn) => waiting.push(turn));
    else going += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) going -= 1;
      else next();
    }
  };
}

/** The version of the script, or none when a file of it cannot be read: the module then says what stops it. */
function versionNow(file: string): WorkflowVersion | undefined {
  try {
    return versionOf(file);
  } catch {
    return undefined;
  }
}

/** What has been read: by version and box, what the modules declared, and the readings that are going. */
export interface Readings {
  readonly kept: Map<string, Described>;
  readonly going: Map<string, Promise<DescribeResult>>;
  /** Hold a reading to its turn. */
  readonly turn: <T>(work: () => Promise<T>) => Promise<T>;
}

/** The readings of a store of its own. */
export const readings = (bound: number = READ_BOUND): Readings => ({ kept: new Map(), going: new Map(), turn: bounded(bound) });

/** The readings of the process: every host in it asks the same cores. */
const shared = readings();

/** What a describer is given. */
export interface DescriberOptions {
  /** How a module is read; the process of `describeScript` by default. */
  read?: ReadModule;
  /** Where the readings are kept; the process's own by default. */
  readings?: Readings;
  /** What a version declared, when the journal says so: it is then not read. */
  known?: (version: WorkflowVersion, boxed: boolean) => Described | undefined;
}

/** A reading of what a script declares: from what was kept for its version, or from its module. */
export type Describer = (file: string, box?: ScriptBox, run?: string) => Promise<DescribeResult>;

/** A describer over the readings of the process, or over the ones it is given. */
export function describer(options: DescriberOptions = {}): Describer {
  const read = options.read ?? describeScript;
  const { kept, going, turn } = options.readings ?? shared;
  const remember = (key: string, described: Described): void => {
    if (kept.size >= KEPT_LIMIT) {
      for (const oldest of kept.keys()) {
        kept.delete(oldest);
        break;
      }
    }
    kept.set(key, described);
  };
  return async (file, box, run) => {
    const version = versionNow(file);
    // A script that cannot be read has no version: the module says what stopped it.
    if (version === undefined) return turn(() => read(file, box, run));
    const key = `${version}:${box === undefined ? "plain" : "boxed"}`;
    const had = kept.get(key);
    if (had !== undefined) return { described: had };
    const registered = options.known?.(version, box !== undefined);
    if (registered !== undefined) {
      remember(key, registered);
      return { described: registered };
    }
    let reading = going.get(key);
    if (reading === undefined) {
      reading = turn(() => read(file, box, run))
        .then((result) => {
          // A file edited while it was read has another version now: what was read says nothing of it.
          if ("described" in result && versionNow(file) === version) remember(key, result.described);
          return result;
        })
        .finally(() => going.delete(key));
      going.set(key, reading);
    }
    return reading;
  };
}
