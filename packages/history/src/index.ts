// The history entry: reading the transcript of a session through its harness's reading side — read, search and coverage.
// The schemas of what these are given and answer with are in `@niwa-labs/history/records`.

export { describeCoverage, isEmpty } from "./coverage.ts";
export { matchText, recordText, searchRecords, searchTranscript } from "./search.ts";
export { readTranscript, searchSession } from "./read.ts";
export type { ReadAnswer, ReadQuery, ReadingBinding } from "./read.ts";
export type { SearchMatch, SearchQuery } from "./records.ts";
