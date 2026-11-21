// The feed: open requests and paused work are on the page, and answering from the page continues
// the waiting invocation.
//
// A real host process, a real web surface, and a real HTTP request:
//
//   1. the host is started, the web surface connects to it as the client "web"
//   2. a record is written that makes an invocation pause
//   3. the paused invocation is on the page: the feed names it and offers its choices
//   4. POST /resolve answers it — and the waiting invocation continues: the step runs again
//   5. the invocation is not on the feed any more
//
// The web surface is a client of the host: nothing is written into the journal by the surface
// itself, and the answer goes through the core's own action.

import { expect, test } from "bun:test";

import { spawnHost, tempHome, lastState, loginWeb, watch, webFetch, connectAsOwner } from "@niwa-labs/testing";
import type { WebServer } from "../src/index.ts";
import { serveWebPages } from "./fixtures/serve-web.ts";
import { callCount, Start } from "./fixtures/feed-host.ts";

const HOST_SCRIPT = new URL("./fixtures/feed-host.ts", import.meta.url).pathname;

/** The feed of the page, as the server answers it. */
interface FeedEntry {
  kind: string;
  id: string;
  record: string;
  text: string;
  choices: string[];
}

/** Read the feed of the surface over HTTP. */
async function readFeed(url: string): Promise<FeedEntry[]> {
  const response = await webFetch(`${url}/feed`);
  expect(response.status).toBe(200);
  return (await response.json()) as FeedEntry[];
}

test("the feed: a paused invocation is on the page, and answering it from the page continues it", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let web: WebServer | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    await host.ready();
    web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    await loginWeb(web);
    observer = await watch(home.path);

    // The page itself is HTML, and it names the feed.
    const page = await webFetch(web.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("/events");

    // A record that makes the invocation pause: the guard refuses the step.
    const writer = await connectAsOwner(home.path);
    await writer.emit(Start, { n: 7 });
    await writer.close();

    // The invocation is paused, and the feed says so: the page shows what waits for the owner.
    await waitFor(async () => (await readFeed(web!.url)).length > 0, "the pause reaches the feed");
    const feed = await readFeed(web.url);
    const paused = feed.find((entry) => entry.kind === "paused");
    expect(paused).toBeDefined();
    expect(paused?.choices).toEqual(["retry", "skip", "cancel"]);
    // The core names the pause by the step and what came of it.
    expect(paused?.text).toContain("denied");
    // The entry links to the record that says it waits.
    expect(paused?.record).toStartWith("st_");

    // The same list arrives over SSE, so the page follows the journal.
    const stream = await webFetch(`${web.url}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const streamed = await firstEvent(stream);
    expect(streamed.map((entry) => entry.id)).toEqual([paused?.id as string]);

    // The answer is refused unless it is a JSON POST of the right shape.
    const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
      webFetch(`${web!.url}/resolve`, { method: "POST", headers, body });
    expect((await webFetch(`${web.url}/resolve`)).status).toBe(405);
    expect((await webFetch(`${web.url}/events`, { method: "POST" })).status).toBe(405);
    expect((await post("{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("not json")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
    expect((await post(JSON.stringify({ invocation: paused?.id, choice: "explode" }))).status).toBe(400);
    expect((await post(JSON.stringify({ invocation: paused?.id, choice: "retry" }), {
      "content-type": "application/json",
      origin: "http://evil.example",
    })).status).toBe(403);
    expect((await webFetch(`${web.url}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"request\":\"r\"}" })).status).toBe(400);
    // None of that answered anything: the invocation still waits and the step has not run.
    expect((await readFeed(web!.url)).map((entry) => entry.id)).toEqual([paused?.id as string]);
    expect(callCount(home.path)).toBe(0);

    // Answering from the page continues the waiting invocation.
    const answered = await webFetch(`${web.url}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invocation: paused?.id, choice: "retry" }),
    });
    expect(answered.status).toBe(200);

    // The step ran again: the work happened after the owner answered.
    await waitFor(() => callCount(home.path) === 1, "the step runs again after the answer");
    expect(callCount(home.path)).toBe(1);

    // The invocation is not waiting any more, so it is not on the feed.
    await waitFor(async () => (await readFeed(web!.url)).length === 0, "the feed is empty again");
    expect(await readFeed(web.url)).toEqual([]);

    // The answer went through the core's own action, which wrote its record.
    const resolved = observer.seen.find((record) => record.type === "niwa.invocation.resolved");
    expect(resolved).toBeDefined();

    // Closing the surface ends the open stream and leaves nothing listening.
    await web!.close();
    expect(await drained(stream)).toBe(true);
    await expect(webFetch(web.url)).rejects.toThrow();
  } finally {
    await web?.close();
    await observer?.stop();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

/** The first list a stream sends. */
async function firstEvent(response: Response): Promise<FeedEntry[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("the stream ended before it sent the feed");
    buffer += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  return JSON.parse(buffer.slice("data: ".length)) as FeedEntry[];
}

/** Whether the stream ends by itself within a moment. */
async function drained(response: Response): Promise<boolean> {
  const reader = response.body!.getReader();
  const end = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000));
  const read = (async () => {
    for (;;) if ((await reader.read()).done) return true;
  })().catch(() => true);
  return Promise.race([read, end]);
}

/** Wait until a condition holds; the message says what was waited for. */
async function waitFor(fn: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
