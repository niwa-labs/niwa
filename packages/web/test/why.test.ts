// Why: from any result on the page one can walk to the message that started it.
//
// A real host process, a real web surface, and real HTTP requests:
//
//   1. the host is started, the web surface connects to it
//   2. an external input is written; the handler produces a result from it
//   3. the trace page of the result is opened: it names the record, and links to the chain
//   4. walking the links up reaches the external input that started it: the record whose cause
//      is nothing
//   5. the chain is walked over HTTP, exactly as the page walks it
//
// The walk is the one the core does: `causes` up and `trace` down.

import { expect, test } from "bun:test";

import { spawnHost, tempHome, loginWeb, webFetch, connectAsOwner } from "@niwa-labs/testing";
import type { WebServer } from "../src/index.ts";
import { serveWebPages } from "./fixtures/serve-web.ts";
import { Done, Start } from "./fixtures/why-host.ts";

const HOST_SCRIPT = new URL("./fixtures/why-host.ts", import.meta.url).pathname;

/** The chain of one record, as the server answers it. */
interface Chain {
  record: string;
  causes: Array<{ id: string; type: string; cause: string | null; root: string; depth: number }>;
  trace: Array<{ id: string; type: string; cause: string | null; root: string; depth: number }>;
  root: string | null;
}

/** The chain of one record, over HTTP. */
async function chainOf(url: string, id: string): Promise<Chain> {
  const response = await webFetch(`${url}/trace-data/${encodeURIComponent(id)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Chain;
}

test("why: from the trace page of a result one can walk to the external input that started it", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);
  let web: WebServer | undefined;

  try {
    await host.ready();
    web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    await loginWeb(web);

    // The external input: the chain starts here.
    const writer = await connectAsOwner(home.path);
    const input = await writer.emit(Start, { text: "the message" });

    // The result: what the handler produced from it.
    let resultId = "";
    await waitFor(async () => {
      const chain = await chainOf(web!.url, input.id);
      const done = chain.trace.find((record) => record.type === "why.done");
      if (done === undefined) return false;
      resultId = done.id;
      return true;
    }, "the result reaches the trace");

    // The trace page of the result: it is HTML, it names the record, and it links to the chain.
    const page = await webFetch(`${web.url}/trace/${encodeURIComponent(resultId)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(resultId);
    // The page links to the chain: to the record it depends on, and to its own page.
    expect(html).toContain(`href="/trace/${encodeURIComponent(input.id)}"`);
    expect(html).toContain(`href="/trace/${encodeURIComponent(resultId)}"`);
    // The external input is named on the page, with nothing above it.
    expect(html).toContain("why.start");
    expect(html).toContain("cause none");

    // Walking up from the result reaches the external input: the record whose cause is nothing.
    const chain = await chainOf(web.url, resultId);
    expect(chain.record).toBe(resultId);
    expect(chain.causes.length).toBeGreaterThan(0);

    const external = chain.causes.find((record) => record.cause === null);
    expect(external).toBeDefined();
    expect(external?.id).toBe(input.id);
    expect(external?.type).toBe("why.start");

    // The root of the chain is the external input, and every record of it says so.
    expect(chain.root).toBe(input.id);
    for (const record of [...chain.causes, ...chain.trace]) {
      expect(record.root).toBe(input.id);
    }

    // The walk is a walk: the links on the page lead to the next page, and following them reaches
    // the external input.
    const seen = new Set<string>();
    let current = chain.causes[0];
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      expect(current.id).toStartWith("rec_");
      // The page of the record links to the record it depends on: the link is what a reader follows.
      const page = await webFetch(`${web.url}/trace/${encodeURIComponent(current.id)}`);
      const pageHtml = await page.text();
      expect(pageHtml).toContain(`href="/trace/${encodeURIComponent(input.id)}"`);
      const next = await chainOf(web.url, current.id);
      const up = next.causes.find((record) => record.cause === null);
      current = up ?? next.causes[0];
      if (next.causes.length === 0) break;
    }
    expect(seen.has(input.id)).toBe(true);

    // The trace page of the external input itself: it is the start of its chain.
    const inputChain = await chainOf(web.url, input.id);
    expect(inputChain.causes).toEqual([]);
    expect(inputChain.root).toBe(input.id);

    // What the record holds is shown as text, never as markup.
    const hostile = await writer.emit(Start, { text: "<script>alert(1)</script>\"><img src=x>" });
    let hostileId = "";
    await waitFor(async () => {
      const done = (await chainOf(web!.url, hostile.id)).trace.find((record) => record.type === "why.done");
      hostileId = done?.id ?? "";
      return done !== undefined;
    }, "the hostile result reaches the trace");
    const hostilePage = await (await webFetch(`${web.url}/trace/${encodeURIComponent(hostileId)}`)).text();
    expect(hostilePage).not.toContain("<script>alert");
    expect(hostilePage).not.toContain("<img");
    expect(hostilePage).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    // A record that is not there, and an id that is not one, are refused by name.
    expect((await webFetch(`${web.url}/trace/rec_nothing`)).status).toBe(404);
    expect((await webFetch(`${web.url}/trace-data/rec_nothing`)).status).toBe(404);
    expect((await webFetch(`${web.url}/trace/%E0%A4%A`)).status).toBe(400);
    expect((await webFetch(`${web.url}/trace/${encodeURIComponent(resultId)}`, { method: "POST" })).status).toBe(405);

    await writer.close();
  } finally {
    await web?.close();
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

/** Wait until a condition holds; the message says what was waited for. */
async function waitFor(fn: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
