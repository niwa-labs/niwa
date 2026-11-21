/**
 * What a script declares: its `workflow({ description, input, output, ... }, fn)`
 * call, read by loading the module in a disposable process in the `describe` mode of the child (`child.ts`).
 *
 * The module's top level runs there, so its imports work and the schemas are the real zod schemas; the
 * names of niwa are stubs that throw, and the function of the script is never called. The schemas come
 * back as JSON Schema, zod's own.
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { z } from "zod";

import { PROTOCOL_PREFIX, SCRIPT_TYPES, WorkflowPhases } from "./language.ts";
import { ContractHash, JsonSchemaValue } from "./records.ts";
import { spawnScriptChild } from "./runner.ts";
import type { ScriptBox } from "./runner.ts";

/** How long a module may take to be read: a top level that never ends is not a script. */
const DESCRIBE_MS = 30_000;

/** One schema of a declaration: its JSON Schema, or what stops it from being one. */
const Declaration = z.union([z.object({ schema: JsonSchemaValue }), z.object({ problem: z.string() })]);

/** The records of `emits`: each with its schema or its problem, or what stops the list from being one. */
const EmitsDeclaration = z.union([z.array(z.intersection(z.object({ name: z.string().min(1) }), Declaration)), z.object({ problem: z.string() })]);

const Message = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("described"),
    name: z.string().optional(),
    description: z.string().optional(),
    input: Declaration.optional(),
    output: Declaration.optional(),
    emits: EmitsDeclaration.optional(),
    phases: z.union([z.object({ phases: WorkflowPhases }), z.object({ problem: z.string() })]).optional(),
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);

/** A record a script declares in `emits`: its short name, and the JSON Schema of its data. */
export interface DeclaredEmit {
  name: string;
  schema: JsonSchemaValue;
}

/** What a script declares: the schemas that are valid JSON Schema, and the problems of those that are not. */
export interface Described {
  /** The `name` of the script, when it is text: its records are `wf.<name>.<record>`. */
  name?: string;
  description?: string;
  input?: JsonSchemaValue;
  output?: JsonSchemaValue;
  /** The records the script may emit; absent when it declares no `emits`. */
  emits?: DeclaredEmit[];
  /** The phases the script declares, in order; absent when it declares none. */
  phases?: WorkflowPhases;
  /** What stops a declared schema (or the phases) from being what it must be, by the key of the declaration. */
  problems: Array<{ key: "input" | "output" | "emits" | "phases"; message: string }>;
}

/** The module could not be read: what it threw, or what it did not do. */
export type DescribeResult = { described: Described } | { failed: string };

async function textOf(stream: Readable): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  return text + decoder.decode();
}

/**
 * Read what a script declares, in a process of its own, boxed when the runs of the script are.
 * Every call starts a process: what is asked more than once for a version of the script is asked of `describe-cache.ts`.
 */
export async function describeScript(file: string, box?: ScriptBox, run = "describe"): Promise<DescribeResult> {
  const child = await spawnScriptChild("describe", file, [], run, box);
  child.stdin.on("error", () => undefined);
  child.stdin.end();
  const stderr = textOf(child.stderr);
  const timer = setTimeout(() => child.kill(), DESCRIBE_MS);
  let said: z.infer<typeof Message> | undefined;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        // A line the module wrote itself is not the child's answer.
        if (line.startsWith(PROTOCOL_PREFIX)) said = Message.parse(JSON.parse(line.slice(PROTOCOL_PREFIX.length)));
      }
    }
    const reason = (await stderr).trim();
    if (said === undefined) return { failed: reason !== "" ? reason : "the module ended without saying what it declares" };
    if (said.kind === "failed") return { failed: said.error };
    const problems: Described["problems"] = [];
    const schemaOf = (key: "input" | "output", declared: z.infer<typeof Declaration> | undefined): JsonSchemaValue | undefined => {
      if (declared === undefined) return undefined;
      if ("problem" in declared) {
        problems.push({ key, message: declared.problem });
        return undefined;
      }
      return declared.schema;
    };
    const input = schemaOf("input", said.input);
    const output = schemaOf("output", said.output);
    const emits = said.emits === undefined ? undefined : emitsOf(said.emits, problems);
    if (said.phases !== undefined && "problem" in said.phases) problems.push({ key: "phases", message: said.phases.problem });
    const phases = said.phases !== undefined && "phases" in said.phases ? said.phases.phases : undefined;
    return {
      described: {
        ...(said.name === undefined ? {} : { name: said.name }),
        ...(said.description === undefined ? {} : { description: said.description }),
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(emits === undefined ? {} : { emits }),
        ...(phases === undefined ? {} : { phases }),
        problems,
      },
    };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** The records of `emits` whose schema is JSON Schema; the others are problems. */
function emitsOf(declared: z.infer<typeof EmitsDeclaration>, problems: Described["problems"]): DeclaredEmit[] {
  if ("problem" in declared) {
    problems.push({ key: "emits", message: declared.problem });
    return [];
  }
  const emits: DeclaredEmit[] = [];
  for (const one of declared) {
    if ("problem" in one) problems.push({ key: "emits", message: one.problem });
    else emits.push({ name: one.name, schema: one.schema });
  }
  return emits;
}

/**
 * The record types a script writes, by their full name `wf.<name>.<record>`, with the JSON Schema of their data.
 * A script with no `name` writes none: its records would have no prefix of their own.
 */
export function emittedTypesOf(read: DescribeResult): Array<{ record: string; type: string; schema: JsonSchemaValue }> {
  if (!("described" in read) || read.described.name === undefined) return [];
  const prefix = `${SCRIPT_TYPES}${read.described.name}.`;
  return (read.described.emits ?? []).map((one) => ({ record: one.name, type: `${prefix}${one.name}`, schema: one.schema }));
}

/** The text of a value with its keys in order: two schemas that say the same thing give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The hash of a contract: the two schemas of a script, as JSON Schema, and the records it emits when it declares any.
 * An absent schema is a part of the contract too.
 */
export function contractOf(declared: Pick<Described, "input" | "output" | "emits">): ContractHash {
  const parts: unknown[] = [declared.input ?? null, declared.output ?? null];
  if (declared.emits !== undefined && declared.emits.length > 0) parts.push(declared.emits);
  return ContractHash.parse(createHash("sha256").update(canonical(parts)).digest("hex"));
}
