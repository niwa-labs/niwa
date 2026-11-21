/**
 * Generates the zod types of one snapshot of the Agent Client Protocol from the JSON Schema the
 * `@agentclientprotocol/sdk` package ships (`schema/schema.json`).
 *
 *   bun scripts/gen-acp.ts <path to schema.json> <sdk version> <output .ts file>
 *
 * The snapshots in src/generated/ and the SDK versions their schemas come from:
 *   0.14.1 — the version @zed-industries/claude-code-acp 0.16.2 pins
 *   1.3.0  — the version the MiniMax Code fork pins; the upstream @minimax-ai/code 0.7.1 bundle serves
 *            the same method and update sets: `mcp/connect` without 1.6's `compaction_update`
 *
 * Every `$defs` entry becomes a zod schema and its output type of the same name. A variant that
 * the schema writes as `allOf: [{ $ref }]` plus its own discriminator is flattened into one object,
 * so each `oneOf` with a `discriminator` becomes a `z.discriminatedUnion`. A string definition whose
 * name ends in `Id` becomes a branded string, and a schema that allows anything becomes `z.unknown()`.
 *
 * The schema marks each request, response and notification with its method (`x-method`) and the
 * side that serves it (`x-side`). From those come the method-keyed unions of what the agent sends a
 * client (`AgentToClientRequest`, `AgentToClientNotification`) and the method tables of both
 * directions (`ClientToAgentMethods`, `AgentToClientMethods`), so a reply is typed by its method.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { jsonSchemaToZod, parseSchema } from "json-schema-to-zod";
import type { JsonSchema, JsonSchemaObject } from "json-schema-to-zod";

const [schemaPath, version, outPath] = process.argv.slice(2);
if (schemaPath === undefined || version === undefined || outPath === undefined) {
  throw new Error("usage: bun scripts/gen-acp.ts <schema.json> <sdk version> <out.ts>");
}

const root = JSON.parse(readFileSync(schemaPath, "utf8")) as { $defs: Record<string, JsonSchemaObject> };
const defs = root.$defs;
const REF = "#/$defs/";
/** The schema's mark of a field whose unreadable value reads as absent. */
const TOLERANT = "x-deserialize-default-on-error";

function refName(schema: JsonSchema): string | undefined {
  if (typeof schema !== "object") return undefined;
  const ref = schema["$ref"];
  return typeof ref === "string" && ref.startsWith(REF) ? ref.slice(REF.length) : undefined;
}

/** The one `$ref` of an `allOf` that holds nothing else, when it is that. */
function soleAllOfRef(schema: JsonSchemaObject): string | undefined {
  const allOf = schema.allOf;
  if (allOf === undefined || allOf.length !== 1) return undefined;
  const [only] = allOf;
  return only === undefined ? undefined : refName(only);
}

/** A plain object definition, whose properties a variant may take in. */
function plainObject(name: string): JsonSchemaObject | undefined {
  const def = defs[name];
  if (def === undefined || def.type !== "object" || def.properties === undefined) return undefined;
  if (def.oneOf !== undefined || def.anyOf !== undefined || def.allOf !== undefined) return undefined;
  return def;
}

/** The strings of a `oneOf` whose every member is one constant string: an enum, as the schema writes it. */
function constsOf(schema: JsonSchemaObject): string[] | undefined {
  const members = schema.oneOf;
  if (!Array.isArray(members) || members.length === 0) return undefined;
  const literals = members.map((member) => (typeof member === "object" && typeof member.const === "string" ? member.const : undefined));
  return literals.every((literal) => literal !== undefined) ? literals.filter((literal) => literal !== undefined) : undefined;
}

function simplify(schema: JsonSchema): JsonSchema {
  if (typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(simplify);
  const out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" || key === "title" || key === "default" || key === "format") continue;
    if ((key === "properties" || key === "patternProperties") && typeof value === "object" && value !== null) {
      // A map of field names, whose keys are names, not annotations.
      out[key] = Object.fromEntries(Object.entries(value).map(([field, sub]) => [field, simplify(sub as JsonSchema)]));
      continue;
    }
    out[key] = typeof value === "object" && value !== null ? simplify(value as JsonSchema) : value;
  }
  const literals = constsOf(out);
  if (literals !== undefined) return { type: "string", enum: literals };
  const sole = soleAllOfRef(out);
  if (sole !== undefined) {
    const base = plainObject(sole);
    if (out.properties !== undefined && base !== undefined) {
      // A variant: the referenced object's fields plus its own discriminator.
      const { allOf: _allOf, ...rest } = out;
      const baseSimple = simplify(base) as JsonSchemaObject;
      return {
        ...rest,
        type: "object",
        properties: { ...baseSimple.properties, ...rest.properties },
        required: [
          ...((baseSimple.required as string[] | undefined) ?? []),
          ...((rest.required as string[] | undefined) ?? []),
        ],
      };
    }
    if (out.properties === undefined && Object.keys(out).length === 1) return { $ref: REF + sole };
  }
  return spreadShared(out);
}

/**
 * An object with fields of its own and a discriminated `oneOf` is a discriminated union whose
 * every variant also has the shared fields.
 */
function spreadShared(schema: JsonSchemaObject): JsonSchemaObject {
  const { properties, required, oneOf, discriminator, type: _type, ...rest } = schema;
  if (properties === undefined || !Array.isArray(oneOf) || discriminator === undefined) return schema;
  const shared = (required as string[] | undefined) ?? [];
  return {
    ...rest,
    discriminator,
    oneOf: oneOf.map((variant) => {
      if (typeof variant !== "object") throw new Error("a variant that is not an object");
      return {
        ...variant,
        type: "object",
        properties: { ...properties, ...variant.properties },
        required: [...shared, ...((variant.required as string[] | undefined) ?? [])],
      };
    }),
  };
}

/** The definitions a schema refers to. */
function refsOf(schema: JsonSchema, into: Set<string>): Set<string> {
  if (typeof schema !== "object") return into;
  const name = refName(schema);
  if (name !== undefined) into.add(name);
  for (const value of Object.values(schema)) {
    if (typeof value === "object" && value !== null) refsOf(value as JsonSchema, into);
  }
  return into;
}

const simplified = new Map(Object.entries(defs).map(([name, def]) => [name, simplify(def)]));

// Definitions in dependency order; a reference back into a cycle goes through `z.lazy`.
const order: string[] = [];
const state = new Map<string, "visiting" | "done">();
const lazy = new Set<string>();
function visit(name: string): void {
  const seen = state.get(name);
  if (seen === "done") return;
  if (seen === "visiting") {
    lazy.add(name);
    return;
  }
  state.set(name, "visiting");
  const schema = simplified.get(name);
  if (schema === undefined) throw new Error(`no definition ${name}`);
  for (const dep of [...refsOf(schema, new Set())].sort()) visit(dep);
  state.set(name, "done");
  order.push(name);
}
for (const name of [...simplified.keys()].sort()) visit(name);

function isBrandedId(name: string, schema: JsonSchema): boolean {
  return name.endsWith("Id") && typeof schema === "object" && schema.type === "string";
}

function emit(name: string, schema: JsonSchema): string {
  if (isBrandedId(name, schema)) return `z.string().brand<"Acp${name}">()`;
  return jsonSchemaToZod(schema, {
    zodVersion: 4,
    withoutDescribes: true,
    withoutDefaults: true,
    parserOverride: (node, refs) => {
      if (node[TOLERANT] === true) {
        // The protocol reads a value of this field it cannot read as absent, never as a failure.
        const { [TOLERANT]: _tolerant, ...strict } = node;
        return `${parseSchema(strict, refs)}.optional().catch(undefined)`;
      }
      const ref = refName(node);
      if (ref === undefined) return undefined;
      return lazy.has(ref) ? `z.lazy((): z.ZodType<${ref}> => ${ref})` : ref;
    },
  });
}

const body = order
  .map((name) => {
    const schema = simplified.get(name);
    if (schema === undefined) throw new Error(`no definition ${name}`);
    return `export const ${name} = ${emit(name, schema).replaceAll("z.any()", "z.unknown()")};\nexport type ${name} = z.output<typeof ${name}>;`;
  })
  .join("\n\n");

interface Method {
  readonly method: string;
  readonly side: string;
  readonly name: string;
}

const methods: Method[] = Object.entries(defs).flatMap(([name, def]) => {
  const method = def["x-method"];
  const side = def["x-side"];
  return typeof method === "string" && typeof side === "string" ? [{ method, side, name }] : [];
});

/** The defs of one role (`Request`, `Response`, `Notification`) the given sides serve, by method. */
function byMethod(role: string, sides: readonly string[]): Method[] {
  return methods
    .filter((entry) => entry.name.endsWith(role) && sides.includes(entry.side))
    .sort((a, b) => a.method.localeCompare(b.method));
}

function frameUnion(name: string, role: string, sides: readonly string[], id: boolean): string {
  const variants = byMethod(role, sides).map(
    (entry) =>
      `z.object({ jsonrpc: z.literal("2.0").optional(), ${id ? "id: RequestId, " : ""}method: z.literal(${JSON.stringify(entry.method)}), params: ${entry.name} })`,
  );
  return `export const ${name} = z.discriminatedUnion("method", [\n  ${variants.join(",\n  ")},\n]);\nexport type ${name} = z.output<typeof ${name}>;`;
}

function methodTable(name: string, sides: readonly string[]): string {
  const responses = new Map(byMethod("Response", sides).map((entry) => [entry.method, entry.name]));
  const rows = byMethod("Request", sides).map((entry) => {
    const result = responses.get(entry.method);
    if (result === undefined) throw new Error(`no response for ${entry.method}`);
    return `  ${JSON.stringify(entry.method)}: { readonly params: ${entry.name}; readonly result: ${result} };`;
  });
  return `export interface ${name} {\n${rows.join("\n")}\n}`;
}

const frames = [
  "/** A request the agent sends the client, by method. */",
  frameUnion("AgentToClientRequest", "Request", ["client", "both"], true),
  "/** A notification the agent sends the client, by method. */",
  frameUnion("AgentToClientNotification", "Notification", ["client", "both", "protocol"], false),
  "/** The requests a client sends the agent: params and result, by method. */",
  methodTable("ClientToAgentMethods", ["agent", "both"]),
  "/** The requests the agent sends a client: params and result, by method. */",
  methodTable("AgentToClientMethods", ["client", "both"]),
].join("\n\n");

const header = `// GENERATED by scripts/gen-acp.ts — do not edit.
// Source: @agentclientprotocol/sdk ${version}, schema/schema.json
// Command: bun scripts/gen-acp.ts ${schemaPath.replace(homedir(), "~")} ${version} ${outPath}

import { z } from "zod";

/** The version of the @agentclientprotocol/sdk package whose schema this file was generated from. */
export const ACP_SDK_VERSION = ${JSON.stringify(version)};
`;

writeFileSync(outPath, `${header}\n${body}\n\n${frames}\n`);
