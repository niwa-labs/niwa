// The input of an agent process: a line that did not go out is reported, not dropped.

import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { inputOpen, writeLine } from "../src/mcode/transport.ts";

/** A stream that takes each chunk the way `take` says: it fails it, or lets it through. */
function stream(take: (chunk: string, done: (error?: Error | null) => void) => void): Writable {
  return new Writable({ write: (chunk, _encoding, done) => take(String(chunk), done) });
}

test("a line the stream takes is accepted, with a line feed after it", async () => {
  const seen: string[] = [];
  const input = stream((chunk, done) => {
    seen.push(chunk);
    done();
  });
  await writeLine(input, '{"a":1}');
  expect(seen).toEqual(['{"a":1}\n']);
});

test("a line the stream fails is rejected with the failure", async () => {
  const input = stream((_chunk, done) => done(new Error("EPIPE")));
  input.on("error", () => undefined);
  await expect(writeLine(input, "x")).rejects.toThrow("EPIPE");
});

test("a closed input is refused at once, not written to", () => {
  const input = stream((_chunk, done) => done());
  input.end();
  expect(inputOpen(input)).toBe(false);
  expect(() => writeLine(input, "x")).toThrow("closed");
  const destroyed = stream((_chunk, done) => done());
  destroyed.destroy();
  expect(() => writeLine(destroyed, "x")).toThrow("closed");
  expect(() => writeLine(undefined, "x")).toThrow("closed");
});

test("a stream that throws on write is refused at once", () => {
  const input = new Writable({
    write: () => undefined,
  });
  input.write = () => {
    throw new Error("broken");
  };
  expect(() => writeLine(input, "x")).toThrow("broken");
});
