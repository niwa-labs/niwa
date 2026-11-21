/**
 * The identity of a session, as niwa sees it.
 *
 * A session is the pair of a harness id and the id that harness gave it: two harnesses may use the
 * same native id, and they are different sessions. A session niwa starts also gets an id of niwa's
 * own, `s-…`, issued from the starting call and recorded next to the pair: that is what a person
 * reads and types. Where the harness has not named a session yet, there is no session, only a
 * start in progress.
 */

import { z } from "zod";

import { idSchema } from "@niwa-labs/core";
import type { Id } from "@niwa-labs/core";

import { HarnessIdSchema, NativeSessionIdSchema } from "@niwa-labs/harness";
import type { SessionId } from "@niwa-labs/harness";

/**
 * How a session is named in niwa's own records.
 *
 * It is the same pair the harness uses, written as one string so it can be a record field and a
 * key of the index. The separator is a space, which no harness id and no native id may hold: a
 * harness id has no whitespace, and a native id with whitespace in it is not a name.
 */
export const SessionRefSchema = z.string().min(1).brand<"SessionRef">();

export type SessionRef = z.output<typeof SessionRefSchema>;

/** The id niwa gives a session it started: `s-3fa9c2`. */
export const NiwaSessionIdSchema = idSchema("session");

export type NiwaSessionId = Id<"session">;

/** The separator between the two parts of a session reference. */
const SEPARATOR = " ";

/**
 * The reference of a session: the harness id and the native id, joined.
 *
 * The two parts are joined rather than nested so that a reference is a key: the catalog indexes
 * by it, and two references are equal when they are the same string.
 */
export function sessionRef(id: SessionId): SessionRef {
  return SessionRefSchema.parse(`${id.harness}${SEPARATOR}${id.native}`);
}

/**
 * The session a reference names.
 *
 * A reference that does not name two parts is refused: a reference that cannot be split would
 * name no harness, and a session without a harness is not a session.
 */
export function sessionOf(ref: SessionRef): SessionId {
  const text = ref as unknown as string;
  const at = text.indexOf(SEPARATOR);
  if (at <= 0 || at === text.length - 1) {
    throw new TypeError(`a session reference must be "<harness> <native>", got ${JSON.stringify(text)}`);
  }
  return {
    harness: HarnessIdSchema.parse(text.slice(0, at)),
    native: NativeSessionIdSchema.parse(text.slice(at + 1)),
  };
}
