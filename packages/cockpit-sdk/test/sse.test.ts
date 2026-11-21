import { describe, expect, test } from "bun:test";

import { serverEvents, type ServerEvent } from "../src/index.ts";

async function events(chunks: string[]): Promise<ServerEvent[]> {
  async function* source() {
    yield* chunks;
  }
  const out: ServerEvent[] = [];
  for await (const event of serverEvents(source())) out.push(event);
  return out;
}

describe("server events", () => {
  test("events split across chunks, with comments skipped", async () => {
    expect(await events([": connected\n\nid: 4\nda", "ta: {\"a\":1}\n", "\nid: 5\ndata: x\n\n"])).toEqual([
      { id: "4", event: "message", data: '{"a":1}' },
      { id: "5", event: "message", data: "x" },
    ]);
  });

  test("CRLF and CR line ends, a CRLF split between chunks", async () => {
    expect(await events(["data: a\r", "\n\r\ndata: b\r\r"])).toEqual([
      { id: undefined, event: "message", data: "a" },
      { id: undefined, event: "message", data: "b" },
    ]);
  });

  test("several data lines join with newlines; event names are kept", async () => {
    expect(await events(["event: ping\ndata: one\ndata:two\n\n"])).toEqual([{ id: undefined, event: "ping", data: "one\ntwo" }]);
  });

  test("an event cut off by the end of the stream is dropped", async () => {
    expect(await events(["data: whole\n\ndata: half"])).toEqual([{ id: undefined, event: "message", data: "whole" }]);
  });
});
