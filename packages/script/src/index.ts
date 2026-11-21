// The script entry: what a workflow script is given (`script-api.ts`: types only, no import) and the reader of its header.

export * from "./script-api.ts";
export * from "./header.ts";

/**
 * The version of the script ABI: what a script is given and how its module is read. A registered version
 * keeps the one it was registered for, and does not run under another: it is registered again.
 */
export const SCRIPT_ABI = 1;
