// What a list and a read show of a request, whatever the asker wrote as its title.

import { expect, test } from "bun:test";

import { descriptionOf } from "../src/entity.ts";
import { RequestId } from "../src/records.ts";
import { question } from "../src/question.ts";

const id = RequestId.parse("req-abcdef");

test("a title too short to read is put after the name of the question", () => {
  expect(descriptionOf({ id, question: question("rel.ok", { kind: "text", title: "ok" }).question, input: { kind: "text", title: "ok" } })).toBe("rel.ok ok");
});

test("a request whose name and title are both too short is described by its id, and can still be read", () => {
  const asked = question("q", { kind: "text", title: " " });
  expect(descriptionOf({ id, question: asked.question, input: asked.input })).toBe(id);
});
