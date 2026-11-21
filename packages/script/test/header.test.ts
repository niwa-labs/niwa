// The header of a script, read from its text: `on` is what starts it, and where the text does not say, the
// reader says so instead of naming a trigger the script may not have.

import { expect, test } from "bun:test";

import { declarationField, scriptOn } from "../src/index.ts";

const read = (declaration: string, preface = "") =>
  scriptOn({ file: "script.ts", text: `${preface}\nexport default workflow(${declaration}, async () => {});` });

test("on written in the declaration is read as it is, the last key of that name winning", async () => {
  expect(await read('{ on: ["a.b"] }')).toMatchObject({ subscriptions: [{ type: "a.b" }] });
  expect(await read('{ on: ["a.b"], on: ["c.d"] }')).toMatchObject({ subscriptions: [{ type: "c.d" }] });
  expect(await read('{ ...base, on: ["a.b"] }', "const base = {};")).toMatchObject({ subscriptions: [{ type: "a.b" }] });
  expect(await read('{ description: "none" }')).toBeUndefined();
});

test("on that a spread may replace, or that is only a name, is reported as unreadable, not as a trigger", async () => {
  for (const declaration of [
    '{ on: ["a.b"], ...other }',
    '{ on: ["a.b"], ...{ on: ["c.d"] } }',
    '{ on: ["a.b"], [key]: 1 }',
    "{ on }",
    '{ on: ["a.b"], on }',
    "{ ...other }",
  ]) {
    const parsed = await read(declaration, "const other = {}, key = 'on', on = ['c.d'];");
    expect({ declaration, parsed }).toMatchObject({ parsed: { bad: { message: expect.stringContaining("on ") } } });
  }
});

test("an empty record type is refused whether it is written bare or in an object", async () => {
  expect(await read("{ on: [''] }")).toHaveProperty("bad");
  expect(await read("{ on: [{ type: '' }] }")).toHaveProperty("bad");
  expect(await read("{ on: ['a', ''] }")).toHaveProperty("bad");
});

test("on that a getter, a setter or a method may decide is unreadable, and a later plain key settles it again", async () => {
  const preface = "const key = 'on';";
  for (const declaration of [
    'get on() { return ["c.d"]; }',
    'on: ["a.b"], get on() { return ["c.d"]; }',
    'on: ["a.b"], set on(value) {}',
    'on: ["a.b"], on() { return 1; }',
    'on: ["a.b"], get [key]() { return ["c.d"]; }',
    'on: ["a.b"], [key]() { return 1; }',
    "__proto__: other",
  ]) {
    const parsed = await read(`{ ${declaration} }`, `${preface} const other = { on: ["c.d"] };`);
    expect({ declaration, parsed }).toMatchObject({ parsed: { bad: { message: expect.stringContaining("on ") } } });
  }
  expect(await read('{ get on() { return ["c.d"]; }, on: ["a.b"] }')).toMatchObject({ subscriptions: [{ type: "a.b" }] });
  // An accessor under another name decides nothing about `on`, and an own key before `__proto__` wins over it.
  expect(await read('{ on: ["a.b"], get name() { return "x"; }, run() {} }')).toMatchObject({ subscriptions: [{ type: "a.b" }] });
  expect(await read('{ on: ["a.b"], __proto__: {} }')).toMatchObject({ subscriptions: [{ type: "a.b" }] });
});

test("a key of the declaration reads as absent, a value or unsettled, and what may replace it is never its value", async () => {
  const ts = (await import("typescript")).default;
  const field = (declaration: string, name: string) =>
    declarationField(ts, ts.createSourceFile("s.ts", `const base = {};\nexport default workflow(${declaration}, async () => {});`, ts.ScriptTarget.ESNext, true), name);
  expect(field("{ description: 'x' }", "uses")).toBeUndefined();
  expect(field("{ uses: ['a'] }", "uses")).toHaveProperty("value");
  expect(field("{ ...base }", "uses")).toHaveProperty("unsettled");
  expect(field("{ uses: ['a'], ...base }", "uses")).toHaveProperty("unsettled");
  // A spread of a literal list is not the list the script wrote.
  expect(field("{ ...['x'] }", "uses")).toHaveProperty("unsettled");
  expect(field("{ ...base, uses: ['a'] }", "uses")).toHaveProperty("value");
  expect(field("{ get uses() { return []; } }", "uses")).toHaveProperty("unsettled");
});
