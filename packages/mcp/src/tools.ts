/**
 * tools.ts — the tools, generated from the list of actions.
 *
 * Nothing is kept here: the tools are built from what `describe()` says, each time they are
 * asked for, so a plugin that declares an action makes a tool on the next `tools/list`.
 * The observation actions of the core are actions like any other, so they are tools too.
 * A tool never carries the caller: the caller is the MCP session.
 */

import { toolNameOf } from "@niwa-labs/core";
import type { JsonValue, ActionDescription, ActionName, Description, JsonSchema } from "@niwa-labs/core";

/** What a tool tells its client about its effect: only what the action declares. */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One MCP tool. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolHints;
}

/**
 * The hints of an action's tool. Read-only comes from the effect, the open world from the world,
 * destructive is always set for an irreversible action and otherwise only when the action says,
 * and idempotent only when the action says: the recovery contract is about one call cut off and
 * repeated, not about two calls. A hint the action does not settle is left out.
 */
export function hintsOf(action: ActionDescription): ToolHints {
  const destructive = action.effect === "irreversible" ? true : action.destructive;
  return {
    readOnlyHint: action.effect === "read",
    ...(action.world === undefined ? {} : { openWorldHint: action.world === "external" }),
    ...(destructive === undefined ? {} : { destructiveHint: destructive }),
    ...(action.idempotent === undefined ? {} : { idempotentHint: action.idempotent }),
  };
}

/** The action tools, each with the action it calls. */
export interface Catalog {
  tools: Tool[];
  actions: Map<string, ActionName>;
  /** The tools whose action takes something other than an object: the argument `input` holds it. */
  wrapped: Set<string>;
}

/** The argument that holds the input of an action that does not take an object. */
export const WRAPPED_INPUT = "input";

/**
 * The input schema of an action as its tool takes it: always an object, because the arguments of a
 * tool are. An action that takes a string, a number or a list gets an object with one argument,
 * `input`, which holds it; the call unwraps it again, so the schema the tool shows is the one it runs.
 */
function toolInputOf(schema: JsonSchema): { schema: JsonSchema; wrapped: boolean } {
  if (schema.type === undefined || schema.type === "object") return { schema: { ...schema, type: "object" }, wrapped: false };
  const defs: Record<string, JsonValue> = {};
  const placed = placeSchema(schema, `#/properties/${WRAPPED_INPUT}`, "", defs);
  return {
    schema: {
      type: "object",
      properties: { [WRAPPED_INPUT]: placed },
      required: [WRAPPED_INPUT],
      ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
    },
    wrapped: true,
  };
}

/**
 * One tool per declared action, with the action's input schema exactly as `describe()` says.
 *
 * Without a visible list the catalog holds every action tool. With one it holds only what the
 * list names: the actions by their action name ("session.send"). A session that was given
 * nothing sees nothing.
 *
 * @throws when two of the actions the session sees get the same tool name.
 */
export function catalogOf(description: Description, visible?: readonly string[]): Catalog {
  // Only what the session may see takes a name: an action it cannot see never collides with one it can.
  const allowed = visible === undefined ? undefined : new Set(visible);
  const taken = new Set<string>();
  const declared: Array<{ tool: Tool; action: ActionName; wrapped: boolean }> = [];
  for (const action of description.actions) {
    if (allowed !== undefined && !allowed.has(action.name)) continue;
    const name = toolNameOf(action.name);
    if (taken.has(name)) {
      throw new Error(`the action "${action.name}" would make the tool "${name}", which is already taken`);
    }
    taken.add(name);
    const input = toolInputOf(action.input);
    const note = input.wrapped ? `\n\nThe input of the action is not an object: give it as the argument "${WRAPPED_INPUT}".` : "";
    declared.push({
      tool: {
        name,
        description: `${action.description}\n\nThe action is "${action.name}"; effect: ${action.effect}; recovery: ${action.recovery}.${note}`,
        inputSchema: input.schema,
        annotations: hintsOf(action),
      },
      action: action.name,
      wrapped: input.wrapped,
    });
  }
  return {
    tools: declared.map((entry) => entry.tool),
    actions: new Map(declared.map((entry) => [entry.tool.name, entry.action])),
    wrapped: new Set(declared.filter((entry) => entry.wrapped).map((entry) => entry.tool.name)),
  };
}

/** The action a session answers a question with, and the action that lists its open questions. */
export const SUBMIT_ANSWER = "submit-answer";
export const OPEN_QUESTIONS = "session.open-questions";

/** One open question of the session the server serves: the request, and its answer schema. */
export interface OpenQuestion {
  readonly request: string;
  readonly schema: JsonSchema;
}

/**
 * The tool that answers a question, with the exact schema of the questions that are open.
 *
 * `question` is one of the ids of the open requests, and `value` is the schema of the answer —
 * of the one question, or any of them when there are several. A tool layer that reads the
 * schema then passes a number as a number, not as text. With no open question the tool is as
 * the action declares it.
 */
export function withOpenQuestions(tool: Tool, questions: readonly OpenQuestion[]): Tool {
  return withChoices(
    tool,
    questions.map((question) => ({ id: question.request, schema: question.schema })),
    {
      key: "question",
      keyDescription: "The id of the request the question is, as it was given with the question.",
      value: "value",
      prefix: "q",
    },
  );
}

/** The action a task is finished with, and the action that lists the tasks the caller finishes. */
export const TASK_FINISH = "task.finish";
export const TASK_ASSIGNED = "task.assigned";

/** One open task the caller is responsible for: its id, what it is, and the schema its result must fit, when it has one. */
export interface AssignedTask {
  readonly task: string;
  readonly description: string;
  readonly result?: JsonSchema;
}

/**
 * The tool that finishes a task, with the exact schema of the results the caller owes.
 *
 * `task` is one of the ids of the open tasks the caller is responsible for, and `result` is the schema
 * of that result — of the one task, or any of them when there are several; a task that declared no
 * schema takes any result. With no open task the tool is as the action declares it.
 */
export function withAssignedTasks(tool: Tool, tasks: readonly AssignedTask[]): Tool {
  const shown = withChoices(
    tool,
    tasks.map((task) => ({ id: task.task, schema: task.result ?? {} })),
    {
      key: "task",
      keyDescription: "The id of the task you finish, as it was given with the assignment.",
      value: "result",
      prefix: "t",
    },
  );
  if (shown === tool) return tool;
  const owed = tasks.map((task) => `${task.task} (${task.description})`).join(", ");
  return { ...shown, description: `${tool.description}\n\nTasks you owe a result for: ${owed}.` };
}

/** One thing a tool is made to take exactly: its id, and the schema of the value given with it. */
interface Choice {
  readonly id: string;
  readonly schema: JsonSchema;
}

/** How a tool names the choice and the value, and what keeps the definitions of several schemas apart. */
interface ChoiceFields {
  readonly key: string;
  readonly keyDescription: string;
  readonly value: string;
  readonly prefix: string;
}

/**
 * The tool, with `key` one of the ids of the choices and `value` the schema of the one choice, or any
 * of them when there are several. A tool layer that reads the schema then passes a number as a
 * number, not as text. With no choice the tool is returned as it is.
 *
 * With several choices the value is also bound to its id: the schemas of the choices are listed
 * once under `value`, and a chain of `if`/`then`/`else` at the root of the tool picks the one the
 * id names. A combinator such as `anyOf` at the root is refused by some model APIs, a conditional is not.
 */
function withChoices(tool: Tool, choices: readonly Choice[], fields: ChoiceFields): Tool {
  const [first] = choices;
  if (first === undefined) return tool;
  const properties = objectOf(tool.inputSchema.properties);
  // A schema that refers to itself or to its definitions (`$ref: "#"`, `#/$defs/...`) points at the
  // root of what it was written as: under the value the root is the tool, so the references are
  // moved with it and the definitions go to the root of the tool.
  const defs: Record<string, JsonValue> = {};
  const one = choices.length === 1;
  const place = `#/properties/${fields.value}`;
  const placed = choices.map((choice, at) =>
    placeSchema(choice.schema, one ? place : `${place}/anyOf/${at}`, one ? "" : `${fields.prefix}${at}_`, defs),
  );
  const rootDefs = objectOf(tool.inputSchema.$defs);
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        [fields.key]: {
          type: "string",
          enum: choices.map((choice) => choice.id),
          description: fields.keyDescription,
        },
        [fields.value]: one ? (placed[0] ?? null) : { anyOf: placed },
      },
      required: [fields.key, fields.value],
      ...(one ? {} : bound(choices, fields, place)),
      ...(Object.keys(defs).length === 0
        ? {}
        : { $defs: { ...rootDefs, ...defs } }),
    },
  };
}

/**
 * The root of a tool that holds each value to the schema of its id: for the id of the first choice the
 * value is its schema, else for the id of the next one, and so on. The last choice needs no test of its
 * own, because the ids are the only ones the key takes.
 */
function bound(choices: readonly Choice[], fields: ChoiceFields, place: string): Record<string, JsonValue> {
  const schemaOf = (at: number): JsonValue => ({ properties: { [fields.value]: { $ref: `${place}/anyOf/${at}` } } });
  let chain = schemaOf(choices.length - 1);
  for (let at = choices.length - 2; at >= 0; at -= 1) {
    chain = {
      if: { properties: { [fields.key]: { const: choices[at]?.id ?? null } }, required: [fields.key] },
      then: schemaOf(at),
      else: chain,
    };
  }
  return objectOf(chain);
}

/** The members of a JSON object; nothing when the value is anything else. */
function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * A schema as it is written under `at` in the tool: its own root is `at`, and its definitions (`$defs`, or
 * `definitions` of the older dialects) are moved to `defs` under names that start with `prefix`, so
 * definitions of two schemas do not meet. What only names the schema's own document (`$schema`, `$id`)
 * stays behind: under the tool it would say something about the whole tool.
 */
function placeSchema(schema: JsonSchema, at: string, prefix: string, defs: Record<string, JsonValue>): JsonValue {
  const { $defs, definitions, $schema: _schema, $id: _id, ...rest } = schema;
  const place = { at, prefix };
  for (const [name, definition] of Object.entries(objectOf($defs))) defs[`${prefix}${name}`] = rebase(definition, place);
  for (const [name, definition] of Object.entries(objectOf(definitions))) {
    defs[`${prefix}${LEGACY_DEFS}${name}`] = rebase(definition, place);
  }
  return rebase(rest, place);
}

/** Where a schema's root and its definitions are in the tool: the root is at `at`, the definitions carry `prefix`. */
interface Placement {
  readonly at: string;
  readonly prefix: string;
}

const DEFS = "#/$defs/";
const LEGACY_DEFS_POINTER = "#/definitions/";
/** The name `definitions` take among the moved ones, so they never meet a `$defs` of the same name. */
const LEGACY_DEFS = "definitions.";

/** The keywords whose members are named schemas, not keywords: a property called `default` is a property. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

/** The keywords that hold data, not a schema: a `$ref` in them is a value. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "example"]);

/** Where a reference of a schema points once the schema is placed: its own root, its definitions, or a part of it. */
function relocate(ref: string, place: Placement): string {
  if (ref === "#") return place.at;
  if (ref.startsWith(DEFS)) return `${DEFS}${place.prefix}${ref.slice(DEFS.length)}`;
  if (ref.startsWith(LEGACY_DEFS_POINTER)) {
    return `${DEFS}${place.prefix}${LEGACY_DEFS}${ref.slice(LEGACY_DEFS_POINTER.length)}`;
  }
  // A pointer into the schema itself: the schema is at `at` now. Anything else (an anchor, another document) is left alone.
  return ref.startsWith("#/") ? `${place.at}${ref.slice(1)}` : ref;
}

/** The references of a schema, pointed at where its root and its definitions now are. */
function rebase(node: JsonValue, place: Placement): JsonValue {
  if (Array.isArray(node)) return node.map((item) => rebase(item, place));
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out[key] = relocate(value, place);
    } else if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (SCHEMA_MAPS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, member]) => [name, rebase(member, place)]));
    } else {
      out[key] = rebase(value, place);
    }
  }
  return out;
}
