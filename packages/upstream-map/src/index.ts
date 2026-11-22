/** The mapping of the upstream snapshot, and the tool that measures it. */

export { analyze } from "./analyze.ts";
export type { EntryMove, FileCoverage, Moved, Problem, Report, Uncovered } from "./analyze.ts";
export { assemble, jsonOf, titleOf, writeTexts } from "./assemble.ts";
export type { AssembledText, TextSpec } from "./assemble.ts";
export { carry, diffText } from "./diff.ts";
export type { Carried, Segment, Span } from "./diff.ts";
export { formatReport, summaryOf, unreadable } from "./format.ts";
export { Git } from "./git.ts";
export { accept, advance } from "./maintain.ts";
export { Entry, KINDS, Mapping, formatMapping, parseMapping } from "./schema.ts";
export type { Kind, Ref } from "./schema.ts";
export { OursTexts, UpstreamTexts, WORKTREE } from "./sources.ts";
export type { Texts, TextSpecs } from "./sources.ts";
export { checkoutPathOf, pathsIn, refreshUpstream, snapshotFiles, snapshotPathOf, sourceOf } from "./snapshot.ts";
export type { PackagePaths, SnapshotPath, SnapshotSpec, UpstreamSource } from "./snapshot.ts";
export { verifyTexts, verifyTextsIn } from "./verify.ts";
export { assembledTexts, differingTexts, openMap, recordMap, writeAssembled } from "./tool.ts";
export type { ToolContext, UpstreamMapConfig } from "./tool.ts";
