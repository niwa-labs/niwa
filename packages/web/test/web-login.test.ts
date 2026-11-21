// The web surface lets in only a browser that has the cookie, and speaks for the owner only when
// it is configured to.
//
//   1. a request without the cookie, or with a cookie the server did not give, is refused with 401
//   2. the login link gives an HttpOnly, SameSite=Strict cookie, and with it the page works
//   3. the link works once, and a wrong secret gives nothing
//   4. with speaksFor the page answers a request of the owner; without it the page is a plain
//      client and the answer is refused

import { expect, test } from "bun:test";

import { owner, record } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { createNiwa, eventually, tempHome, loginWeb, plugin, watch, webFetch, connectAsOwner, opt, requestAsk, question, requests } from "@niwa-labs/testing";
import { z } from "zod";

import type { WebServer } from "../src/index.ts";
import { serveWebPages } from "./fixtures/serve-web.ts";

const Start = record("web-login.start", z.object({}), { open: true });
const Done = record("web-login.done", z.object({ answer: z.string() }));
const Pick = question("web-login.pick", { kind: "choice", title: "Pick one", options: [opt("yes"), opt("no")] });

/** Asks the owner one question and goes on with the answer. */
function executor() {
  return plugin("web-login-executor", (api) => {
    api.declare(Start, Done);
    api.on(Start, async (_data, step) => {
      const { answer } = await step(requestAsk, { to: owner, ...Pick });
      await step.emit(Done, { answer: JSON.stringify(answer) });
    });
  });
}

async function withHost(run: (home: string) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests());
  host.use(executor());
  await host.serve();
  try {
    await run(home.path);
  } finally {
    await host.close();
    await home.cleanup();
  }
}

/** The records of one type seen so far. */
function of(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((item) => item.type === type);
}

const JSON_HEADERS = { "content-type": "application/json" };

test("web login: a request without the cookie is refused", () =>
  withHost(async (home) => {
    const web = await serveWebPages({ home, port: 0, speaksFor: "owner" });
    try {
      for (const path of ["/", "/feed", "/events", "/trace-data/rec_x", "/nothing"]) {
        expect((await fetch(`${web.url}${path}`)).status).toBe(401);
      }
      const post = await fetch(`${web.url}/answer`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ request: "r", answer: { ids: ["yes"] } }),
      });
      expect(post.status).toBe(401);

      // A cookie the server did not give is no cookie, before and after a real login.
      const forged = { headers: { cookie: "niwa_web=forged" } };
      expect((await fetch(`${web.url}/feed`, forged)).status).toBe(401);
      await loginWeb(web);
      expect((await fetch(`${web.url}/feed`, forged)).status).toBe(401);
    } finally {
      await web.close();
    }
  }));

test("web login: the link gives a strict HttpOnly cookie, once, and the page works with it", () =>
  withHost(async (home) => {
    const web = await serveWebPages({ home, port: 0, speaksFor: "owner" });
    try {
      const wrong = await fetch(`${web.url}/login?secret=wrong`, { redirect: "manual" });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("set-cookie")).toBeNull();
      expect((await fetch(`${web.url}/login`, { redirect: "manual" })).status).toBe(401);

      const login = await fetch(web.loginUrl, { redirect: "manual" });
      expect(login.status).toBe(302);
      expect(login.headers.get("location")).toBe("/");
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain(new URL(web.loginUrl).searchParams.get("secret") ?? "unreachable");

      const withCookie = { headers: { cookie: cookie.split(";")[0] ?? "" } };
      expect((await fetch(`${web.url}/feed`, withCookie)).status).toBe(200);
      expect((await fetch(`${web.url}/`, withCookie)).status).toBe(200);

      // The secret was spent: the same link gives nothing more.
      expect((await fetch(web.loginUrl, { redirect: "manual" })).status).toBe(401);
      // The cookie stays good.
      expect((await fetch(`${web.url}/feed`, withCookie)).status).toBe(200);
    } finally {
      await web.close();
    }
  }));

test("web login: each start has a secret of its own", () =>
  withHost(async (home) => {
    const first = await serveWebPages({ home, port: 0, speaksFor: "owner" });
    const second = await serveWebPages({ home, port: 0, speaksFor: "owner" });
    try {
      const secret = (web: WebServer) => new URL(web.loginUrl).searchParams.get("secret");
      expect(secret(first)).not.toBe(secret(second));
      const crossed = `${second.url}/login?secret=${secret(first) ?? ""}`;
      expect((await fetch(crossed, { redirect: "manual" })).status).toBe(401);
    } finally {
      await first.close();
      await second.close();
    }
  }));

/** Run one request of the owner through a page, and tell how the page answered it. */
async function answerThroughPage(home: string, web: WebServer): Promise<{ status: number; seen: StoredRecord[] }> {
  const writer = await connectAsOwner(home);
  const observer = await watch(home);
  try {
    await loginWeb(web);
    await writer.emit(Start, {});
    await eventually(() => of(observer.seen, "request.created").length === 1, 10_000, "the request was not made");
    const id = (of(observer.seen, "request.created")[0]?.data as { id: string }).id;
    const response = await webFetch(`${web.url}/answer`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ request: id, answer: { ids: ["yes"] } }),
    });
    await Bun.sleep(300);
    return { status: response.status, seen: observer.seen };
  } finally {
    await observer.stop();
    await writer.close();
  }
}

test("web login: with speaksFor the page answers for the owner", () =>
  withHost(async (home) => {
    const web = await serveWebPages({ home, port: 0, speaksFor: "owner" });
    try {
      const result = await answerThroughPage(home, web);
      expect(result.status).toBe(200);
      expect(of(result.seen, "request.answered")).toHaveLength(1);
      expect(of(result.seen, "web-login.done")).toHaveLength(1);
    } finally {
      await web.close();
    }
  }));

test("web login: without speaksFor the page is a plain client and cannot answer for the owner", () =>
  withHost(async (home) => {
    const web = await serveWebPages({ home, port: 0 });
    try {
      const result = await answerThroughPage(home, web);
      expect(result.status).toBe(409);
      expect(of(result.seen, "request.answered")).toHaveLength(0);
      expect(of(result.seen, "web-login.done")).toHaveLength(0);
    } finally {
      await web.close();
    }
  }));
