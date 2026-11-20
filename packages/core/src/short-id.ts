/**
 * Short forms of the ids a person reads and types.
 *
 * An id the journal makes is built to be unique, not to be typed: `inv:workflow/…/label:ship`.
 * What a list shows is a short form of it, and what a command takes is the id, a unique prefix of
 * it or a unique suffix of it, or the short form itself. A text that fits several ids is refused,
 * with the candidates listed.
 */

import { createHash } from "node:crypto";

import { AmbiguousId } from "./errors.ts";

/** An invocation: `inv_` and eight hex digits of the hash of its id. */
export function shortInvocation(id: string): string {
  return `inv_${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

/** A run: `run_1a2b3c4d`, the start of the long id a run is given. */
export function shortRun(id: string): string {
  return id.replace(/^((?:run|sub)_)([0-9a-f-]{12,})$/, (_, prefix: string, rest: string) => `${prefix}${rest.slice(0, 8)}`);
}

/** The short form of an id a person reads, whichever kind it is; a text that is no such id is left as it is. */
export function shortForm(text: string): string {
  if (text.startsWith("inv:")) return shortInvocation(text);
  return shortRun(text);
}

/**
 * The one id a text names: the id itself, a prefix or a suffix of one id, or its short form.
 *
 * Undefined when it names none, so the caller says what it was looking for; an Error when it names
 * several, listing them.
 */
export function resolveId(text: string, ids: readonly string[], what: string, shortOf: (id: string) => string = (id) => id): string | undefined {
  if (ids.includes(text)) return text;
  // A short form that was cut off shows an ellipsis at its start: the rest of it is the end of the id.
  const bare = text.replace(/^…/, "");
  const named = ids.filter((id) => id.startsWith(bare) || id.endsWith(bare) || shortOf(id) === text);
  if (named.length > 1) throw new AmbiguousId(text, what, named);
  return named[0];
}
