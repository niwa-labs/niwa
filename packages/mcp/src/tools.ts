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
}

/**
 * One tool per declared action, with the action's input schema exactly as `describe()` says.
 *
 * Without a visible list the catalog holds every action tool. With one it holds only what the
 * list names: the actions by their action name ("session.send"). A session that was given
 * nothing sees nothing.
 *
 * @throws when two actions get the same tool name.
 */
export function catalogOf(description: Description, visible?: readonly string[]): Catalog {
  const taken = new Set<string>();
  const declared: Array<{ tool: Tool; action: ActionName }> = [];
  for (const action of description.actions) {
    const name = toolNameOf(action.name);
    if (taken.has(name)) {
      throw new Error(`the action "${action.name}" would make the tool "${name}", which is already taken`);
    }
    taken.add(name);
    declared.push({
      tool: {
        name,
        description: `${action.description}\n\nThe action is "${action.name}"; effect: ${action.effect}; recovery: ${action.recovery}.`,
        inputSchema: action.input,
        annotations: hintsOf(action),
      },
      action: action.name,
    });
  }

  if (visible === undefined) {
    return {
      tools: declared.map((entry) => entry.tool),
      actions: new Map(declared.map((entry) => [entry.tool.name, entry.action])),
    };
  }

  const allowed = new Set(visible);
  const kept = declared.filter((entry) => allowed.has(entry.action));
  return {
    tools: kept.map((entry) => entry.tool),
    actions: new Map(kept.map((entry) => [entry.tool.name, entry.action])),
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

/** One open task the caller is responsible for: its id, what it is, and the schema its result must fit. */
export interface AssignedTask {
  readonly task: string;
  readonly description: string;
  readonly result: JsonSchema;
}

/**
 * The tool that finishes a task, with the exact schema of the results the caller owes.
 *
 * `task` is one of the ids of the open tasks the caller is responsible for that declared a result
 * schema, and `result` is the schema of that result — of the one task, or any of them when there
 * are several. With no such task the tool is as the action declares it.
 */
export function withAssignedTasks(tool: Tool, tasks: readonly AssignedTask[]): Tool {
  const shown = withChoices(
    tool,
    tasks.map((task) => ({ id: task.task, schema: task.result })),
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
      ...(Object.keys(defs).length === 0
        ? {}
        : { $defs: { ...rootDefs, ...defs } }),
    },
  };
}

/** The members of a JSON object; nothing when the value is anything else. */
function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * A schema as it is written under `at` in the tool: its own root is `at`, and its definitions are
 * moved to `defs` under names that start with `prefix`, so definitions of two schemas do not meet.
 */
function placeSchema(schema: JsonSchema, at: string, prefix: string, defs: Record<string, JsonValue>): JsonValue {
  const { $defs, ...rest } = schema;
  if (typeof $defs === "object" && $defs !== null) {
    for (const [name, definition] of Object.entries($defs)) defs[`${prefix}${name}`] = rebase(definition, at, prefix);
  }
  return rebase(rest, at, prefix);
}

const DEFS = "#/$defs/";

/** The references of a schema, pointed at where its root and its definitions now are. */
function rebase(node: JsonValue, at: string, prefix: string): JsonValue {
  if (Array.isArray(node)) return node.map((item) => rebase(item, at, prefix));
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out[key] = value === "#" ? at : value.startsWith(DEFS) ? `${DEFS}${prefix}${value.slice(DEFS.length)}` : value;
    } else {
      out[key] = rebase(value, at, prefix);
    }
  }
  return out;
}
