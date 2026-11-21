// The cockpit of `niwa web`: the app it serves, the notice it serves without one, and the actions of
// the workflow page, which only the owner's page may call.

import { afterEach, expect, test } from "bun:test";

import { TOKEN_ENV } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { requests } from "@niwa-labs/requests";
import { timers } from "@niwa-labs/timer";
import { workflow } from "@niwa-labs/workflow";
import { loginWeb, tempHome, webFetch } from "@niwa-labs/testing";
import type { WebServer } from "@niwa-labs/web";

import { buildCockpit, cockpitApp } from "@niwa-labs/cockpit";
import { join } from "node:path";

import { NOTICE_PAGES, serveCockpit, startWeb } from "../src/web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function hosted(): Promise<string> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  cleanups.push(async () => {
    await host.close();
    await home.cleanup();
  });
  return home.path;
}

async function served(home: string, speaksFor?: "owner"): Promise<WebServer> {
  const web = await serveCockpit({ home, port: 0, pages: NOTICE_PAGES, ...(speaksFor === undefined ? {} : { speaksFor }) });
  cleanups.push(() => web.close());
  await loginWeb(web);
  return web;
}

const call = (web: WebServer, action: string, input: Record<string, unknown>): Promise<Response> =>
  webFetch(`${web.url}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, input }),
  });

test("without an app, the feed and the trace are a plain notice", async () => {
  const web = await served(await hosted());
  const page = await webFetch(web.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("The cockpit app is not installed");
});

test("the owner's page calls the workflow actions, and a start names exactly one of an id and a file", async () => {
  const web = await served(await hosted(), "owner");
  const listed = await call(web, "workflow.list", {});
  expect(listed.status).toBe(200);

  const both = await call(web, "workflow.start", { id: "a", file: "b.ts" });
  expect(both.status).toBe(400);
  expect(await both.text()).toBe("a workflow start requires exactly one of id or file");
});

test("a page that does not speak for the owner may not call them", async () => {
  const web = await served(await hosted());
  const listed = await call(web, "workflow.list", {});
  expect(listed.status).toBe(403);
});

test("`niwa web` serves the cockpit app, not the notice, and the app's page names the modules it shares", async () => {
  const home = await hosted();
  const site = join(home, "site");
  await buildCockpit({ outDir: site });
  const web = await startWeb(home, 0, {}, await cockpitApp({ root: site }));
  cleanups.push(() => web.close());
  await loginWeb(web);

  const page = await webFetch(web.url);
  expect(page.status).toBe(200);
  const body = await page.text();
  expect(body).not.toContain("The cockpit app is not installed");
  expect(body).toContain('<script type="importmap">');
  expect(body).toContain('<div id="root">');
  // Without the token variable the page speaks for the owner, so the owner's actions are open to it.
  expect((await call(web, "workflow.list", {})).status).toBe(200);
}, 60_000);

test("a process that a session started is a plain client of the cockpit", async () => {
  const home = await hosted();
  const site = join(home, "site");
  await buildCockpit({ outDir: site });
  const web = await startWeb(home, 0, { [TOKEN_ENV]: "session-secret" }, await cockpitApp({ root: site }));
  cleanups.push(() => web.close());
  await loginWeb(web);
  expect((await call(web, "workflow.list", {})).status).toBe(403);
}, 60_000);
