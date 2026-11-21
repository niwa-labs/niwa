// The header of a script, read from its text: `on` is what starts it, and where the text does not say, the
// reader says so instead of naming a trigger the script may not have.

import { expect, test } from "bun:test";

import { scriptOn } from "../src/index.ts";

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
