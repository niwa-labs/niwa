// How the command line gives the input of an action: every `--field` is the field of that name,
// and `--json` is the whole input at once.

import { expect, test } from "bun:test";

import { inputOf, withStdinJson } from "@niwa-labs/cli";
import type { ActionDescription } from "@niwa-labs/core";

/** An action whose input has a field called `input`, as request.ask does. */
const ASKING = {
  name: "demo.ask",
  description: "Asks.",
  recovery: "repeat",
  input: {
    type: "object",
    properties: { question: { type: "string" }, input: { type: "object" }, to: { type: "object" } },
  },
  output: { type: "object" },
} as unknown as ActionDescription;

test("a field named input is given as --input, like any other field", () => {
  expect(inputOf(ASKING, ["--question", "q", "--input", '{"kind":"confirm"}'])).toEqual({
    question: "q",
    input: { kind: "confirm" },
  });
});

test("--json gives the whole input, and a field flag wins over it", () => {
  const whole = '{"question":"a","input":{"kind":"text"},"to":{"kind":"owner"}}';
  expect(inputOf(ASKING, ["--json", whole, "--question", "b"])).toEqual({
    question: "b",
    input: { kind: "text" },
    to: { kind: "owner" },
  });
  expect(() => inputOf(ASKING, ["--json", "[1]"])).toThrow("--json must hold an object");
  expect(() => inputOf(ASKING, ["--json"])).toThrow("--json needs the JSON");
});

test("an action without a field input points to --json", () => {
  const plain = { ...ASKING, input: { type: "object", properties: { text: { type: "string" } } } } as unknown as ActionDescription;
  expect(() => inputOf(plain, ["--input", "{}"])).toThrow(/--json/);
});

test("--json - reads the whole input from stdin", async () => {
  const args = await withStdinJson(["--question", "q", "--json", "-"], async () => '{"to":{"kind":"owner"}}');
  expect(inputOf(ASKING, args)).toEqual({ question: "q", to: { kind: "owner" } });
  // Arguments with no `-` are left alone, and stdin is not read.
  expect(
    await withStdinJson(["--question", "q"], async () => {
      throw new Error("stdin was read");
    }),
  ).toEqual(["--question", "q"]);
});
