/**
 * The reading of a transcript: what `session.read` and `session.search` do once the
 * session is named, through the harness's reading side. The sessions module resolves the name and binds the harness;
 * what is read, how far, and what is said when it cannot be read is here. The transcript is never written into the journal.
 */

import type { z } from "zod";

import { readWindow } from "@niwa-labs/digest";
import type { DigestMode, FileIndex } from "@niwa-labs/digest";
import { LocatorSchema, failedCoverage, requireAbility, supports, unavailableCoverage } from "@niwa-labs/harness";
import type { Coverage, Harness, HarnessId, SessionId, SessionReading, SessionRecord } from "@niwa-labs/harness";

import { DEFAULT_LIST_LIMIT, DEFAULT_READ_BUDGET } from "./records.ts";
import type { DigestReadSchema, SessionListing, SessionRecordSchema } from "./records.ts";
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

/**
 * The sessions the reading sides list, the most recently changed first, and the harnesses that could not be asked.
 *
 * A side without a reading side, or without the ability to list, is not asked and not blamed. A
 * side that fails is reported: the list is what is known, not proof that there is nothing more.
 */
export async function listSessions(
  bindings: readonly ReadingBinding[],
  input: { harness?: string | undefined; cwd?: string | undefined; limit?: number | undefined },
): Promise<{ sessions: SessionListing[]; more: boolean; unreadable: Array<{ harness: HarnessId; reason: string }> }> {
  const listed: SessionListing[] = [];
  const unreadable: Array<{ harness: HarnessId; reason: string }> = [];
  for (const binding of bindings) {
    if (input.harness !== undefined && binding.instance.id !== input.harness) continue;
    if (binding.reading === undefined || !supports(binding.instance, "reading", "list")) continue;
    try {
      for await (const info of binding.reading.list(input.cwd === undefined ? undefined : { cwd: input.cwd })) {
        listed.push({
          session: info.id,
          ...(info.title === undefined ? {} : { title: info.title }),
          ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
          ...(info.startedAt === undefined ? {} : { startedAt: info.startedAt }),
          ...(info.updatedAt === undefined ? {} : { updatedAt: info.updatedAt }),
        });
      }
    } catch (error) {
      unreadable.push({ harness: binding.instance.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // Latest change first; a session that does not say when it changed comes last. The sort is stable.
  listed.sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity));
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  return { sessions: listed.slice(0, limit), more: listed.length > limit, unreadable };
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

/**
 * Retain only the records of the requested window while scanning in the harness's order.
 *
 * A page never splits the records of one locator: the next page goes back from the locator of the
 * page's first record, so a record left out of this page by a split would be unreachable from the
 * next. The page is therefore the last `limit` records widened to the whole of the locator it starts
 * in, and a locator that holds more than `limit` records is one page.
 */
async function readRecordWindow(
  reading: SessionReading,
  id: SessionId,
  { limit, before }: { limit: number; before?: string },
) {
  const records: SessionRecord[] = [];
  let hasEarlier = false;
  let found = before === undefined;
  let coverage: Coverage;
  try {
    for await (const record of reading.read(id)) {
      if (record.locator === before) {
        found = true;
        break;
      }
      records.push(record);
      // The oldest record goes once the page is full, unless the next one is of its locator.
      while (records.length > limit && records[0]!.locator !== records[1]!.locator) {
        records.shift();
        hasEarlier = true;
      }
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
  return { records: records.map(recordOf), coverage, page: { hasEarlier } };
}

/**
 * One record of a session, as the actions report it.
 *
 * It is the record as the reading side gave it, with every field it carries, so a field the common
 * model gains reaches the reader without a change here; only the raw data of an unfamiliar record is
 * not published: the harness's own record whole is asked for on demand, through the reading side.
 */
function recordOf(record: SessionRecord): z.output<typeof SessionRecordSchema> {
  if (record.kind !== "unknown") return record;
  const { raw: _raw, ...published } = record;
  return published;
}
