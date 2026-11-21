// What a page may call is the grant's matter, not a list of the web surface.
//
//   1. a page that speaks for the owner calls any action the host declares, not only the ones a list knew
//   2. a plain client's call is decided by its grant: allowed under a rule, refused with 403 without one
//   3. the viewer says who is looking and which actions the grant lets through; the info lists the same actions
//   4. a name that is no action name is a bad request, and an action nobody declared is the host's refusal
//   5. the journal feed starts after a position the page chooses, from the end the info names

import { afterEach, expect, test } from "bun:test";

import { action, record } from "@niwa-labs/core";
import { connectAsOwner, createNiwa, loginWeb, plugin, tempHome, webFetch } from "@niwa-labs/testing";
import type { WebServer } from "../src/index.ts";
import { z } from "zod";

import { serveWebPages } from "./fixtures/serve-web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const Empty = z.object({});
const Ok = z.object({ ok: z.boolean() });

const Note = record("demo.note", z.object({ n: z.number() }), { open: true });

const demo = plugin("demo", (api) => {
  api.declare(Note);
  api.action(action("demo.read", { description: "Reads.", input: Empty, output: Ok, recovery: "repeat", effect: "read", run: () => ({ ok: true }) }));
  api.action(action("demo.write", { description: "Writes.", input: Empty, output: Ok, recovery: "do-not-repeat", effect: "write", run: () => ({ ok: true }) }));
});

async function hosted(): Promise<string> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(demo);
  await host.serve();
  cleanups.push(async () => {
    await host.close();
    await home.cleanup();
  });
  return home.path;
}

async function served(home: string, speaksFor?: "owner"): Promise<WebServer> {
  const web = await serveWebPages({ home, port: 0, ...(speaksFor === undefined ? {} : { speaksFor }) });
  cleanups.push(() => web.close());
  await loginWeb(web);
  return web;
}

const call = (web: WebServer, action: string, input: Record<string, unknown> = {}): Promise<Response> =>
  webFetch(`${web.url}/api/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, input }) });

/** The default grant: what a client that has no token of its own may do. */
async function grantDefault(home: string, rules: string[]): Promise<void> {
  const owner = await connectAsOwner(home);
  try {
    await owner.call("access.profile.set" as never, { name: "default", rules } as never);
  } finally {
    await owner.close();
  }
}

test("a page that speaks for the owner calls an action no list ever named", async () => {
  const web = await served(await hosted(), "owner");
  const answer = await call(web, "demo.write");
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ ok: true });
});

test("a plain client's call is allowed by a rule of its grant and refused with 403 without one", async () => {
  const home = await hosted();
  const web = await served(home);
  const refused = await call(web, "demo.read");
  expect(refused.status).toBe(403);
  expect(await refused.text()).toContain("not in the grant");

  await grantDefault(home, ["demo.read"]);
  expect((await call(web, "demo.read")).status).toBe(200);
  expect((await call(web, "demo.write")).status).toBe(403);
});

test("a name that is no action name is a bad request, and an action nobody declared is refused by the host", async () => {
  const web = await served(await hosted(), "owner");
  expect((await call(web, "Not An Action!")).status).toBe(400);
  expect((await call(web, "")).status).toBe(400);
  const unknown = await call(web, "demo.nothing");
  expect(unknown.status).toBe(409);
});

test("the viewer is the owner with every action, or a client with the actions its grant lets through", async () => {
  const home = await hosted();
  const ownerWeb = await served(home, "owner");
  const owner = (await (await webFetch(`${ownerWeb.url}/api/viewer`)).json()) as { id: string; owner: boolean; actions: string[] };
  expect(owner).toMatchObject({ id: "owner", owner: true });
  expect(owner.actions).toEqual(expect.arrayContaining(["demo.read", "demo.write", "niwa.cockpit.catalog"]));

  const plainWeb = await served(home);
  // A client that may not read its own rules is told apart from one that may call nothing only by what it can see.
  const blind = (await (await webFetch(`${plainWeb.url}/api/viewer`)).json()) as { owner: boolean; actions: string[] };
  expect(blind).toEqual({ id: "web", owner: false, actions: [] });

  await grantDefault(home, ["access.mine", "demo.read"]);
  const limited = (await (await webFetch(`${plainWeb.url}/api/viewer`)).json()) as { id: string; owner: boolean; actions: string[] };
  expect(limited.owner).toBe(false);
  expect(limited.id).toStartWith("web");
  expect(limited.actions).toEqual(["access.mine", "demo.read"]);
  const info = (await (await webFetch(`${plainWeb.url}/api/info`)).json()) as { actions: string[] };
  expect(info.actions).toEqual(limited.actions);
});

/** The records an event stream sends, up to the first `count`, as the page's `fetch` reads them. */
async function eventsOf(url: string, count: number, headers: Record<string, string> = {}): Promise<Array<{ eventId: number; seq: number; type: string }>> {
  const abort = new AbortController();
  const response = await webFetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const found: Array<{ eventId: number; seq: number; type: string }> = [];
  let buffer = "";
  while (found.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      if (data !== undefined && id !== undefined) found.push({ eventId: Number(id), ...(JSON.parse(data) as { seq: number; type: string }) });
    }
  }
  abort.abort();
  return found;
}

test("the journal feed starts after the position the page names, and the info says where the journal ends", async () => {
  const home = await hosted();
  const web = await served(home, "owner");
  const owner = await connectAsOwner(home);
  cleanups.push(() => owner.close());
  for (let n = 0; n < 3; n += 1) await owner.emit(Note, { n });

  const end = ((await (await webFetch(`${web.url}/api/info`)).json()) as { seq: number }).seq;
  expect(end).toBeGreaterThan(3);

  const all = await eventsOf(`${web.url}/api/events?after=0`, end);
  expect(all.map((record) => record.seq)).toEqual(Array.from({ length: end }, (_, index) => index + 1));
  expect(all.every((record) => record.eventId === record.seq)).toBe(true);

  const after = end - 2;
  expect((await eventsOf(`${web.url}/api/events?after=${String(after)}`, 2)).map((record) => record.seq)).toEqual([end - 1, end]);
  // A reconnecting page resumes from the id of the last record it saw; that wins over the query.
  expect((await eventsOf(`${web.url}/api/events?after=0`, 1, { "last-event-id": String(end - 1) })).map((record) => record.seq)).toEqual([end]);

  const history = (await (await webFetch(`${web.url}/api/history?after=${String(after)}`)).json()) as Array<{ seq: number }>;
  expect(history.map((record) => record.seq)).toEqual([end - 1, end]);
  expect((await webFetch(`${web.url}/api/events?after=-1`)).status).toBe(400);
  expect((await webFetch(`${web.url}/api/events?after=x`)).status).toBe(400);
});
