// The line decoder judges a line by what it holds, not by where the socket cut the chunks.

import { expect, test } from "bun:test";

import { lineDecoder } from "../src/index.ts";

function run(chunks: string[], maxLineLength: number): { messages: unknown[]; errors: string[] } {
  const messages: unknown[] = [];
  const errors: string[] = [];
  const decode = lineDecoder((message) => messages.push(message), { maxLineLength, onError: (error) => errors.push(error.message) });
  for (const chunk of chunks) decode(chunk);
  return { messages, errors };
}

const LINE = JSON.stringify({ text: "x".repeat(40) });

test("a line over the limit is refused whether its newline arrives with it or after it", () => {
  const together = run([`${LINE}\n`], 20);
  const apart = run([LINE, "\n"], 20);
  expect(together.messages).toEqual([]);
  expect(apart.messages).toEqual([]);
  expect(together.errors).toHaveLength(1);
  expect(apart.errors).toHaveLength(1);
});

test("a line within the limit is read for any split of its bytes", () => {
  const whole = run([`${LINE}\n`], 100);
  const split = run([LINE.slice(0, 10), LINE.slice(10), "\n"], 100);
  expect(whole.messages).toEqual([{ text: "x".repeat(40) }]);
  expect(split.messages).toEqual(whole.messages);
});

test("the decoder stops after it refused a line", () => {
  const { messages, errors } = run([`${LINE}\n{"ok":true}\n`], 20);
  expect(messages).toEqual([]);
  expect(errors).toHaveLength(1);
});
