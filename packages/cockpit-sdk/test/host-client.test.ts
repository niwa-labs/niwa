import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { HostCallError, httpHostClient, type StoredRecord } from "../src/index.ts";
import { rec } from "./fixtures.ts";

type Seen = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    return answer(url, init, seen.length);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function sse(...records: StoredRecord[]): Response {
  const body = ": connected\n\n" + records.map((r) => `id: ${r.seq}\ndata: ${JSON.stringify(r)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("calls", () => {
  test("a call posts the action and its input as JSON and answers with the result", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json({ ok: true }));
    const client = httpHostClient({ base: "http://localhost:4000/", fetch });
    expect(await client.call("task.list", { open: true })).toEqual({ ok: true });
    expect(seen[0]!.url).toBe("http://localhost:4000/api/call");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(new Headers(seen[0]!.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ action: "task.list", input: { open: true } });
  });

  test("a refused call is an error with the status and the server's reason", async () => {
    const { fetch } = fakeFetch(() => new Response("the run is not running", { status: 409 }));
    const client = httpHostClient({ fetch });
    const error = await client.call("run.stop", { run: "run-1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostCallError);
    expect(error).toMatchObject({ status: 409, message: "the run is not running", action: "run.stop" });
  });

  test("a call by reference answers with what the output schema makes of the result", async () => {
    const ref = {
      name: "run.get",
      input: z.object({ run: z.string() }),
      output: z.object({ started: z.iso.datetime().transform((s) => new Date(s)) }),
    };
    const good = httpHostClient({ fetch: fakeFetch(() => Response.json({ started: "2026-11-21T10:00:00Z" })).fetch });
    const out = await good.call(ref, { run: "run-1" });
    expect(out.started).toBeInstanceOf(Date);
    const bad = httpHostClient({ fetch: fakeFetch(() => Response.json({ started: 42 })).fetch });
    expect(bad.call(ref, { run: "run-1" })).rejects.toMatchObject({ status: 502, action: "run.get" });
  });

  test("a history read must be a list of records", async () => {
    const good = httpHostClient({ fetch: fakeFetch(() => Response.json([rec(1)])).fetch });
    expect((await good.records.read(0)).map((r) => Number(r.seq))).toEqual([1]);
    const bad = httpHostClient({ fetch: fakeFetch(() => Response.json([{ nope: 1 }])).fetch });
    expect(bad.records.read(0)).rejects.toBeInstanceOf(HostCallError);
  });
});

describe("the record feed", () => {
  test("a broken feed reopens after the last record, without duplicates", async () => {
    const { fetch, seen } = fakeFetch((_url, _init, n) => (n === 1 ? sse(rec(1), rec(2)) : sse(rec(2), rec(3))));
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const abort = new AbortController();
    const got: number[] = [];
    const retries: unknown[] = [];
    for await (const r of client.records.since(0, { signal: abort.signal, onRetry: (e) => retries.push(e) })) {
      got.push(r.seq);
      if (got.length === 3) abort.abort();
    }
    expect(got).toEqual([1, 2, 3]);
    expect(seen.map((s) => new URL(s.url, "http://x").searchParams.get("after"))).toEqual(["0", "2"]);
    expect(retries).toHaveLength(1);
  });

  test("a lost login ends the feed with an error instead of retrying", async () => {
    const { fetch, seen } = fakeFetch(() => new Response("log in", { status: 401 }));
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const read = async () => {
      for await (const _ of client.records.since(0)) void _;
    };
    expect(read()).rejects.toMatchObject({ status: 401 });
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
  });
});
