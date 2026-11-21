/**
 * The reading of a transcript: what `session.read` and `session.search` do once the
 * session is named, through the harness's reading side. The sessions module resolves the name and binds the harness;
 * what is read, how far, and what is said when it cannot be read is here. The transcript is never written into the journal.
 */

import type { z } from "zod";

import { readWindow } from "@niwa-labs/digest";
import type { DigestMode, FileIndex } from "@niwa-labs/digest";
import { LocatorSchema, failedCoverage, requireAbility, unavailableCoverage } from "@niwa-labs/harness";
import type { Coverage, Harness, SessionId, SessionReading, SessionRecord } from "@niwa-labs/harness";

import { DEFAULT_READ_BUDGET } from "./records.ts";
import type { DigestReadSchema, SessionRecordSchema } from "./records.ts";
import type { SearchMatch, SearchQuery } from "./records.ts";
import { searchTranscript } from "./search.ts";

/** One installation as the reading needs it: the installation, and its reading side when it has one. */
export interface ReadingBinding {
  readonly instance: Harness;
  readonly reading?: SessionReading;
}

/**
 * What a read is given beside the session: where to go on from, or the window of records before a
 * locator; and how much of the records to keep, in windows of about how many tokens, with the file
 * index of the window before.
 */
export interface ReadQuery {
  readonly from?: string | undefined;
  readonly window?: { limit: number; before?: string | undefined } | undefined;
  readonly mode?: DigestMode | undefined;
  readonly budget?: number | undefined;
  readonly files?: FileIndex | undefined;
}

/** What a read answers with. */
export interface ReadAnswer {
  records: Array<z.output<typeof SessionRecordSchema>>;
  coverage: Coverage;
  page?: { hasEarlier: boolean };
  /** The window of a digest or a brief: its records are not given one by one. */
  digest?: z.output<typeof DigestReadSchema>;
}

/**
 * Read the transcript of a session through the reading side of its harness.
 *
 * An installation that cannot read is said in the coverage, not shown as an empty session; an undeclared ability is a
 * fact about the installation, refused before any attempt. What was read before a failure stays, and the failure is stated.
 */
export async function readTranscript(binding: ReadingBinding | undefined, id: SessionId, input: ReadQuery): Promise<ReadAnswer> {
  if (binding === undefined || binding.reading === undefined) {
    return {
      records: [],
      coverage: unavailableCoverage(`harness "${id.harness}" has no reading side`),
      ...(input.window === undefined ? {} : { page: { hasEarlier: false } }),
    };
  }
  requireAbility(binding.instance, "reading", "read");

  if (input.window !== undefined) return await readRecordWindow(binding.reading, id, input.window);
  if (input.mode === "digest" || input.mode === "brief") return await readDigest(binding.reading, id, { ...input, mode: input.mode });

  const from = input.from === undefined ? undefined : LocatorSchema.parse(input.from);
  const records: SessionRecord[] = [];
  try {
    for await (const record of binding.reading.read(id, from)) records.push(record);
    return { records: records.map(recordOf), coverage: await binding.reading.coverage(id, from) };
  } catch (error) {
    return {
      records: records.map(recordOf),
      coverage: failedCoverage(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Search the transcript of a session through the reading side of its harness; an installation that cannot read says so in the coverage. */
export async function searchSession(
  binding: ReadingBinding | undefined,
  id: SessionId,
  input: SearchQuery,
): Promise<{ matches: SearchMatch[]; more: boolean; coverage: Coverage }> {
  if (binding === undefined || binding.reading === undefined) {
    return { matches: [], more: false, coverage: unavailableCoverage(`harness "${id.harness}" has no reading side`) };
  }
  requireAbility(binding.instance, "reading", "read");
  return await searchTranscript(binding.reading, id, input);
}

/** A window of a digest or a brief from `from`; what was read before a failure is not given, the failure is. */
async function readDigest(
  reading: SessionReading,
  id: SessionId,
  input: ReadQuery & { mode: "digest" | "brief" },
): Promise<ReadAnswer> {
  const from = input.from === undefined ? undefined : LocatorSchema.parse(input.from);
  try {
    const window = await readWindow(reading.read(id, from), {
      mode: input.mode,
      budget: input.budget ?? DEFAULT_READ_BUDGET,
      ...(input.files === undefined ? {} : { files: input.files }),
    });
    if (window.view.mode === "full") throw new Error("a digest read gave every record");
    return { records: [], coverage: await reading.coverage(id, from), digest: { ...window, view: window.view } };
  } catch (error) {
    return { records: [], coverage: failedCoverage(error instanceof Error ? error.message : String(error)) };
  }
}

/** Retain only the records of the requested window while scanning in the harness's order. */
async function readRecordWindow(
  reading: SessionReading,
  id: SessionId,
  { limit, before }: { limit: number; before?: string },
) {
  const records: SessionRecord[] = [];
  // Once the buffer fills, each new record replaces the oldest one.
  let next = 0;
  let hasEarlier = false;
  let found = before === undefined;
  let coverage: Coverage;
  try {
    for await (const record of reading.read(id)) {
      if (record.locator === before) {
        found = true;
        break;
      }
      if (records.length === limit) hasEarlier = true;
      records[next] = record;
      next = (next + 1) % limit;
    }
    coverage = await reading.coverage(id);
  } catch (error) {
    coverage = failedCoverage(error instanceof Error ? error.message : String(error));
  }
  if (!found) {
    // The scanned records cannot be placed relative to a boundary we did not reach.
    if (coverage.status !== "failed" && coverage.status !== "unavailable") {
      coverage = failedCoverage("before locator was not found in the current transcript");
    }
    return { records: [], coverage, page: { hasEarlier: false } };
  }
  const ordered = hasEarlier ? records.slice(next).concat(records.slice(0, next)) : records;
  return { records: ordered.map(recordOf), coverage, page: { hasEarlier } };
}

/**
 * One record of a session, as the actions report it.
 *
 * Every kind carries its own fields. The raw data of an unfamiliar record is not published here:
 * the harness's own record whole is asked for on demand, through the reading side.
 */
function recordOf(record: SessionRecord): z.output<typeof SessionRecordSchema> {
  const base = { locator: record.locator, at: record.at, incomplete: record.incomplete };
  switch (record.kind) {
    case "user":
      return { kind: "user", text: record.text, ...base };
    case "assistant":
      return { kind: "assistant", text: record.text, model: record.model, ...base };
    case "thinking":
      return { kind: "thinking", text: record.text, redacted: record.redacted, ...base };
    case "tool-call":
      return {
        kind: "tool-call",
        callId: record.callId,
        name: record.name,
        category: record.category,
        target: record.target,
        input: record.input,
        ...base,
      };
    case "tool-result":
      return {
        kind: "tool-result",
        callId: record.callId,
        name: record.name,
        output: record.output,
        ok: record.ok,
        ...base,
      };
    case "checklist":
      return { kind: "checklist", callId: record.callId, items: record.items, ...base };
    case "permission":
      return { kind: "permission", callId: record.callId, tool: record.tool, outcome: record.outcome, ...base };
    case "compaction":
      return { kind: "compaction", summary: record.summary, ...base };
    case "nested":
      return { kind: "nested", child: record.child, ...base };
    case "unknown":
      return { kind: "unknown", ...base };
  }
}
