// The MCP tool filter: a session that was given some actions sees only those.
//
// The filter lives next to the catalog, so it is checked there: the catalog of a description
// with a visible list holds only the tools that list names, and the actions it holds are the
// ones those tools call. The observation actions of the core are actions like any other, so
// they are filtered by their action name.

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import type { Description } from "@niwa-labs/core";

import { catalogOf, withOpenQuestions } from "../src/tools.ts";

const DESCRIPTION: Description = {
  actions: [
    {
      name: actionName("session.send"),
      description: "Sends a message into a session.",
      recovery: "do-not-repeat",
      input: { type: "object", properties: { message: { type: "string" } } },
      output: { type: "object", properties: {} },
    },
    {
      name: actionName("task.create"),
      description: "Creates a task.",
      recovery: "repeat",
      input: { type: "object", properties: { title: { type: "string" } } },
      output: { type: "object", properties: {} },
    },
    {
      name: actionName("niwa.trace"),
      description: "Everything that grew from a record.",
      recovery: "repeat",
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
