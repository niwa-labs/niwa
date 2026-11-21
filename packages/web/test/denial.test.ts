// A refusal by the host is told as one, whichever route met it.
//
//   1. with the switch of access off, a plain client's call is refused with 403 although no grant is named
//   2. the answer and the resolve of a page that is refused are 403 too, and so are the feed and the history

import { afterEach, expect, test } from "bun:test";

import { connectAsOwner, createNiwa, loginWeb, requests, tempHome, webFetch } from "@niwa-labs/testing";
import type { WebServer } from "../src/index.ts";

import { serveWebPages } from "./fixtures/serve-web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const JSON_HEADERS = { "content-type": "application/json" };

async function plainWeb(): Promise<{ home: string; web: WebServer }> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests());
  await host.serve();
  const web = await serveWebPages({ home: home.path, port: 0 });
  cleanups.push(async () => {
    await web.close();
    await host.close();
    await home.cleanup();
  });
  await loginWeb(web);
  return { home: home.path, web };
}

async function switchOff(home: string): Promise<void> {
  const owner = await connectAsOwner(home);
  try {
    await owner.call("access.switch" as never, { all: "off" } as never);
  } finally {
    await owner.close();
  }
}

const post = (web: WebServer, path: string, body: unknown): Promise<Response> =>
  webFetch(`${web.url}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

test("with the switch off every route answers a plain client's call with 403, not with a conflict or a failure", async () => {
  const { home, web } = await plainWeb();
  await switchOff(home);

  expect((await post(web, "/api/call", { action: "niwa.describe", input: {} })).status).toBe(403);
  expect((await post(web, "/answer", { request: "req-1", answer: { ids: ["yes"] } })).status).toBe(403);
  expect((await post(web, "/resolve", { invocation: "inv-1", choice: "retry" })).status).toBe(403);
  expect((await webFetch(`${web.url}/feed`)).status).toBe(403);
  expect((await webFetch(`${web.url}/api/history?after=0`)).status).toBe(403);
});
