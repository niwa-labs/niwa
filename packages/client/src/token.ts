/**
 * Tokens as a client holds them: read from the environment or the home of the owner.
 */

import { existsSync, readFileSync } from "node:fs";

import { OWNER_TOKEN_FILE, TOKEN_ENV } from "@niwa-labs/core";
import { expandHome } from "./home.ts";
import type { Token } from "@niwa-labs/core";

/** A token is 1 to 4 letters or digits. */
const TOKEN_PATTERN = /^[A-Za-z0-9]{1,4}$/;

/**
 * A token, from a string a client sent or a file held.
 *
 * @throws when the text is not a token: more than 4 characters, or characters outside letters and digits.
 */
export function token(text: string): Token {
  if (typeof text !== "string" || !TOKEN_PATTERN.test(text)) {
    throw new TypeError("a token is 1 to 4 letters or digits");
  }
  return text as Token;
}

/** The token a surface of the owner shows: the one in `NIWA_ID`, else the owner's own. */
export function tokenOf(home: string, env: Readonly<Record<string, string | undefined>> = process.env): Token | undefined {
  const given = env[TOKEN_ENV]?.trim();
  if (given !== undefined && given !== "") return token(given);
  return readOwnerToken(home);
}

/** The token of the owner of this home, when the host has made one. */
export function readOwnerToken(home: string): Token | undefined {
  const path = `${expandHome(home)}/${OWNER_TOKEN_FILE}`;
  if (!existsSync(path)) return undefined;
  return token(readFileSync(path, "utf8").trim());
}
