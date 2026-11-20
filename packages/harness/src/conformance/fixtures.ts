/**
 * The fixtures of the reading conformance suite.
 *
 * The suite runs the same four small synthetic sessions against every kind. The kind writes them
 * in its own on-disk format; niwa never writes a harness's files, because it does not know them.
 */

import type { SessionId } from "../reading.ts";

/** The four scenarios. Every kind provides all four: a skipped scenario would be a free pass. */
export const SCENARIOS = ["running", "nested", "compaction", "broken"] as const;

export type Scenario = (typeof SCENARIOS)[number];

/**
 * What a writer wrote. One session per scenario, in a directory the suite created.
 *
 * Every scenario holds at least a human message and an answer, so the common kinds can be
 * checked in each. On top of that:
 *
 * - `running` — the last line is half written, and `finish` completes it;
 * - `nested` — a session was spawned inside; its id is `child`;
 * - `compaction` — the harness replaced the context with a summary, `summary`;
 * - `broken` — a whole line that the harness's format does not know.
 */
export interface FixtureResult {
  readonly session: SessionId;
  /** `nested`: the session spawned inside `session`. */
  readonly child?: SessionId;
  /** `compaction`: the summary the harness wrote. */
  readonly summary?: string;
  /** `running`: completes the half-written last line. */
  readonly finish?: () => Promise<void>;
  /** Makes the session unreadable while it is still there, so a scan of it fails. */
  readonly makeUnreadable: () => Promise<void>;
  /** Takes the session away: its file is gone. */
  readonly remove: () => Promise<void>;
}

/**
 * Writes one scenario into `dir`, in the kind's own format, where the reading side under test
 * looks for it.
 */
export type FixtureWriter = (dir: string, scenario: Scenario) => Promise<FixtureResult>;
