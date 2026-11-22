import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DataValue, FileRef, SchemaView } from "../src/index.ts";

test("stored JSON strings and nested results render as labelled values", () => {
  const view = renderToStaticMarkup(<DataValue value={{ result: '{"answer":"готово","count":2,"ok":true}' }} />);
  expect(view).toContain("<dt");
  for (const text of ["Результат", "Ответ", "готово", "Да"]) expect(view).toContain(text);
  expect(view).not.toContain("&quot;answer&quot;");
  expect(view).not.toContain("[object Object]");
});

test("paths use the basename and keep the original clipboard value", () => {
  const view = renderToStaticMarkup(<FileRef path="/work/qa/scripts/review.ts" />);
  expect(view).toContain("<b>review.ts</b>");
  expect(view).toContain('title="/work/qa/scripts/review.ts"');
  expect(view).toContain("qa/scripts/");
});

test("workflow inputs expose the required fields, references, defaults and constraints", () => {
  const schema = {
    type: "object",
    properties: { branch: { type: "string", default: "main", minLength: 1 }, repo: { $ref: "#/$defs/repo" } },
    required: ["repo"],
    $defs: { repo: { type: "object", properties: { path: { type: "string", description: "Local clone" } } } },
  };
  const view = renderToStaticMarkup(<SchemaView schema={schema} />);
  for (const text of ["branch", "По умолчанию", "main", "Обязательно", "path", "Local clone", "Мин. символов"])
    expect(view).toContain(text);
  expect(view).not.toContain("minLength");
});
