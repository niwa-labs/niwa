/**
 * speaks-for.ts — who a surface instance may speak for.
 *
 * A surface is a transport, not a subject. Configured with `speaksFor: "owner"` it may act with
 * the owner's rights, and only for input that really comes from the owner; without it, it is a
 * plain client with a principal of its own, whatever files it can read.
 */

/** The one subject a surface may speak for. */
export type SpeaksFor = "owner";
