/**
 * Pure helpers of the checks: they need no host and no client. A question's option, an answer
 * that picks options, the gate of the live tests, and a web surface's cookie.
 */

import { OptionIdSchema } from "@niwa-labs/core";
import type { Answer, QuestionOption } from "@niwa-labs/core";

/** Tests that run a real external CLI or model are skipped unless `NIWA_LIVE=1` (`bun run test:live`). */
export const live = process.env.NIWA_LIVE === "1";

/** A plain option of a question. */
export const opt = (id: string, label = id): QuestionOption => ({ id: OptionIdSchema.parse(id), label, flavor: "plain" });

/** The answer that picks these options. */
export const pick = (...ids: string[]): Answer => ({ ids: ids.map((id) => OptionIdSchema.parse(id)) });

/** The cookies the web surfaces under test gave, by their origin. */
const webCookies = new Map<string, string>();

/** Log in to a web surface by its link, as a browser does: the cookie is kept for `webFetch`. */
export async function loginWeb(web: { readonly url: string; readonly loginUrl: string }): Promise<void> {
  const response = await fetch(web.loginUrl, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (response.status !== 302 || cookie === undefined) {
    throw new Error(`the web surface did not log in: ${String(response.status)}`);
  }
  webCookies.set(new URL(web.url).origin, cookie);
}

/** `fetch` with the cookie of a web surface that `loginWeb` logged in to. */
export function webFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const cookie = webCookies.get(new URL(url).origin);
  if (cookie === undefined) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return fetch(url, { ...init, headers });
}
