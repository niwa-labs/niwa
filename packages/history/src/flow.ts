// The history entry for workflow scripts: read the transcript of a session in windows that fit a
// budget, as a step of the script. A step names its call (`label`), so a replay does not read again.
//
//   import { readSession } from "@niwa-labs/history/flow"
//   const win = await readSession("read", { session, mode: "digest", from, budget: 40_000 })
//   // win.entries, win.next (null at the end), win.files (give it to the next read), win.omitted

import type { z } from "zod";

import type { Brief, DigestEntry, FileIndex } from "@niwa-labs/digest";
import type { SessionRecord } from "@niwa-labs/harness";

import type { ReadAnswerSchema, historyRead } from "./records.ts";

/** `call` is a global of a workflow script. */
declare const call: (name: string, input: unknown, opts?: { label?: string; reason?: string }) => Promise<unknown>;

/** What a read is given: the session, and what to read of it. */
export type ReadSessionInput = z.input<typeof historyRead.input>;

/** One window of a read. */
export interface SessionWindow {
  /** How the window was kept, as asked: `digest` when the read named no mode. */
  readonly mode: "full" | "digest" | "brief";
  /** The entries of a digest, in the order of the session; empty for the other modes. */
  readonly entries: DigestEntry[];
  /** The brief of a `brief` read. */
  readonly brief?: Brief;
  /** The records of a `full` read. */
  readonly records: SessionRecord[];
  /** Where the next window reads from; `null` when this one read to the end of what is there now. */
  readonly next: string | null;
  /** The last record the window holds: where a read of a session that still grows goes on from. */
  readonly upto: string | null;
  /** The file index to give the next read as `files`. */
  readonly files: FileIndex;
  /** How many records left nothing in the window. */
  readonly omitted: number;
  /** True when the read started over: the position given belonged to another source, and what was gathered before no longer holds. */
  readonly restarted: boolean;
}

/**
 * Reads a window of a session as the step `label`. A read that could not be made (the harness has
 * no reading side, the transcript is unreadable) throws, never an empty window: "nothing was read"
 * is not "nothing is there".
 */
export async function readSession(label: string, input: ReadSessionInput): Promise<SessionWindow> {
  const mode = input.mode ?? "digest";
  const answer = (await call("history.read", { ...input, mode }, { label })) as z.output<typeof ReadAnswerSchema>;
  const { coverage } = answer;
  if (coverage.status === "failed" || coverage.status === "unavailable") {
    throw new Error(`the session could not be read (${coverage.status}): ${coverage.reason}`);
  }
  if (answer.digest === undefined) {
    // A full read: every record, in the harness's own order, with nothing to go on from.
    return {
      mode: "full",
      entries: [],
      records: answer.records as SessionRecord[],
      next: null,
      upto: answer.records.length === 0 ? null : answer.records[answer.records.length - 1]!.locator,
      files: { files: [] },
      omitted: 0,
      restarted: answer.records.some((record) => record.reanchored === true),
    };
  }
  const { digest } = answer;
  return {
    mode: digest.view.mode,
    entries: digest.view.mode === "digest" ? (digest.view.entries as DigestEntry[]) : [],
    ...(digest.view.mode === "brief" ? { brief: digest.view.brief as Brief } : {}),
    records: [],
    next: digest.next,
    upto: digest.upto,
    files: digest.files as FileIndex,
    omitted: digest.omitted,
    restarted: digest.restarted,
  };
}
