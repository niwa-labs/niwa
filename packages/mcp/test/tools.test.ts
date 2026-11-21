// The MCP tool filter: a session that was given some actions sees only those.
//
// The filter lives next to the catalog, so it is checked there: the catalog of a description
// with a visible list holds only the tools that list names, and the actions it holds are the
// ones those tools call. The observation actions of the core are actions like any other, so
// they are filtered by their action name.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import type { Description } from "@niwa-labs/core";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

import { catalogOf, withAssignedTasks, withOpenQuestions } from "../src/tools.ts";
import type { Tool } from "../src/tools.ts";

/** Does a client that validates a call against the schema accept this value? */
function accepts(schema: unknown, value: unknown): boolean {
  return new AjvJsonSchemaValidator().getValidator(schema as Record<string, unknown>)(value).valid;
}

const FINISH: Tool = {
  name: "task_finish",
  description: "Finish a task.",
  inputSchema: { type: "object", properties: { task: { type: "string" }, result: {} }, required: ["task", "result"] },
};

const DESCRIPTION: Description = {
  actions: [
    {
      name: actionName("session.send"),
      description: "Sends a message into a session.",
      recovery: "do-not-repeat",
      effect: "write",
      input: { type: "object", properties: { message: { type: "string" } } },
      output: { type: "object", properties: {} },
    },
    {
      name: actionName("task.create"),
      description: "Creates a task.",
      recovery: "repeat",
      effect: "record",
      input: { type: "object", properties: { title: { type: "string" } } },
      output: { type: "object", properties: {} },
    },
    {
      name: actionName("niwa.trace"),
      description: "Everything that grew from a record.",
      recovery: "repeat",
      effect: "read",
      input: { type: "object", properties: { id: { type: "string" } } },
      output: { type: "object", properties: {} },
    },
  ],
  types: [],
};

test("without a visible list the catalog holds every action", () => {
  const catalog = catalogOf(DESCRIPTION);
  expect(catalog.tools.map((tool) => tool.name)).toEqual([
    "session_send",
    "task_create",
    "niwa_trace",
  ]);
  expect(catalog.actions.get("session_send")).toBe(actionName("session.send"));
  expect(catalog.actions.get("task_create")).toBe(actionName("task.create"));
  expect(catalog.actions.get("niwa_trace")).toBe(actionName("niwa.trace"));
});

test("a visible list keeps only the actions it names, by their action name", () => {
  const catalog = catalogOf(DESCRIPTION, ["session.send"]);
  expect(catalog.tools.map((tool) => tool.name)).toEqual(["session_send"]);
  expect(catalog.actions.get("session_send")).toBe(actionName("session.send"));
  expect(catalog.actions.has("task_create")).toBe(false);
});

test("an observation action is kept only when it is named, by its action name", () => {
  const catalog = catalogOf(DESCRIPTION, ["niwa.trace"]);
  expect(catalog.tools.map((tool) => tool.name)).toEqual(["niwa_trace"]);
  expect(catalog.actions.get("niwa_trace")).toBe(actionName("niwa.trace"));
});

test("an empty visible list leaves nothing, and an unknown name keeps nothing", () => {
  expect(catalogOf(DESCRIPTION, []).tools).toEqual([]);
  expect(catalogOf(DESCRIPTION, ["no.such.action"]).tools).toEqual([]);
});

test("a tool name is not an action name: the filter names the actions", () => {
  // The list names actions; the tool name of an action is what the tool is called.
  const catalog = catalogOf(DESCRIPTION, ["task_create"]);
  expect(catalog.tools).toEqual([]);
});

test("ans-1: references inside an answer schema keep pointing at that schema once it is under `value`", () => {
  const tool = {
    name: "submit_answer",
    description: "",
    inputSchema: { type: "object", properties: { question: { type: "string" }, value: {} } },
  };
  const tree = {
    type: "object",
    properties: { kids: { type: "array", items: { $ref: "#" } }, thing: { $ref: "#/$defs/Thing" } },
    $defs: { Thing: { type: "object", properties: { x: { type: "number" } } } },
  };
  const one = withOpenQuestions(tool, [{ request: "req_1", schema: tree }]).inputSchema as Record<string, any>;
  expect(one.properties.value.$defs).toBeUndefined();
  expect(one.properties.value.properties.kids.items).toEqual({ $ref: "#/properties/value" });
  expect(one.properties.value.properties.thing).toEqual({ $ref: "#/$defs/Thing" });
  expect(Object.keys(one.$defs)).toEqual(["Thing"]);

  // Two schemas with a definition of the same name do not meet in the root.
  const two = withOpenQuestions(tool, [
    { request: "req_1", schema: tree },
    { request: "req_2", schema: tree },
  ]).inputSchema as Record<string, any>;
  expect(Object.keys(two.$defs)).toEqual(["q0_Thing", "q1_Thing"]);
  expect(two.properties.value.anyOf[1].properties.kids.items).toEqual({ $ref: "#/properties/value/anyOf/1" });
  expect(two.properties.value.anyOf[1].properties.thing).toEqual({ $ref: "#/$defs/q1_Thing" });
});

test("the hints of a tool come from what its action declares, and an unknown one is left out", () => {
  const base = { description: "x", recovery: "repeat" as const, input: { type: "object" }, output: { type: "object" } };
  const catalog = catalogOf({
    actions: [
      { ...base, name: actionName("a.read"), effect: "read", world: "niwa" },
      { ...base, name: actionName("a.note"), effect: "record" },
      { ...base, name: actionName("a.comment"), effect: "write", world: "external", recovery: "repeat-with-key" },
      { ...base, name: actionName("a.merge"), effect: "irreversible", world: "external", recovery: "do-not-repeat" },
      { ...base, name: actionName("a.put"), effect: "write", world: "local", idempotent: true, destructive: true },
    ],
    types: [],
  });
  const hints = Object.fromEntries(catalog.tools.map((tool) => [tool.name, tool.annotations]));
  expect(hints).toEqual({
    a_read: { readOnlyHint: true, openWorldHint: false },
    a_note: { readOnlyHint: false },
    // A retry with the same key is one operation; two calls are two comments: no idempotent hint.
    a_comment: { readOnlyHint: false, openWorldHint: true },
    a_merge: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    a_put: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
  });
});

test("an action the session does not see cannot take the name of one it sees", () => {
  const base = { description: "x", recovery: "repeat" as const, effect: "read" as const, input: { type: "object" }, output: { type: "object" } };
  const description: Description = {
    actions: [
      { ...base, name: actionName("hello") },
      { ...base, name: actionName("a.b") },
      { ...base, name: actionName("a-b") },
    ],
    types: [],
  };
  expect(catalogOf(description, ["hello"]).tools.map((tool) => tool.name)).toEqual(["hello"]);
  // When both that make one name are seen, the clash is still reported.
  expect(() => catalogOf(description, ["a.b", "a-b"])).toThrow(/already taken/);
  expect(() => catalogOf(description)).toThrow(/already taken/);
});

test("a result schema keeps its meaning once it is embedded, whichever dialect writes its references", () => {
  // Draft 7: `definitions` and a pointer into the schema itself; and the same with the markers of its own document.
  const draft7 = {
    type: "object",
    properties: {
      label: { $ref: "#/definitions/Label" },
      other: { $ref: "#/properties/label" },
      kind: { default: { $ref: "#/nowhere" }, enum: ["a", "b"] },
    },
    required: ["label"],
    definitions: { Label: { type: "string", minLength: 1 } },
  };
  const named = { ...draft7, $schema: "http://json-schema.org/draft-07/schema#", $id: "https://example.test/result" };
  const modern = {
    type: "object",
    properties: { label: { $ref: "#/$defs/Label" }, children: { type: "array", items: { $ref: "#" } } },
    required: ["label"],
    $defs: { Label: { type: "string", minLength: 1 } },
  };
  const samples: unknown[] = [
    { label: "x" },
    { label: "" },
    { label: 1 },
    { label: "x", other: "y" },
    { label: "x", other: 1 },
    { label: "x", kind: "c" },
    { label: "x", children: [{ label: "y" }] },
    { label: "x", children: [{ label: 3 }] },
    {},
  ];
  for (const schema of [draft7, named, modern]) {
    const one = withAssignedTasks(FINISH, [{ task: "task-1", description: "d", result: schema }]);
    const two = withAssignedTasks(FINISH, [
      { task: "task-1", description: "d", result: schema },
      { task: "task-2", description: "e", result: modern },
    ]);
    for (const sample of samples) {
      expect(accepts(one.inputSchema, { task: "task-1", result: sample })).toBe(accepts(schema, sample));
      expect(accepts(two.inputSchema, { task: "task-1", result: sample })).toBe(accepts(schema, sample));
    }
  }
});

test("a value is held to the schema of the id it is given with", () => {
  const tool: Tool = {
    name: "submit_answer",
    description: "",
    inputSchema: { type: "object", properties: { question: { type: "string" }, value: {} }, required: ["question", "value"] },
  };
  const shown = withOpenQuestions(tool, [
    { request: "req_text", schema: { type: "string" } },
    { request: "req_count", schema: { type: "integer" } },
    { request: "req_flag", schema: { type: "boolean" } },
  ]).inputSchema;
  const given = (question: string, value: unknown) => accepts(shown, { question, value });
  expect(given("req_text", "yes")).toBe(true);
  expect(given("req_count", 12)).toBe(true);
  expect(given("req_flag", false)).toBe(true);
  // The value of another question is not an answer to this one.
  expect(given("req_text", 12)).toBe(false);
  expect(given("req_count", "yes")).toBe(false);
  expect(given("req_flag", 12)).toBe(false);
  // The id is still one of the open ones, and both fields are still required.
  expect(given("req_other", "yes")).toBe(false);
  expect(accepts(shown, { question: "req_text" })).toBe(false);
  // No combinator at the root, which some model APIs refuse.
  for (const keyword of ["anyOf", "oneOf", "allOf"]) expect(Object.keys(shown)).not.toContain(keyword);
});

test("the schemas of several choices keep their own references and definitions", () => {
  const tool: Tool = {
    name: "task_finish",
    description: "",
    inputSchema: { type: "object", properties: { task: { type: "string" }, result: {} }, required: ["task", "result"] },
  };
  const tree = {
    type: "object",
    properties: { kids: { type: "array", items: { $ref: "#" } }, thing: { $ref: "#/$defs/Thing" } },
    $defs: { Thing: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
  };
  const loose = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  const shown = withAssignedTasks(tool, [
    { task: "task-1", description: "a", result: tree },
    { task: "task-2", description: "b", result: loose },
  ]).inputSchema;
  expect(accepts(shown, { task: "task-1", result: { kids: [{ thing: { x: 1 } }] } })).toBe(true);
  expect(accepts(shown, { task: "task-1", result: { kids: [{ thing: { x: "no" } }] } })).toBe(false);
  expect(accepts(shown, { task: "task-1", result: { label: "x" } })).toBe(true);
  expect(accepts(shown, { task: "task-2", result: { label: "x" } })).toBe(true);
  expect(accepts(shown, { task: "task-2", result: { label: 1 } })).toBe(false);
  expect(accepts(shown, { task: "task-2", result: {} })).toBe(false);
});
