// The compressor of session readings: full, digest and brief, over the common model of
// `@niwa-labs/harness`, with the file index and the windows a reading is made in. No model is called.

export { ARGS_CHARS, RESULT_CHARS, compress, editedPaths, imageMarker, saidOf, sourceOf, withoutInsertions } from "./compress.ts";
export type { CompressOptions, Compressed } from "./compress.ts";
export {
  BriefSchema,
  CallStatusSchema,
  DigestEntrySchema,
  DigestModeSchema,
  DigestViewSchema,
  SourceSchema,
} from "./entries.ts";
export type { Brief, CallStatus, DigestEntry, DigestMode, DigestView, Source } from "./entries.ts";
export { EMPTY_FILE_INDEX, FileIndexSchema, FileIndexer, IndexedFileSchema, fileRef } from "./files.ts";
export type { FileIndex, IndexedFile } from "./files.ts";
export { cutEnd, cutMarker, cutMiddle } from "./truncate.ts";
export type { CutOptions } from "./truncate.ts";
export { charsOf, readWindow, tokensOf } from "./window.ts";
export type { DigestWindow, WindowOptions } from "./window.ts";
