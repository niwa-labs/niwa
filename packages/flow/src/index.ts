// Helpers for workflow scripts that need neither git nor processes. Each runs inside a script, on
// its globals, and opens a scope named by the key it is given.

export { Attempt, FindingSchema, JudgedSchema, VERDICTS, VerdictSchema, passes } from "./types.ts";
export type { Finding, FlowError, Judged, Settled, Verdict } from "./types.ts";
export { sessionOptions, checkKey, checkKeys, harnessOf, isFatal, script, seatKeys, vendorOf, zod } from "./script.ts";
export type { ScriptGlobals, Seat, SeatOptions } from "./script.ts";
export { askSeat, consensus, firstPassing, map, mapReduce, parallel, rankAll, stream, swarm } from "./group.ts";
export { graph, graphProblems } from "./graph.ts";
export type { GraphNode } from "./graph.ts";
export { escalate, gridCells, loop, paramGrid, revise, saturate } from "./loop.ts";
export type { GridCell } from "./loop.ts";
export { GateFailed, blindLabel, decidePanel, gate, panel, tally, verify } from "./judge.ts";
export type { Band, PanelJudge, Require } from "./judge.ts";
export { humanGate, settle } from "./wait.ts";
