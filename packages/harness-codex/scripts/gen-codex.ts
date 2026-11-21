/**
 * Generates `src/protocol/generated/app-server.ts`: the zod schemas and types of
 * what `codex app-server` sends to its client, from the JSON Schema of the installed codex.
 *
 *   bun scripts/gen-codex.ts
 *
 * The schema is read with `codex app-server generate-json-schema --out <dir>`, the stable surface
 * (no `--experimental`): this is the surface a client that does not opt into experimental methods
 * is served. Nothing generated is edited by hand; a new codex is one more run of this script.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchemaToZod } from "json-schema-to-zod";
import type { JsonSchema, JsonSchemaObject, ParserOverride } from "json-schema-to-zod";

const OUTPUT = new URL("../src/protocol/generated/app-server.ts", import.meta.url);

/**
 * The roots of what niwa reads or writes: what the server notifies and requests, the replies a
 * client gives to those requests, and the JSON-RPC envelope that carries them. Each file brings
 * the definitions it refers to.
 */
const ROOTS = [
  "JSONRPCMessage.json",
  "ServerNotification.json",
  "ServerRequest.json",
  "CommandExecutionRequestApprovalResponse.json",
  "FileChangeRequestApprovalResponse.json",
  "PermissionsRequestApprovalResponse.json",
  "ToolRequestUserInputResponse.json",
  "McpServerElicitationRequestResponse.json",
  "DynamicToolCallResponse.json",
  "ApplyPatchApprovalResponse.json",
  "ExecCommandApprovalResponse.json",
] as const;

/** The widest line of the generated file before a call is broken over several. */
const WIDTH = 110;

const DEFINITION_REF = /^#\/definitions\/([A-Za-z_][A-Za-z0-9_]*)$/;

function isObject(schema: JsonSchema | undefined): schema is JsonSchemaObject {
  return typeof schema === "object";
}

/** The name of the zod schema a definition is generated as. */
function schemaName(definition: string): string {
  return `${definition}Schema`;
}

/** The definition a `$ref` names. */
function refTarget(ref: string): string {
  const match = DEFINITION_REF.exec(ref);
  if (match?.[1] === undefined) throw new Error(`a reference this generator does not read: ${ref}`);
  return match[1];
}

// -- the schema, shaped for json-schema-to-zod --------------------------------

/**
 * The property of a union that tells its variants apart: present in every variant as a string with
 * one value, required, and with a different value in each variant. Zod refuses a discriminated
 * union that has the same value twice, so a union that cannot say it is left a plain union.
 */
function discriminatorOf(branches: readonly JsonSchemaObject[]): string | undefined {
  const [first] = branches;
  if (first?.properties === undefined) return undefined;
  for (const property of Object.keys(first.properties)) {
    const values = new Set<unknown>();
    const tells = branches.every((branch) => {
      const schema = branch.properties?.[property];
      const only = isObject(schema) && schema.type === "string" && schema.enum?.length === 1 ? schema.enum[0] : undefined;
      if (only === undefined || !Array.isArray(branch.required) || !branch.required.includes(property)) return false;
      values.add(only);
      return true;
    });
    if (tells && values.size === branches.length) return property;
  }
  return undefined;
}

/**
 * The schema as the converter reads it. Objects are open, so a field a newer codex adds does not
 * fail a message. A `oneOf` that carries properties of its own gives them to every variant. A
 * `oneOf` is a discriminated union when its variants can be told apart by one property, and a
 * plain union otherwise.
 */
function shaped(schema: JsonSchema): JsonSchema {
  if (schema === true) return {};
  if (!isObject(schema)) return schema;
  const out: JsonSchemaObject = { ...schema };
  if (out.additionalProperties === false) delete out.additionalProperties;
  else if (isObject(out.additionalProperties)) out.additionalProperties = shaped(out.additionalProperties);
  if (out.properties !== undefined) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, shaped(value)]));
  }
  if (Array.isArray(out.items)) out.items = out.items.map(shaped);
  else if (out.items !== undefined) out.items = shaped(out.items);
  // An object that must have one of several sets of fields reads as having all of them, each optional.
  if (out.type === "object" && Array.isArray(out.anyOf) && out.anyOf.every((branch) => isObject(branch) && branch.type === "object")) {
    const alternatives = out.anyOf.filter(isObject).flatMap((branch) => Object.entries(branch.properties ?? {}));
    out.properties = { ...out.properties, ...Object.fromEntries(alternatives.map(([key, value]) => [key, shaped(value)])) };
    delete out.anyOf;
  }
  for (const key of ["anyOf", "allOf"] as const) {
    const branches = out[key];
    if (Array.isArray(branches)) out[key] = branches.map(shaped);
  }
  if (!Array.isArray(out.oneOf)) return out;

  const shared = out.properties ?? {};
  const sharedRequired = Array.isArray(out.required) ? out.required : [];
  const branches = out.oneOf.map((branch) => {
    const given = shaped(branch);
    if (Object.keys(shared).length === 0 && sharedRequired.length === 0) return given;
    if (!isObject(given) || given.type !== "object") throw new Error("a oneOf with properties of its own has a variant that is not an object");
    return {
      ...given,
      properties: { ...shared, ...given.properties },
      required: [...new Set([...(Array.isArray(given.required) ? given.required : []), ...sharedRequired])],
    };
  });
  delete out.oneOf;
  delete out.properties;
  delete out.required;
  delete out.type;
  const objects = branches.filter(isObject);
  const discriminator = objects.length === branches.length && objects.every((branch) => branch.type === "object") ? discriminatorOf(objects) : undefined;
  if (discriminator === undefined) out.anyOf = branches;
  else {
    out.oneOf = branches;
    out.discriminator = { propertyName: discriminator };
  }
  return out;
}

/** The definitions a schema refers to. */
function refsOf(schema: unknown, found: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) refsOf(item, found);
  } else if (typeof schema === "object" && schema !== null) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string") found.add(refTarget(value));
      else refsOf(value, found);
    }
  }
}

/** A schema that says nothing about the shape of its value: any JSON. */
function sayingNothing(schema: JsonSchemaObject): boolean {
  const KEYS = ["type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const", "not", "properties", "items"];
  return KEYS.every((key) => schema[key] === undefined);
}

const parserOverride: ParserOverride = (schema) => {
  if (typeof schema.$ref === "string") return schemaName(refTarget(schema.$ref));
  if (sayingNothing(schema)) return "z.json()";
};

// -- the definitions ------------------------------------------------------------

type Definitions = Map<string, JsonSchema>;

/** The definitions of every root, each under its name; a name given twice must mean the same. */
async function readDefinitions(dir: string): Promise<Definitions> {
  const all: Definitions = new Map();
  const add = (name: string, schema: JsonSchema, from: string): void => {
    const known = all.get(name);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(schema)) {
      throw new Error(`${name} is defined twice, differently (the second time in ${from})`);
    }
    all.set(name, schema);
  };
  for (const file of ROOTS) {
    const root = JSON.parse(await readFile(join(dir, file), "utf8")) as JsonSchemaObject;
    const { definitions, $schema: _schema, ...self } = root;
    if (typeof self.title !== "string") throw new Error(`${file} has no title to name it by`);
    for (const [name, schema] of Object.entries((definitions ?? {}) as Record<string, JsonSchema>)) add(name, schema, file);
    add(self.title, self, file);
  }
  return all;
}

/** The definitions in an order in which each comes after the ones it refers to. */
function inOrder(all: Definitions): string[] {
  const order: string[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, via: readonly string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") throw new Error(`the definitions refer to each other in a circle: ${[...via, name].join(" -> ")}`);
    const schema = all.get(name);
    if (schema === undefined) throw new Error(`${via.at(-1) ?? "a root"} refers to ${name}, which is not defined`);
    state.set(name, "open");
    const needs = new Set<string>();
    refsOf(schema, needs);
    for (const need of [...needs].sort()) visit(need, [...via, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of [...all.keys()].sort()) visit(name, []);
  return order;
}

// -- the layout ------------------------------------------------------------------

type Part = string | Group;
interface Group {
  readonly open: string;
  readonly close: string;
  readonly args: Part[][];
}

const CLOSER: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/** The expression as text and groups: what is between brackets is split at its top-level commas. */
function partsOf(expression: string): Part[] {
  let at = 0;
  const sequence = (closer: string | undefined): Part[][] => {
    const args: Part[][] = [[]];
    let text = "";
    const flush = (): void => {
      if (text !== "") args[args.length - 1]?.push(text);
      text = "";
    };
    while (at < expression.length) {
      const char = expression.charAt(at);
      if (char === closer) {
        flush();
        at += 1;
        return args;
      }
      if (char === '"') {
        const start = at;
        at += 1;
        while (expression.charAt(at) !== '"') at += expression.charAt(at) === "\\" ? 2 : 1;
        at += 1;
        text += expression.slice(start, at);
      } else if (CLOSER[char] !== undefined) {
        flush();
        at += 1;
        const close = CLOSER[char];
        args[args.length - 1]?.push({ open: char, close, args: sequence(close) });
      } else if (char === ",") {
        flush();
        at += 1;
        args.push([]);
      } else {
        text += char;
        at += 1;
      }
    }
    flush();
    return args;
  };
  return sequence(undefined)[0] ?? [];
}

function flat(parts: readonly Part[]): string {
  return parts.map((part) => (typeof part === "string" ? part : flatGroup(part))).join("");
}

function flatGroup(group: Group): string {
  const inside = group.args
    .map((arg) => flat(arg).trim())
    .filter((arg) => arg !== "")
    .join(", ");
  if (inside === "") return `${group.open}${group.close}`;
  return group.open === "{" ? `{ ${inside} }` : `${group.open}${inside}${group.close}`;
}

/** Lays an expression out: a group that does not fit on its line is broken, one argument to a line. */
function layout(parts: readonly Part[], indent: number, startColumn: number): string {
  let out = "";
  const column = (): number => (out.includes("\n") ? out.length - out.lastIndexOf("\n") - 1 : startColumn + out.length);
  for (const part of parts) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    const inline = flatGroup(part);
    if (column() + inline.length <= WIDTH) {
      out += inline;
      continue;
    }
    const args = part.args
      .map((arg) => arg.filter((piece) => typeof piece !== "string" || piece.trim() !== ""))
      .filter((arg) => arg.length > 0);
    const last = args.at(-1);
    if (last?.length === 1 && typeof last[0] === "object") {
      // `z.object({ ... })` and `z.union([ ... ])`: the last argument opens on the line of the call.
      const head = args.slice(0, -1).map((arg) => `${flat(arg).trim()}, `);
      out += part.open + head.join("") + layout(last, indent, column() + 1 + head.join("").length) + part.close;
      continue;
    }
    out += `${part.open}\n`;
    for (const arg of args) {
      const trimmed = arg.map((piece, index) => {
        if (typeof piece !== "string") return piece;
        const start = index === 0 ? piece.trimStart() : piece;
        return index === arg.length - 1 ? start.trimEnd() : start;
      });
      out += `${" ".repeat(indent + 2)}${layout(trimmed, indent + 2, indent + 2)},\n`;
    }
    out += `${" ".repeat(indent)}${part.close}`;
  }
  return out;
}

// -- the file --------------------------------------------------------------------

function codexVersion(): string {
  const run = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`codex --version failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function main(): Promise<void> {
  const version = codexVersion();
  const dir = await mkdtemp(join(tmpdir(), "codex-schema-"));
  try {
    const run = spawnSync("codex", ["app-server", "generate-json-schema", "--out", dir], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`codex app-server generate-json-schema failed: ${run.stderr}`);
    const all = await readDefinitions(dir);
    const blocks = inOrder(all).map((name) => {
      const schema = all.get(name);
      if (schema === undefined) throw new Error(`${name} vanished`);
      const expression = jsonSchemaToZod(shaped(schema), { module: "none", zodVersion: 4, withoutDescribes: true, parserOverride });
      return `export const ${schemaName(name)} = ${layout(partsOf(expression), 0, `export const ${schemaName(name)} = `.length)};\nexport type ${name} = z.infer<typeof ${schemaName(name)}>;\n`;
    });
    const header = [
      "/**",
      " * The messages of `codex app-server`, as zod schemas and types.",
      " *",
      ` * GENERATED by scripts/gen-codex.ts from ${version}. Do not edit: run \`bun scripts/gen-codex.ts\`.`,
      " * Command: codex app-server generate-json-schema --out <dir>   (the stable surface, no --experimental)",
      " * Objects are open: a field a newer codex adds does not fail a message. Descriptions are in the upstream schema.",
      " */",
      "",
      'import { z } from "zod";',
      "",
    ];
    await writeFile(OUTPUT, `${header.join("\n")}\n${blocks.join("\n")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
