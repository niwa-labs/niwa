/**
 * login.ts — who may use the web surface.
 *
 * The page is served on a local port, so any local process or browser tab can reach it. A caller
 * is let in by a cookie, and the cookie is had in exchange for a secret the server made when it
 * started and showed once, in the link it prints. There are no accounts: one secret per start,
 * and it works once.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** The path that takes the secret and gives the cookie. */
export const LOGIN_PATH = "/login";

/** The name of the cookie. */
const COOKIE_NAME = "niwa_web";

function randomValue(): string {
  return randomBytes(24).toString("base64url");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The secret of one server start, and the cookie it was exchanged for. */
export class WebLogin {
  readonly secret = randomValue();
  private session: string | undefined;
  private spent = false;

  /** The cookie for this secret, once; undefined for a wrong secret or one that was used. */
  exchange(given: string | null): string | undefined {
    if (given === null || this.spent || !same(given, this.secret)) return undefined;
    this.spent = true;
    this.session = randomValue();
    return `${COOKIE_NAME}=${this.session}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** Does the `cookie` header of a request carry the cookie this server gave? */
  allows(header: string | null): boolean {
    if (this.session === undefined || header === null) return false;
    for (const part of header.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === COOKIE_NAME && same(value.join("="), this.session)) return true;
    }
    return false;
  }
}
