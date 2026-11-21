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

  // The host applies the output schema and sends the result as JSON; the page gets what was sent.
  const serving = (ref: { input: z.ZodType; output: z.ZodType }, produced: unknown) =>
    fakeFetch(() => Response.json(ref.output.parse(produced)));

  test("a call by reference answers with the result the host sent, not with the schema applied again", async () => {
    const ref = { name: "count.next", input: z.object({}), output: z.number().transform((n) => n + 1) };
    const { fetch } = serving(ref, 1);
    const client = httpHostClient({ fetch });
    // The host's result is 2; running the transform on it again would make it 3.
    expect(await client.call(ref, {})).toBe(2);
  });

  test("a type that changes shape in JSON arrives as it travelled", async () => {
    const ref = { name: "run.get", input: z.object({}), output: z.object({ started: z.date() }) };
    const { fetch } = serving(ref, { started: new Date("2026-11-21T10:00:00Z") });
    const client = httpHostClient({ fetch });
    const out = await client.call(ref, {});
    const text: string = out.started;
    expect(text).toBe("2026-11-21T10:00:00.000Z");
  });

  test("a history read must be a list of records", async () => {
    const good = httpHostClient({ fetch: fakeFetch(() => Response.json([rec(1)])).fetch });
    expect((await good.records.read({ from: 0 })).map((r) => Number(r.seq))).toEqual([1]);
    const bad = httpHostClient({ fetch: fakeFetch(() => Response.json([{ nope: 1 }])).fetch });
    expect(bad.records.read({ from: 0 })).rejects.toBeInstanceOf(HostCallError);
    // The four fields a first check looked at are not all a record has.
    const { actor: _actor, ...noActor } = rec(1);
    const thin = httpHostClient({ fetch: fakeFetch(() => Response.json([noActor])).fetch });
    expect(thin.records.read({ from: 0 })).rejects.toMatchObject({ status: 502 });
  });

  test("a read sends the position and the rest of the query", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json([rec(8)]));
    const client = httpHostClient({ fetch });
    await client.records.read({ from: 7, types: ["run.*"], filter: { "run.id": "run-1" }, stream: "main" });
    const url = new URL(seen[0]!.url, "http://x");
    expect(url.pathname).toBe("/api/history");
    expect(url.searchParams.get("after")).toBe("7");
    expect(JSON.parse(url.searchParams.get("query")!)).toEqual({ types: ["run.*"], filter: { "run.id": "run-1" }, stream: "main" });
    await client.records.read();
    expect(new URL(seen[1]!.url, "http://x").searchParams.has("query")).toBe(false);
  });
});

describe("the record feed", () => {
  test("a broken feed reopens after the last record, without duplicates", async () => {
    const { fetch, seen } = fakeFetch((_url, _init, n) => (n === 1 ? sse(rec(1), rec(2)) : sse(rec(2), rec(3))));
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const abort = new AbortController();
    const got: number[] = [];
    const retries: unknown[] = [];
    for await (const r of client.records.since({ from: 0 }, { signal: abort.signal, onRetry: (e) => retries.push(e) })) {
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
      for await (const _ of client.records.since({ from: 0 })) void _;
    };
    expect(read()).rejects.toMatchObject({ status: 401 });
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
  });

  test("a broken feed reopens with the same query after the last record", async () => {
    const { fetch, seen } = fakeFetch((_url, _init, n) => (n === 1 ? sse(rec(4), rec(5)) : sse(rec(6))));
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const abort = new AbortController();
    const got: number[] = [];
    for await (const r of client.records.since({ from: 3, types: ["demo.*"] }, { signal: abort.signal })) {
      got.push(r.seq);
      if (got.length === 3) abort.abort();
    }
    const urls = seen.map((s) => new URL(s.url, "http://x"));
    expect(urls.map((u) => u.searchParams.get("after"))).toEqual(["3", "5"]);
    expect(urls.map((u) => u.searchParams.get("query"))).toEqual([JSON.stringify({ types: ["demo.*"] }), JSON.stringify({ types: ["demo.*"] })]);
  });

  // A regression must fail the test, not hang it: the feed is cut off after a few requests.
  const bounded = (answer: (url: string, init: RequestInit | undefined, n: number) => Response) => {
    const abort = new AbortController();
    const served = fakeFetch((url, init, n) => {
      if (n >= 3) abort.abort();
      return answer(url, init, n);
    });
    return { ...served, signal: abort.signal };
  };

  test("a position that is not a position is an error at once, not a request repeated for ever", async () => {
    const { fetch, seen, signal } = bounded(() => new Response("invalid journal cursor", { status: 400 }));
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const read = async () => {
      for await (const _ of client.records.since({ from: -1 }, { signal })) void _;
    };
    await expect(read()).rejects.toBeInstanceOf(TypeError);
    await expect(client.records.read({ from: 1.5 })).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(0);
  });

  test("a request the server refuses for good ends the feed; a failing server is retried", async () => {
    const refused = bounded(() => new Response("invalid record query", { status: 400 }));
    const client = httpHostClient({ fetch: refused.fetch, retryDelay: () => 0 });
    const read = async () => {
      for await (const _ of client.records.since({ from: 0 }, { signal: refused.signal })) void _;
    };
    await expect(read()).rejects.toMatchObject({ status: 400 });
    expect(refused.seen).toHaveLength(1);

    const failing = fakeFetch((_url, _init, n) => (n < 3 ? new Response("busy", { status: 503 }) : sse(rec(1))));
    const retried = httpHostClient({ fetch: failing.fetch, retryDelay: () => 0 });
    const abort = new AbortController();
    for await (const r of retried.records.since({ from: 0 }, { signal: abort.signal })) {
      expect(r.seq).toBe(1);
      abort.abort();
    }
    expect(failing.seen).toHaveLength(3);
  });

  test("a record the feed sends malformed is an error that names where the feed was, not a gap", async () => {
    const { fetch, seen, signal } = bounded(() => {
      const { actor: _actor, ...broken } = rec(3);
      return new Response(`id: 2\ndata: ${JSON.stringify(rec(2))}\n\nid: 3\ndata: ${JSON.stringify(broken)}\n\nid: 4\ndata: ${JSON.stringify(rec(4))}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = httpHostClient({ fetch, retryDelay: () => 0 });
    const got: number[] = [];
    const read = async () => {
      for await (const r of client.records.since({ from: 1 }, { signal })) got.push(r.seq);
    };
    await expect(read()).rejects.toMatchObject({ status: 502, message: expect.stringContaining("after position 2") });
    expect(got).toEqual([2]);
    expect(seen).toHaveLength(1);
  });
});
