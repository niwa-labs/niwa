// What a page may call is the grant's matter, not a list of the web surface.
//
//   1. a page that speaks for the owner calls any action the host declares, not only the ones a list knew
//   2. a plain client's call is decided by its grant: allowed under a rule, refused with 403 without one
//   3. the viewer says who is looking and which actions the grant lets through; the info lists the same actions
//   4. a name that is no action name is a bad request, and an action nobody declared is the host's refusal
//   5. the journal feed starts after a position the page chooses, from the end the info names
//   6. the input of a call is any JSON value: its shape is the action's schema to judge
//   7. a connection that may not read the journal is refused 403 by the history and the stream, and a stream opens only once accepted

import { afterEach, expect, test } from "bun:test";

import { action, actionName, record } from "@niwa-labs/core";
import { connectAsOwner, createNiwa, loginWeb, plugin, tempHome, webFetch } from "@niwa-labs/testing";
import type { WebOptions, WebServer } from "../src/index.ts";
import { z } from "zod";

import { serveWebPages } from "./fixtures/serve-web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const Empty = z.object({});
const Ok = z.object({ ok: z.boolean() });
// An output schema that does something to what it checks: running it twice is not running it once.
const Next = z.number().transform((n) => n + 1);
const When = z.object({ at: z.date() });

const Note = record("demo.note", z.object({ n: z.number() }), { open: true });
const Other = record("demo.other", z.object({ n: z.number() }), { open: true });

const demo = plugin("demo", (api) => {
  api.declare(Note);
  api.declare(Other);
  api.action(action("demo.next", { description: "Counts.", input: Empty, output: Next, recovery: "repeat", effect: "read", run: () => 1 }));
  api.action(action("demo.when", { description: "Dates.", input: Empty, output: When, recovery: "repeat", effect: "read", run: () => ({ at: new Date("2026-11-21T10:00:00Z") }) }));
  api.action(action("demo.read", { description: "Reads.", input: Empty, output: Ok, recovery: "repeat", effect: "read", run: () => ({ ok: true }) }));
  api.action(action("demo.echo", { description: "Echoes a text.", input: z.string(), output: z.string(), recovery: "repeat", effect: "read", run: (text: string) => text }));
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

async function served(home: string, speaksFor?: "owner", ownerActions?: NonNullable<WebOptions["ownerActions"]>): Promise<WebServer> {
  const web = await serveWebPages({ home, port: 0, ...(speaksFor === undefined ? {} : { speaksFor }), ...(ownerActions === undefined ? {} : { ownerActions }) });
  cleanups.push(() => web.close());
  await loginWeb(web);
  return web;
}

const call = (web: WebServer, action: string, input: unknown = {}): Promise<Response> =>
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

test("a call carries any JSON value as its input, and the action's schema decides whether it fits", async () => {
  const web = await served(await hosted(), "owner");
  const echoed = await call(web, "demo.echo", "hello");
  expect(echoed.status).toBe(200);
  expect(await echoed.json()).toBe("hello");
  // A value the schema refuses is the host's refusal of the call, not a malformed request.
  expect((await call(web, "demo.echo", { text: "hello" })).status).toBe(409);
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

test("a connection the grant does not let read the journal is refused 403 by the history and by the stream, before it opens", async () => {
  const home = await hosted();
  const web = await served(home);
  await grantDefault(home, ["access.mine", "niwa.describe"]);
  expect((await webFetch(`${web.url}/api/history?after=0`)).status).toBe(403);
  const stream = await webFetch(`${web.url}/api/events?after=0`, { headers: { accept: "text/event-stream" } });
  expect(stream.status).toBe(403);
  expect(stream.headers.get("content-type")).not.toContain("text/event-stream");

  // Once the grant lets the connection read, the stream opens, and it does so on a journal with nothing after the position.
  await grantDefault(home, ["niwa.records.read"]);
  const abort = new AbortController();
  const open = await webFetch(`${web.url}/api/events?after=999999`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
  try {
    expect(open.status).toBe(200);
    expect(open.headers.get("content-type")).toContain("text/event-stream");
  } finally {
    abort.abort();
  }
});

test("a page asks for history and its live continuation with one query", async () => {
  const home = await hosted();
  const web = await served(home, "owner");
  const owner = await connectAsOwner(home);
  cleanups.push(() => owner.close());
  await owner.emit(Note, { n: 1 });
  await owner.emit(Other, { n: 2 });
  await owner.emit(Note, { n: 3 });

  const ask = (params: Record<string, string>): string => `?${new URLSearchParams(params).toString()}`;
  const notes = JSON.stringify({ types: ["demo.note"] });
  const history = (await (await webFetch(`${web.url}/api/history${ask({ after: "0", query: notes })}`)).json()) as Array<{ type: string; data: { n: number } }>;
  expect(history.map((record) => [record.type, record.data.n])).toEqual([["demo.note", 1], ["demo.note", 3]]);

  const byData = JSON.stringify({ types: ["demo.*"], filter: { n: 2 } });
  const filtered = (await (await webFetch(`${web.url}/api/history${ask({ after: "0", query: byData })}`)).json()) as Array<{ type: string }>;
  expect(filtered.map((record) => record.type)).toEqual(["demo.other"]);

  // The live continuation answers the same query: the other type never arrives.
  const feed = await eventsOf(`${web.url}/api/events${ask({ after: "0", query: notes })}`, 2);
  expect(feed.map((record) => record.type)).toEqual(["demo.note", "demo.note"]);

  for (const bad of ["{", JSON.stringify({ types: ["!demo.note"] }), JSON.stringify({ from: 3 }), JSON.stringify({ nope: 1 })]) {
    expect((await webFetch(`${web.url}/api/history${ask({ after: "0", query: bad })}`)).status).toBe(400);
    expect((await webFetch(`${web.url}/api/events${ask({ after: "0", query: bad })}`)).status).toBe(400);
  }
});

test("a call answers with the result the host returned, whether or not the page has a hook for the action", async () => {
  const home = await hosted();
  const hooked = (name: string, output: z.ZodType) => ({ ref: { name: actionName(name), input: Empty, output } });
  const hooks = await served(home, "owner", [hooked("demo.next", Next), hooked("demo.when", When)]);
  const plain = await served(home, "owner");
  for (const web of [hooks, plain]) {
    // The host's result is 2; the transform is not run again on its way to the page.
    expect(await (await call(web, "demo.next")).json()).toBe(2);
    // A date is its text on the wire; a hook's schema, which wants a date, does not refuse what the host made of it.
    const when = await call(web, "demo.when");
    expect(when.status).toBe(200);
    expect(await when.json()).toEqual({ at: "2026-11-21T10:00:00.000Z" });
  }
});
