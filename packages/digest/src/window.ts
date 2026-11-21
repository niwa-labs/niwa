/**
 * Reading a session in windows that fit a budget.
 *
 * A window takes records while their compressed size fits the budget, then says where the next one
 * starts. Records that share a locator are taken together, since a reading resumed from a locator
 * starts after all of them; and a half-written record ends the window before it, since the reading
 * side does not move past it. The file index is carried from window to window.
 */

import type { Locator, SessionRecord } from "@niwa-labs/harness";

import { ARGS_CHARS, RESULT_CHARS, compress, editedPaths } from "./compress.ts";
import type { DigestMode, DigestView } from "./entries.ts";
import type { FileIndex } from "./files.ts";

/** About how many characters make a token. */
const CHARS_PER_TOKEN = 4;

/** What an entry costs beside its text: its kind, its status, its source. */
const ENTRY_CHARS = 60;

/** What the marker of an image costs. */
const MARKER_CHARS = 16;

/** What a brief grows by when a call of a category is counted for the first time, or the first failure is. */
const COUNTER_CHARS = 16;

/** The tokens a text is about. */
export function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** What a window is told. */
export interface WindowOptions {
  readonly mode: DigestMode;
  /** About how many tokens the window may hold; a window always holds at least one record. */
  readonly budget: number;
  /** The file index of the windows before, carried on. */
  readonly files?: FileIndex;
  /** How much of a call's result a digest keeps. */
  readonly resultChars?: number;
}

/** One window of a reading. */
export interface DigestWindow {
  readonly view: DigestView;
  /** Where the next window reads from; `null` when the window read to the end of what is there now. */
  readonly next: Locator | null;
  /**
   * The last record the window holds: where a reading of a session that is still growing goes on
   * from later. `null` when it holds none.
   */
  readonly upto: Locator | null;
  /** The file index after this window: what the next one is given. */
  readonly files: FileIndex;
  /** How many records left nothing in the view. */
  readonly omitted: number;
  /** Whether the reading started over on another source: what it holds is the session from its beginning. */
  readonly restarted: boolean;
}

function textLength(value: unknown): number {
  if (value === undefined) return 0;
  return typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
}

/** About how many characters a record takes in a mode, before it is compressed. */
export function charsOf(record: SessionRecord, mode: DigestMode, resultChars: number = RESULT_CHARS): number {
  if (mode === "full") return JSON.stringify(record).length;
  switch (record.kind) {
    case "user":
    case "assistant":
      return ENTRY_CHARS + record.text.length + (record.kind === "user" ? MARKER_CHARS * (record.images?.length ?? 0) : 0);
    case "thinking":
      return mode === "brief" ? 0 : ENTRY_CHARS + record.text.length;
    case "tool-call": {
      if (mode === "brief") return 0;
      const named = record.paths === undefined ? (record.target?.length ?? 0) : record.paths.reduce((sum, path) => sum + path.length + 2, 0);
      return ENTRY_CHARS + named + Math.min(textLength(record.input), ARGS_CHARS);
    }
    case "tool-result":
      return mode === "brief" ? 0 : ENTRY_CHARS + Math.min(textLength(record.output) + MARKER_CHARS * (record.images?.length ?? 0), resultChars);
    case "compaction":
      return mode === "brief" ? 0 : ENTRY_CHARS + Math.min(record.summary.length, resultChars);
    case "checklist":
      return ENTRY_CHARS + record.items.reduce((sum, item) => sum + item.text.length + 10, 0);
    case "permission":
    case "nested":
      return mode === "brief" ? 0 : ENTRY_CHARS;
    case "unknown":
      return 0;
  }
}

/**
 * What a brief window has grown by, which `charsOf` cannot say of a record alone: a brief holds each
 * path an edit named once and each counter once, so only the first of each costs anything.
 */
class BriefLedger {
  readonly #paths = new Set<string>();
  readonly #categories = new Set<string>();
  #failed = false;

  /** The characters a group adds to the brief beyond what its messages take, and the means to account for them. */
  growth(group: readonly SessionRecord[]): { chars: number; commit: () => void } {
    const paths = new Set<string>();
    const categories = new Set<string>();
    let failed = false;
    let chars = 0;
    for (const record of group) {
      if (record.kind === "tool-call") {
        if (!this.#categories.has(record.category) && !categories.has(record.category)) {
          categories.add(record.category);
          chars += COUNTER_CHARS;
        }
        if (record.category === "edit") {
          for (const path of editedPaths(record)) {
            if (this.#paths.has(path) || paths.has(path)) continue;
            paths.add(path);
            chars += path.length + 4;
          }
        }
      } else if (record.kind === "tool-result" && record.ok === false && !this.#failed && !failed) {
        failed = true;
        chars += COUNTER_CHARS;
      }
    }
    return {
      chars,
      commit: () => {
        for (const path of paths) this.#paths.add(path);
        for (const category of categories) this.#categories.add(category);
        if (failed) this.#failed = true;
      },
    };
  }
}

/**
 * The record as a brief can use it: what a brief never reads (the arguments and results of calls,
 * thoughts, summaries, the raw data of what is not known) is dropped once the record is taken, so a
 * window of a long session does not hold it to its end.
 */
function forBrief(record: SessionRecord): SessionRecord {
  switch (record.kind) {
    case "tool-call": {
      const { input: _input, ...rest } = record;
      return rest;
    }
    case "tool-result": {
      const { output: _output, ...rest } = record;
      return rest;
    }
    case "thinking":
      return { ...record, text: "" };
    case "compaction":
      return { ...record, summary: "" };
    case "unknown":
      return { ...record, raw: undefined };
    default:
      return record;
  }
}

/**
 * Read one window from `records`: those after the locator the previous window gave, in the
 * harness's order. Only what the window takes is read past by one group, and the iteration is
 * closed when the window is full.
 */
export async function readWindow(records: AsyncIterable<SessionRecord>, options: WindowOptions): Promise<DigestWindow> {
  const resultChars = options.resultChars ?? RESULT_CHARS;
  const taken: SessionRecord[] = [];
  let group: SessionRecord[] = [];
  let used = 0;
  let full = false;
  let upto: Locator | null = null;
  const ledger = new BriefLedger();

  /** Take the group read so far, if it fits; say whether the window has room for more. */
  const take = (): boolean => {
    if (group.length === 0) return true;
    const growth = options.mode === "brief" ? ledger.growth(group) : { chars: 0, commit: () => undefined };
    const cost = tokensOf(group.reduce((sum, record) => sum + charsOf(record, options.mode, resultChars), growth.chars));
    if (taken.length > 0 && used + cost > options.budget) return false;
    growth.commit();
    taken.push(...(options.mode === "brief" ? group.map(forBrief) : group));
    used += cost;
    upto = group[group.length - 1]!.locator;
    group = [];
    return true;
  };

  for await (const record of records) {
    if (record.incomplete) {
      // What was read before it is whole, unless it is part of the same record.
      if (group.length > 0 && group[0]!.locator !== record.locator) take();
      full = true;
      break;
    }
    if (group.length > 0 && group[0]!.locator !== record.locator) {
      if (!take()) {
        full = true;
        break;
      }
    }
    group.push(record);
  }
  // The last group read is whole only when the reading ended by itself; it may not fit.
  if (!full && !take()) full = true;
  const exhausted = !full;
  const compressed = compress(taken, options.mode, {
    ...(options.files === undefined ? {} : { files: options.files }),
    resultChars,
    more: !exhausted,
  });
  return { view: compressed.view, next: exhausted ? null : upto, upto, files: compressed.files, omitted: compressed.omitted, restarted: compressed.restarted };
}
