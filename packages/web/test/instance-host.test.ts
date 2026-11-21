// Each web surface is a host name of its own, so two of them open in one browser do not share a session.
//
// A browser keeps a cookie per host name and does not tell ports apart: two surfaces on 127.0.0.1 would replace each other's
// cookie, and any other service on that name would be sent it.
//
//   1. every instance has a name of its own under .localhost, and the cookie it gives names no domain
//   2. logging in to two instances, as a browser keeps cookies by host name, leaves both logged in
//   3. an instance answers to its own name only: not to another instance's, not to the bare loopback address

import { afterEach, expect, test } from "bun:test";

import { createNiwa, tempHome } from "@niwa-labs/testing";
import type { WebServer } from "../src/index.ts";

import { serveWebPages } from "./fixtures/serve-web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Two homes, each with its host and its web surface. */
async function two(): Promise<[WebServer, WebServer]> {
  const surfaces: WebServer[] = [];
  for (let index = 0; index < 2; index += 1) {
    const home = await tempHome();
    const host = createNiwa({ home: home.path });
    await host.serve();
    const web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    cleanups.push(async () => {
      await web.close();
      await host.close();
      await home.cleanup();
    });
    surfaces.push(web);
  }
  return [surfaces[0]!, surfaces[1]!];
}

/** The cookie a login link gives, as the `cookie` header of the next request. */
async function loginCookie(web: WebServer): Promise<{ header: string; setCookie: string }> {
  const login = await fetch(web.loginUrl, { redirect: "manual" });
  expect(login.status).toBe(302);
  const setCookie = login.headers.get("set-cookie") ?? "";
  return { header: setCookie.split(";")[0] ?? "", setCookie };
}

test("every instance has a host name of its own, and the cookie it gives is for that name alone", async () => {
  const [first, second] = await two();
  const names = [first, second].map((web) => new URL(web.url).hostname);
  expect(names[0]).toEndWith(".localhost");
  expect(names[1]).toEndWith(".localhost");
  expect(names[0]).not.toBe(names[1]);
  expect(new URL(first.loginUrl).hostname).toBe(names[0]!);

  const { setCookie } = await loginCookie(first);
  expect(setCookie).not.toMatch(/domain=/i);
  expect(setCookie).toContain("Path=/");
});

test("two instances opened in one browser keep both sessions", async () => {
  const [first, second] = await two();
  // A browser keeps the cookies of a host name apart from those of every other name, whatever the port.
  const jar = new Map<string, string>();
  for (const web of [first, second]) jar.set(new URL(web.url).hostname, (await loginCookie(web)).header);
  for (const web of [first, second]) {
    const answer = await fetch(`${web.url}/feed`, { headers: { cookie: jar.get(new URL(web.url).hostname) ?? "" } });
    expect(answer.status).toBe(200);
  }
});

test("an instance answers to its own host name only", async () => {
  const [first, second] = await two();
  const { header } = await loginCookie(first);
  expect((await fetch(`${first.url}/feed`, { headers: { cookie: header } })).status).toBe(200);
  // The name of the other instance, and the bare address, reach the same port and are refused although the cookie is good.
  const other = new URL(second.url).hostname;
  expect((await fetch(`http://${other}:${String(first.port)}/feed`, { headers: { cookie: header } })).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${String(first.port)}/feed`, { headers: { cookie: header } })).status).toBe(403);
});
