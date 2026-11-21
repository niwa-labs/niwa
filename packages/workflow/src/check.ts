/**
 * The check of a script: the script is type-checked against the
 * typing generated from the host's actions, and what it declares is read.
 *
 * The script is `export default workflow({ description, input, output, uses, on }, fn)`. `uses` is
 * the actions it calls, as names or masks (`task.*`): the typing of a check holds only those, so a
 * call outside `uses` is an error of the type checker, with the place in the file. `name`, `uses`
 * and `on` are read from the text of the declaration, as literals, so the rights of a run are known
 * without running anything; the schemas (`input`, `output`) are read by loading the module in a
 * disposable process (`describe.ts`). The function of the script is never run.
 *
 * The checker is the repo's `typescript`, loaded when the first script is checked. The script and
 * the generated typing are given to it from memory: the text that was hashed is the text that is
 * checked, and nothing is written to the disk.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isOwnerGrant, isRuleTemplate, narrow, rule, ruleTemplate, ruleText } from "@niwa-labs/core";
import type { ActionDescription, ActionName, Grant, JsonSchema } from "@niwa-labs/core";
import { bare, declarationField, declarationOf, literalOf, onOf, placeOf } from "@niwa-labs/script";
import type { ScriptSource } from "@niwa-labs/script";
import type * as Ts from "typescript";
import { z } from "zod";

import type { Describer } from "./describe-cache.ts";
import { contractOf, emittedTypesOf } from "./describe.ts";
import { SCRIPT_TYPES, WorkflowPhases } from "./language.ts";
import type { ScriptBox } from "./runner.ts";
import { ContractHash, JsonSchemaValue, Subscription } from "./records.ts";
import { SCRIPT_API, typeRoots } from "./installation.ts";
import { allowedFor, harnessOfAction, matches, scriptTyping } from "./script-types.ts";
import type { HarnessBlock } from "./script-types.ts";

/** What a check says: the errors it found, what the script declares, and that its function was not run. */
export interface CheckReport {
  file: string;
  ok: boolean;
  errors: CheckError[];
  /** What the check could not settle and the author should look at; absent when there is none. A warning does not fail the check. */
  warnings?: CheckError[];
  note: "described, the script was not run";
  /** What the script says it is. */
  description?: string;
  /** The JSON Schema of the input of the script; absent when it takes none, or declares the record it starts on. */
  input?: JsonSchemaValue;
  /** The JSON Schema of what the script returns; absent when it returns nothing. */
  output?: JsonSchemaValue;
  /** The records the script emits: the name it gives each, its type `wf.<name>.<record>`, and the JSON Schema of its data; absent when it declares no `emits`. */
  emits?: Array<{ record: string; type: string; schema: JsonSchemaValue }>;
  /** The phases the script declares, in order; absent when it declares none. */
  phases?: WorkflowPhases;
  /** The hash of the contract; absent when the module could not be read. */
  contract?: ContractHash;
}

/** One error, with its place in the file. */
export interface CheckError {
  file: string;
  line: number;
  column: number;
  /** The code of the type checker (`TS2339`), `workflow` for a script that is not `export default workflow({ ... }, fn)`, `uses` for a mask of `uses` that names no action or an `ask()` call on a harness `uses` does not list, `emit` for a record the script may not write, `on` for an `on` the host cannot serve, `wait` for a filter of a wait no record of its type can hold or a type it names by reference that the host does not know or writes at another version, `read` for such a type of a read, `schema` for an `input`, `output` or record of `emits` that is not a JSON Schema, `phases` for phases that are not a list of `{ title, detail? }` with titles of their own, written in the declaration, or `describe` for a module that could not be read. */
  code: string;
  message: string;
}

/** Where the generated typing lives for the checker: a name no real file has. */
const TYPING_FILE = join(fileURLToPath(new URL(".", import.meta.url)), "niwa-script.generated.ts");
const TYPE_ROOTS = typeRoots();

const CACHE_LIMIT = 64;

/**
 * The installed packages the checker reads (the libraries of the language, the types of bun and node),
 * parsed once. A check that parsed them again took most of its time over them; they are the same for
 * every script, and a program only reads a parsed file. The files of a script's own folder are read
 * again by every check: they may have been edited.
 */
const parsedFiles = new Map<string, Ts.SourceFile>();

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A name or a mask of `uses`, with the place it is written at. */
interface Use {
  mask: string;
  line: number;
  column: number;
}

/** What `uses` holds: the masks, or the place where it is not a list of text. */
export type Uses = { masks: Use[] } | { bad: { line: number; column: number } };

/**
 * The name mask of an entry of `uses`: an action name or a mask (`task.create`, `task.*`, `*`),
 * the same with a target (`forge.pr.read@git.example.com/acme/*`), or with a target template filled
 * from the input of the run (`forge.pr.merge@{repo.host}/{repo.path}/pr/*`). Undefined for anything
 * else, a rule of another verb among them.
 */
export function useName(text: string): string | undefined {
  try {
    if (isRuleTemplate(text)) ruleTemplate(text);
    const at = text.indexOf("@");
    const parsed = rule(at === -1 || isRuleTemplate(text) ? text.slice(0, at === -1 ? undefined : at) : text);
    if (parsed.verb !== "call" || text.startsWith("call:")) return undefined;
    return parsed.name;
  } catch {
    return undefined;
  }
}

/** Is the text an entry `uses` may hold? */
export function isUse(text: string): boolean {
  return useName(text) !== undefined;
}

/** The `name` of a parsed script, when it is written as text. */
function nameOf(ts: typeof Ts, source: Ts.SourceFile): string | undefined {
  const field = declarationField(ts, source, "name");
  const text = field === undefined || !("value" in field) ? undefined : bare(ts, field.value);
  return text !== undefined && (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)) ? text.text : undefined;
}

/** The calls of a function of the language in the script, by its name: `emit(...)`, `wait(...)`. */
function callsOf(ts: typeof Ts, source: Ts.SourceFile, name: string): Ts.CallExpression[] {
  const found: Ts.CallExpression[] = [];
  const visit = (node: Ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The errors of the emits of a script: it emits only what it lists in `emits`, written as it is written there, and a
 * script that lists any has a `name`, the prefix of its records.
 */
function emitErrors(ts: typeof Ts, source: Ts.SourceFile, file: string): CheckError[] {
  const errors: CheckError[] = [];
  const field = declarationField(ts, source, "emits");
  const list = field === undefined || !("value" in field) ? undefined : bare(ts, field.value);
  if (field !== undefined && "unsettled" in field) {
    errors.push({ file, ...placeOf(ts, source, field.unsettled), code: "emit", message: "emits must be a list of records written in the declaration: emits: [Blocked]; a spread or a computed key may decide it" });
  } else if (list !== undefined && field !== undefined) {
    if (!ts.isArrayLiteralExpression(list)) errors.push({ file, ...placeOf(ts, source, field.value), code: "emit", message: "emits must be a list of records written in the declaration: emits: [Blocked]" });
    else if (nameOf(ts, source) === undefined) {
      errors.push({ file, ...placeOf(ts, source, field.value), code: "emit", message: `a script that emits declares a name: its records are "${SCRIPT_TYPES}<name>.<record>"` });
    }
  }
  const listed = list !== undefined && ts.isArrayLiteralExpression(list) ? list.elements.map((element) => bare(ts, element).getText(source)) : [];
  for (const call of callsOf(ts, source, "emit")) {
    const declared = call.arguments[0];
    if (declared === undefined || listed.includes(bare(ts, declared).getText(source))) continue;
    errors.push({
      file,
      ...placeOf(ts, source, declared),
      code: "emit",
      message: `emit ${bare(ts, declared).getText(source)}: a script emits only the records it lists in workflow({ emits }), written as they are written there`,
    });
  }
  return errors;
}

/** `uses` of a script, read from the text without running it; absent when the script has none. */
export async function scriptUses(source: ScriptSource): Promise<Uses | undefined> {
  const ts = (await import("typescript")).default;
  return usesOf(ts, ts.createSourceFile(source.file, source.text, ts.ScriptTarget.ESNext, true));
}

/** The records of scripts (`wf.<name>.<record>`) a script waits for or reads by name, written out as text. */
export async function scriptReads(source: ScriptSource): Promise<string[]> {
  const ts = (await import("typescript")).default;
  const parsed = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.ESNext, true);
  const named = [...waitsOf(ts, parsed).map((wait) => wait.type), ...readTypesOf(ts, parsed)];
  return [...new Set(named.filter((type) => type.startsWith(SCRIPT_TYPES)))];
}

/**
 * `uses` of a parsed script.
 *
 * Absent when the script declares no `uses`: what such a script may call depends on who
 * starts it (see `allowedFor`).
 */
function usesOf(ts: typeof Ts, source: Ts.SourceFile): Uses | undefined {
  const field = declarationField(ts, source, "uses");
  if (field === undefined) return undefined;
  // A spread, a computed key or an accessor may decide `uses`: the masks are not the text's to give, and a run is not left unrestricted by it.
  if ("unsettled" in field) return { bad: placeOf(ts, source, field.unsettled) };
  const list = bare(ts, field.value);
  if (!ts.isArrayLiteralExpression(list)) return { bad: placeOf(ts, source, list) };
  const masks: Use[] = [];
  for (const element of list.elements) {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return { bad: placeOf(ts, source, element) };
    masks.push({ mask: element.text, ...placeOf(ts, source, element) });
  }
  return { masks };
}

/**
 * `phases` of a parsed script, read from the text: the titles the typing of a script's `phase` option is made of.
 * Absent when the script declares none; a list that is not written as a literal, or is not phases, is bad.
 */
function phasesOf(ts: typeof Ts, source: Ts.SourceFile): { phases: WorkflowPhases } | { bad: { line: number; column: number; message: string } } | undefined {
  const field = declarationField(ts, source, "phases");
  if (field === undefined) return undefined;
  if ("unsettled" in field) return { bad: { ...placeOf(ts, source, field.unsettled), message: "phases is not settled by the declaration: a spread or a computed key may decide it" } };
  const written = literalOf(ts, field.value);
  if (written === undefined) return { bad: { ...placeOf(ts, source, field.value), message: "phases must be written in the declaration as a list: phases: [{ title: \"Review\" }, { title: \"Fix\", detail: \"...\" }]" } };
  const parsed = WorkflowPhases.safeParse(written.value);
  return parsed.success ? { phases: parsed.data } : { bad: { ...placeOf(ts, source, field.value), message: `phases: ${z.prettifyError(parsed.error)}` } };
}

/** The options of the check: a `.ts` script is strict, a `.js` one is read for its syntax unless it opts in with `// @ts-check`. */
function optionsFor(ts: typeof Ts, file: string): Ts.CompilerOptions {
  const typescript = /\.[cm]?ts$/.test(file);
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts"],
    strict: typescript,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: false,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    // A script imports its types from the script package; the checker reads the file that holds them and nothing else of it.
    paths: { "@niwa-labs/script": [SCRIPT_API] },
    ...(TYPE_ROOTS === undefined ? {} : { typeRoots: [TYPE_ROOTS], types: ["bun"] }),
  };
}

/** The harnesses an `ask()` call may name: the ones the host serves, and the ones of them `uses` lets the script call. */
interface Harnesses {
  hosted: ReadonlySet<string>;
  allowed: ReadonlySet<string>;
}

/** What a script's checker says: the errors, and what it could not settle. */
interface Found {
  errors: CheckError[];
  warnings: CheckError[];
}

/** What the checker says, and the program it read: the script's references are followed in it. */
interface Diagnosis extends Found {
  program: Ts.Program;
}

/** The names a type of a harness can be, or `"dynamic"` when it is text known only when the script runs. Absent when the call names none. */
function harnessTypes(ts: typeof Ts, type: Ts.Type): string[] | "dynamic" | undefined {
  const names: string[] = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
    if (!member.isStringLiteral()) return "dynamic";
    names.push(member.value);
  }
  return names.length === 0 ? undefined : names;
}

/**
 * The `ask()` calls that start a session on a harness `uses` does not list, read from what the checker knows of the
 * `harness` of each call: a text, a constant that holds one, or a choice between them. A call whose harness is only known
 * when the script runs is a warning, since a run pauses on the first harness outside `uses`. The type of the options
 * refuses an unlisted harness in a script that is type checked, in the terms of overloads; the error here says which
 * entry of `uses` is missing, and is the only one for a script that is not type checked.
 */
function harnessUses(ts: typeof Ts, program: Ts.Program, source: ScriptSource, harnesses: Harnesses): Found {
  const found: Found = { errors: [], warnings: [] };
  const parsed = program.getSourceFile(source.file);
  if (parsed === undefined || harnesses.hosted.size === 0) return found;
  const checker = program.getTypeChecker();
  const uncovered = [...harnesses.hosted].filter((name) => !harnesses.allowed.has(name));
  for (const call of [...callsOf(ts, parsed, "ask"), ...callsOf(ts, parsed, "session")]) {
    const options = call.arguments[0] === undefined ? undefined : bare(ts, call.arguments[0]);
    if (options === undefined) continue;
    const written = ts.isObjectLiteralExpression(options)
      ? options.properties.find((property): property is Ts.PropertyAssignment | Ts.ShorthandPropertyAssignment => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(parsed) === "harness")
      : undefined;
    const spread = ts.isObjectLiteralExpression(options) ? options.properties.some((property) => ts.isSpreadAssignment(property)) : true;
    const place = { file: source.file, ...placeOf(ts, parsed, written ?? call) };
    const valueType = (property: Ts.PropertyAssignment | Ts.ShorthandPropertyAssignment): Ts.Type | undefined => {
      if (ts.isPropertyAssignment(property)) return checker.getTypeAtLocation(property.initializer);
      const value = checker.getShorthandAssignmentValueSymbol(property);
      return value === undefined ? undefined : checker.getTypeOfSymbolAtLocation(value, property.name);
    };
    // Options that are not written in the call (`ask(opts, p)`, `{ ...opts }`) are read by the type they have.
    const member = written === undefined && spread ? checker.getTypeAtLocation(options).getProperty("harness") : undefined;
    const type =
      written !== undefined
        ? valueType(written)
        : member === undefined
          ? undefined
          : checker.getTypeOfSymbolAtLocation(member, options);
    const names = type === undefined ? undefined : harnessTypes(ts, type);
    if (names === undefined) continue;
    if (names === "dynamic") {
      if (uncovered.length > 0) {
        found.warnings.push({ ...place, code: "uses", message: `${call.expression.getText(parsed)}() takes a harness that is known only when the script runs: uses needs an entry for each harness it may name (session.start.<harness>, or session.start.*), or a run pauses on the first that is missing` });
      }
      continue;
    }
    // A harness the host does not serve is the options' to refuse, with the ones it does.
    for (const name of names.filter((one) => harnesses.hosted.has(one) && !harnesses.allowed.has(one))) {
      found.errors.push({ ...place, code: "uses", message: `${call.expression.getText(parsed)}() starts a session on the harness "${name}", which uses does not list: add "session.start.${name}" (or "session.start.*") to uses` });
    }
  }
  return found;
}

function diagnose(ts: typeof Ts, source: ScriptSource, typing: string, harnesses: Harnesses): Diagnosis {
  const options = optionsFor(ts, source.file);
  const memory = new Map<string, string>([
    [source.file, source.text],
    [TYPING_FILE, typing],
  ]);
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => memory.has(name) || fileExists.call(host, name);
  host.readFile = (name) => memory.get(name) ?? readFile.call(host, name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const text = memory.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    const installed = name.includes("/node_modules/");
    const kept = installed ? parsedFiles.get(name) : undefined;
    if (kept !== undefined) return kept;
    const parsed = getSourceFile.call(host, name, languageVersion, onError, shouldCreate);
    if (installed && parsed !== undefined) parsedFiles.set(name, parsed);
    return parsed;
  };
  const program = ts.createProgram([source.file, TYPING_FILE], options, host);
  // A package the script imports is read under the options of the script, not its own: what it says of the package is
  // not the script's error, and it is not checked, only read for the types the script takes from it.
  const own = program.getSourceFiles().filter((file) => !program.isSourceFileFromExternalLibrary(file));
  const errors = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...own.flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
  ]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic): CheckError => {
      const where =
        diagnostic.file === undefined || diagnostic.start === undefined
          ? { line: 1, column: 1 }
          : (({ line, character }) => ({ line: line + 1, column: character + 1 }))(
              diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start),
            );
      return {
        file: diagnostic.file?.fileName ?? source.file,
        ...where,
        code: `TS${String(diagnostic.code)}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      };
    });
  const uses = harnessUses(ts, program, source, harnesses);
  return { errors: [...errors, ...uses.errors], warnings: uses.warnings, program };
}

/** What a check needs to know about the host. */
export interface Catalogue {
  /** Every action the host describes. */
  actions: readonly ActionDescription[];
  /** The actions the caller may call: the seam where rights narrow what a script may use. */
  callable: readonly ActionName[];
  /** The grant of the caller, which `uses` is narrowed from; absent means nothing limits it. */
  rights?: Grant | "unlimited";
  /**
   * The options block each harness takes, by its id, as the sessions module binds it (`harness.list`): what the
   * block of an `ask()` call is typed by. A harness not in it takes no block.
   */
  blocks?: ReadonlyMap<string, HarnessBlock>;
  /**
   * The records the host lets a script start on (`on`), with the schema of their data. Part of what a wait and a read are
   * typed by too. The list may grow from the journal (the records registered workflows declare in `emits`), so it is
   * part of the key of a kept answer.
   */
  triggers?: readonly Trigger[];
  /**
   * The schema of the data of a record type the host knows, by its name: what a wait or a read of the script is typed
   * by. Types are fixed for the life of a host, so the names a script writes, pinned by the hash of its text, give the
   * same answers.
   */
  records?: (type: string) => JsonSchema | undefined;
  /** The version of a record type the host knows, by its name: what a script that names the type by reference must name. */
  versions?: (type: string) => number | undefined;
}

/** Which of the described actions are irreversible: a mask of `uses` does not grant them. */
function irreversibleIn(actions: readonly ActionDescription[]): (name: string) => boolean {
  const named = new Set(actions.filter((action) => action.effect === "irreversible").map((action) => String(action.name)));
  return (name) => named.has(name);
}

/** A record type a script may start on, with the schema of the data of its records. */
export interface Trigger {
  name: string;
  schema: JsonSchema;
}

/** The places of the keys of the declaration that read the schemas, for the errors about them. */
export interface Places {
  declaration: { line: number; column: number };
  input?: { line: number; column: number };
  output?: { line: number; column: number };
  emits?: { line: number; column: number };
  phases?: { line: number; column: number };
}

/** What the text and the typing say of a script: the part of a check that does not load the module. */
export interface TextCheck {
  file: string;
  ok: boolean;
  errors: CheckError[];
  /** What the text could not settle; a warning does not fail the check. */
  warnings: CheckError[];
  /** The module can be loaded for its schemas: it is `export default workflow({ ... }, fn)`. */
  readable: boolean;
  places: Places;
}

/**
 * A checker that keeps the answers it gave.
 *
 * What the text and the typing say is kept by the file, the hash of the script and the hash of the
 * catalogue it was checked against, so the same script on the same host is checked once. The file is
 * part of the key: its extension decides how strictly the text is read, and its folder where imports
 * go. What the module declares is not kept here (`withDeclaration`): it is read by the describer, which keeps
 * it for the version of the script, the hash of its source closure.
 */
export function scriptChecker(): (source: ScriptSource, catalogue: Catalogue) => Promise<TextCheck> {
  const answers = new Map<string, TextCheck>();
  return async (source, catalogue) => {
    const file = resolve(source.file);
    const key = `${file}:${sha256(source.text)}:${sha256(JSON.stringify([catalogue.actions, catalogue.callable, catalogue.rights ?? "unlimited", catalogue.triggers ?? [], [...(catalogue.blocks ?? [])]]))}`;
    let kept = answers.get(key);
    if (kept === undefined) {
      kept = await check({ file, text: source.text }, catalogue);
      if (answers.size >= CACHE_LIMIT) {
        for (const oldest of answers.keys()) {
          answers.delete(oldest);
          break;
        }
      }
      answers.set(key, kept);
    }
    return { ...kept, file };
  };
}

/** The report of a check: what the text said, and what the module declares, read from its file. */
export async function withDeclaration(text: TextCheck, describe: Describer, box?: ScriptBox): Promise<CheckReport> {
  const { file } = text;
  const errors = [...text.errors];
  const warned = text.warnings.length === 0 ? {} : { warnings: text.warnings };
  if (!text.readable) return { file, ok: errors.length === 0, errors, ...warned, note: "described, the script was not run" };
  const read = await describe(file, box);
  if ("failed" in read) {
    errors.push({ file, ...text.places.declaration, code: "describe", message: `the module could not be read for its schemas: ${read.failed}` });
    return { file, ok: false, errors, ...warned, note: "described, the script was not run" };
  }
  const { description, input, output, emits, phases, problems } = read.described;
  for (const problem of problems) {
    // Phases the text already shows to be wrong are not said twice.
    if (problem.key === "phases" && errors.some((error) => error.code === "phases")) continue;
    errors.push({ file, ...(text.places[problem.key] ?? text.places.declaration), code: problem.key === "phases" ? "phases" : "schema", message: problem.message });
  }
  return {
    file,
    ok: errors.length === 0,
    errors,
    ...warned,
    note: "described, the script was not run",
    ...(description === undefined ? {} : { description }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(emits === undefined ? {} : { emits: emittedTypesOf(read) }),
    ...(phases === undefined ? {} : { phases }),
    ...(problems.length === 0 ? { contract: contractOf(read.described) } : {}),
  };
}

/** The keys of the declaration that hold the schemas, with their places. */
function placesOf(ts: typeof Ts, source: Ts.SourceFile): Places {
  const declaration = declarationOf(ts, source);
  const places: Places = { declaration: { line: 1, column: 1 } };
  if (declaration === undefined) return places;
  if ("opaque" in declaration) return { declaration: declaration.opaque };
  places.declaration = placeOf(ts, source, declaration.object);
  for (const key of ["input", "output", "emits", "phases"] as const) {
    const field = declarationField(ts, source, key);
    if (field !== undefined) places[key] = placeOf(ts, source, "value" in field ? field.value : field.unsettled);
  }
  return places;
}

/** The leaves a schema is at a point: the references followed, and the unions and intersections opened. */
function leavesOf(root: unknown, schema: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 16 || typeof schema !== "object" || schema === null || Array.isArray(schema)) return [{}];
  const here = schema as Record<string, unknown>;
  const ref = here.$ref;
  if (typeof ref === "string") {
    if (ref === "#") return [{}];
    const target = ref.startsWith("#/$defs/") ? (root as { $defs?: Record<string, unknown> }).$defs?.[ref.slice("#/$defs/".length)] : undefined;
    return target === undefined ? [{}] : leavesOf(root, target, depth + 1);
  }
  const parts = [here.anyOf, here.oneOf, here.allOf].flatMap((part) => (Array.isArray(part) ? part : []));
  return parts.length > 0 ? parts.flatMap((part) => leavesOf(root, part, depth + 1)) : [here];
}

/** The leaves of the schema at a path of field names, or `undefined` when no such field can exist. */
function leavesAt(root: unknown, schema: unknown, path: readonly string[]): Array<Record<string, unknown>> | undefined {
  const leaves = leavesOf(root, schema);
  const [name, ...rest] = path;
  if (name === undefined) return leaves;
  const found: Array<Record<string, unknown>> = [];
  for (const leaf of leaves) {
    const properties = typeof leaf.properties === "object" && leaf.properties !== null ? (leaf.properties as Record<string, unknown>) : undefined;
    const member = properties !== undefined && name in properties ? properties[name] : undefined;
    // A leaf that says nothing of its fields, or lets any field in, holds any path.
    const open = (leaf.type === undefined && properties === undefined) || (leaf.type === "object" && properties === undefined && leaf.additionalProperties !== false) || leaf.additionalProperties === true;
    if (member !== undefined) found.push(...(leavesAt(root, member, rest) ?? []));
    else if (typeof leaf.additionalProperties === "object" && leaf.additionalProperties !== null) found.push(...(leavesAt(root, leaf.additionalProperties, rest) ?? []));
    else if (open) found.push({});
  }
  return found.length === 0 ? undefined : found;
}

/** Can a field of this schema hold the literal a filter names? */
function fits(leaf: Record<string, unknown>, value: unknown): boolean {
  if ("const" in leaf) return leaf.const === value;
  if (Array.isArray(leaf.enum)) return leaf.enum.includes(value);
  const types = Array.isArray(leaf.type) ? leaf.type : leaf.type === undefined ? undefined : [leaf.type];
  if (types === undefined) return true;
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return types.some((type) => type === kind || (type === "integer" && kind === "number" && Number.isInteger(value)));
}

/** A filter written in the script, of `on` or of a wait: the type it filters, the filter, and where it is. */
interface WrittenFilter extends Subscription {
  line: number;
  column: number;
}

/** The errors of a filter of `on` or of a wait: a path no record of the type holds, or a literal its field cannot hold. */
function filterErrors(file: string, code: "on" | "wait", written: WrittenFilter, schema: unknown): CheckError[] {
  const errors: CheckError[] = [];
  const never = code === "on" ? "the script would never start" : "the wait would never end";
  for (const [path, value] of Object.entries(written.filter ?? {})) {
    const place = { file, line: written.line, column: written.column, code };
    const leaves = leavesAt(schema, schema, path.split("."));
    if (leaves === undefined) errors.push({ ...place, message: `${code} "${written.type}": the filter names "${path}", which no record of this type holds, so ${never}` });
    else if (!leaves.some((leaf) => fits(leaf, value))) {
      errors.push({ ...place, message: `${code} "${written.type}": the filter says ${JSON.stringify(value)} for "${path}", which the field cannot hold` });
    }
  }
  return errors;
}

/** The text of a literal of text, when the expression is one. */
function textOf(ts: typeof Ts, expression: Ts.Expression | undefined): string | undefined {
  const inner = expression === undefined ? undefined : bare(ts, expression);
  return inner !== undefined && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) ? inner.text : undefined;
}

/** The value of a key of an object written as a literal, when the expression is one and the key is there. */
function keyOf(ts: typeof Ts, expression: Ts.Expression | undefined, key: string): Ts.Expression | undefined {
  const inner = expression === undefined ? undefined : bare(ts, expression);
  if (inner === undefined || !ts.isObjectLiteralExpression(inner)) return undefined;
  for (const property of inner.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === key) return property.initializer;
  }
  return undefined;
}

/** The waits whose type is written out, with their filter when it is written as a literal. */
function waitsOf(ts: typeof Ts, source: Ts.SourceFile): WrittenFilter[] {
  const waits: WrittenFilter[] = [];
  for (const call of callsOf(ts, source, "wait")) {
    const type = textOf(ts, call.arguments[0]);
    if (type === undefined) continue;
    const filter = keyOf(ts, call.arguments[1], "filter");
    const written = filter === undefined ? undefined : literalOf(ts, filter)?.value;
    const fields = typeof written === "object" && written !== null && !Array.isArray(written) ? (written as Record<string, unknown>) : undefined;
    waits.push({ type, ...(fields === undefined ? {} : { filter: fields }), ...placeOf(ts, source, call) });
  }
  return waits;
}

/** The record types `read.records({ types: [...] })` names as text. */
function readTypesOf(ts: typeof Ts, source: Ts.SourceFile): string[] {
  const types: string[] = [];
  const visit = (node: Ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "read" &&
      node.expression.name.text === "records"
    ) {
      const list = keyOf(ts, node.arguments[0], "types");
      const inner = list === undefined ? undefined : bare(ts, list);
      if (inner !== undefined && ts.isArrayLiteralExpression(inner)) {
        for (const element of inner.elements) {
          const type = textOf(ts, element);
          if (type !== undefined) types.push(type);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return types;
}

/** A type a wait or a read of the script names by reference, followed to the declaration the reference is made by. */
interface Referenced {
  code: "wait" | "read";
  /** The reference as the script writes it. */
  written: string;
  /** The name and the version the declaration gives the type. */
  name: string;
  version: number;
  /** The filter of a wait, when it is written as a literal. */
  filter?: Record<string, unknown>;
  line: number;
  column: number;
}

/** How many calls deep the check follows a query builder to the type it names. */
const BUILDER_DEPTH = 4;

/** What a function gives back: the body of an arrow written as an expression, or what its own `return`s give. */
function returnedBy(ts: typeof Ts, declaration: Ts.Declaration | undefined): Ts.Expression[] {
  const fn =
    declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      ? bare(ts, declaration.initializer)
      : declaration;
  if (fn === undefined || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: Ts.Expression[] = [];
  const visit = (node: Ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression !== undefined) found.push(node.expression);
    } else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * The type a reference names: the reference is followed through its import to where it is made, `record("name",
 * schema, { version })` with the name and the version written as literals. A query a builder gives (`taskDone(id)`) is
 * followed into the builder to the `queryOf(Type, filter)` it returns, and from there to the type. A reference made
 * any other way, and a record of the script itself (made by its own `record`), name nothing the check can follow: the
 * host refuses a reference it does not know when the script runs.
 */
function referencedType(ts: typeof Ts, checker: Ts.TypeChecker, expression: Ts.Expression, depth = 0): { name: string; version: number } | undefined {
  const resolved = (node: Ts.Node): Ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const inner = bare(ts, expression);
  if (ts.isCallExpression(inner)) {
    if (depth >= BUILDER_DEPTH) return undefined;
    const callee = ts.isPropertyAccessExpression(inner.expression) ? inner.expression.name : inner.expression;
    if (ts.isIdentifier(callee) && callee.text === "queryOf") {
      const [type] = inner.arguments;
      return type === undefined ? undefined : referencedType(ts, checker, type, depth + 1);
    }
    // A builder names one type: every `return` of it must lead to the same one.
    const types = returnedBy(ts, resolved(callee)?.valueDeclaration).map((returned) => referencedType(ts, checker, returned, depth + 1));
    const [first] = types;
    return first !== undefined && types.every((one) => one?.name === first.name && one.version === first.version) ? first : undefined;
  }
  if (!ts.isIdentifier(inner) && !ts.isPropertyAccessExpression(inner)) return undefined;
  const declaration = resolved(inner)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
  const made = bare(ts, declaration.initializer);
  if (!ts.isCallExpression(made)) return undefined;
  const callee = ts.isPropertyAccessExpression(made.expression) ? made.expression.name : made.expression;
  if (!ts.isIdentifier(callee)) return undefined;
  // A query a builder gave, kept in a constant: followed as the call it was made by.
  if (callee.text !== "record") return referencedType(ts, checker, made, depth + 1);
  if ((resolved(callee)?.declarations ?? []).some((one) => one.getSourceFile().fileName === TYPING_FILE)) return undefined;
  const name = textOf(ts, made.arguments[0]);
  if (name === undefined) return undefined;
  const options = made.arguments[2];
  if (options === undefined) return { name, version: 1 };
  if (!ts.isObjectLiteralExpression(bare(ts, options))) return undefined;
  const written = keyOf(ts, options, "version");
  const version = written === undefined ? 1 : literalOf(ts, written)?.value;
  return typeof version === "number" ? { name, version } : undefined;
}

/** The waits and the reads of the script that name a type by reference, each followed to the type it names. */
function referencesOf(ts: typeof Ts, program: Ts.Program, file: string): Referenced[] {
  const source = program.getSourceFile(file);
  if (source === undefined) return [];
  const checker = program.getTypeChecker();
  const found: Referenced[] = [];
  const add = (code: Referenced["code"], expression: Ts.Expression, filter?: Ts.Expression): void => {
    if (textOf(ts, expression) !== undefined) return;
    const type = referencedType(ts, checker, expression);
    if (type === undefined) return;
    const written = filter === undefined ? undefined : literalOf(ts, filter)?.value;
    const fields = typeof written === "object" && written !== null && !Array.isArray(written) ? (written as Record<string, unknown>) : undefined;
    found.push({ code, written: bare(ts, expression).getText(source), ...type, ...(fields === undefined ? {} : { filter: fields }), ...placeOf(ts, source, expression) });
  };
  const visit = (node: Ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      if (ts.isIdentifier(node.expression) && node.expression.text === "wait" && first !== undefined) {
        add("wait", first, keyOf(ts, second, "filter"));
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "read" &&
        node.expression.name.text === "records" &&
        first !== undefined
      ) {
        const list = keyOf(ts, first, "types");
        const types = list === undefined ? undefined : bare(ts, list);
        if (types !== undefined && ts.isArrayLiteralExpression(types)) for (const element of types.elements) add("read", element);
        else if (list === undefined) add("read", first);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The errors of the types a script names by reference: one the host does not know, so a wait for it would never end,
 * or one at a version the host does not write; and a filter of a wait no record of the type can hold.
 */
function referenceErrors(file: string, references: readonly Referenced[], catalogue: Catalogue): CheckError[] {
  const errors: CheckError[] = [];
  for (const reference of references) {
    const place = { file, line: reference.line, column: reference.column, code: reference.code };
    const said = `${reference.code} ${reference.written}`;
    const schema = catalogue.records?.(reference.name);
    if (catalogue.records !== undefined && schema === undefined) {
      const never = reference.code === "wait" ? ", so the wait would never end" : "";
      errors.push({ ...place, message: `${said}: the host knows no record type "${reference.name}"${never}` });
      continue;
    }
    const version = catalogue.versions?.(reference.name);
    if (version !== undefined && version !== reference.version) {
      errors.push({ ...place, message: `${said}: the script names version ${String(reference.version)} of "${reference.name}", and the host writes version ${String(version)}` });
      continue;
    }
    if (reference.code === "wait" && schema !== undefined) {
      errors.push(...filterErrors(file, "wait", { type: reference.name, ...(reference.filter === undefined ? {} : { filter: reference.filter }), line: reference.line, column: reference.column }, schema));
    }
  }
  return errors;
}

/**
 * The record types the typing of a script describes, with the schema of their data: the types it may start on, and the
 * types it waits for or reads by name that the host knows. A record of a script that no schema describes carries data
 * of any shape; a type the host does not know is not described, so a typed wait for it is an error of the type checker.
 */
function recordCatalogue(catalogue: Catalogue, named: readonly string[]): Trigger[] {
  const known = new Map((catalogue.triggers ?? []).map((trigger) => [trigger.name, trigger]));
  for (const name of new Set(named)) {
    if (known.has(name)) continue;
    const schema = catalogue.records?.(name) ?? (name.startsWith(SCRIPT_TYPES) ? {} : undefined);
    if (schema !== undefined) known.set(name, { name, schema });
  }
  return [...known.values()];
}

async function check(source: ScriptSource, catalogue: Catalogue): Promise<TextCheck> {
  const ts = (await import("typescript")).default;
  const parsed = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.ESNext, true);
  const declaration = declarationOf(ts, parsed);
  const places = placesOf(ts, parsed);
  const errors: CheckError[] = [];
  if (declaration === undefined || "opaque" in declaration) {
    errors.push({
      file: source.file,
      ...places.declaration,
      code: "workflow",
      message:
        declaration === undefined
          ? "the script must be `export default workflow({ ... }, async (input) => { ... })`"
          : "workflow() is given its declaration as an object written in the call: `workflow({ description, input, output, uses, on }, fn)`",
    });
  } else if (declarationField(ts, parsed, "on") !== undefined && declarationField(ts, parsed, "input") !== undefined) {
    errors.push({ file: source.file, ...places.declaration, code: "workflow", message: "a script has an `input` or it starts `on` records, not both: its function is given the record" });
  }
  const uses = usesOf(ts, parsed);
  if (uses !== undefined && "bad" in uses) {
    errors.push({ file: source.file, ...uses.bad, code: "uses", message: "uses must be a list of action names or masks written as text" });
  }
  const on = onOf(ts, parsed);
  if (on !== undefined && "bad" in on) errors.push({ file: source.file, ...on.bad, code: "on" });
  const phases = phasesOf(ts, parsed);
  if (phases !== undefined && "bad" in phases) errors.push({ file: source.file, ...phases.bad, code: "phases" });
  for (const subscription of on !== undefined && "subscriptions" in on ? on.subscriptions : []) {
    const trigger = catalogue.triggers?.find((one) => one.name === subscription.type);
    if (catalogue.triggers !== undefined && !subscription.type.startsWith(SCRIPT_TYPES) && trigger === undefined) {
      errors.push({
        file: source.file,
        line: subscription.line,
        column: subscription.column,
        code: "on",
        message: `on "${subscription.type}": the host does not start scripts on this record type`,
      });
    } else if (trigger !== undefined) {
      errors.push(...filterErrors(source.file, "on", subscription, trigger.schema));
    }
  }
  const waits = waitsOf(ts, parsed);
  const records = recordCatalogue(catalogue, [...waits.map((wait) => wait.type), ...readTypesOf(ts, parsed)]);
  for (const wait of waits) {
    const described = records.find((one) => one.name === wait.type);
    if (described !== undefined) errors.push(...filterErrors(source.file, "wait", wait, described.schema));
  }
  // A script writes only the records it declares, under its own `wf.<name>.`, so it cannot speak as another workflow.
  errors.push(...emitErrors(ts, parsed, source.file));
  const masks = uses !== undefined && "masks" in uses ? uses.masks : undefined;
  const rights = catalogue.rights ?? "unlimited";
  // The same narrowing `workflow.start` makes: a mask the caller's grant does not hold is refused.
  const wider = new Set<string>();
  // A template is filled from the input of a run, so it is held to the rights when a run starts, not here.
  if (rights !== "unlimited") {
    const fixed = (masks ?? []).filter((use) => isUse(use.mask) && !isRuleTemplate(use.mask)).map((use) => use.mask);
    const narrowed = narrow(rights, fixed, isOwnerGrant(rights) ? {} : { irreversible: irreversibleIn(catalogue.actions) });
    if ("refused" in narrowed) for (const refused of narrowed.refused) wider.add(refused);
  }
  for (const use of masks ?? []) {
    const place = { file: source.file, line: use.line, column: use.column, code: "uses" };
    const name = useName(use.mask);
    if (name === undefined) {
      errors.push({ ...place, message: `uses "${use.mask}" is not an action name, a rule or a target template` });
    } else if (!isRuleTemplate(use.mask) && wider.has(ruleText(rule(use.mask)))) {
      errors.push({ ...place, message: `uses "${use.mask}" is wider than the caller's rights` });
    } else if (!catalogue.callable.some((callable) => matches(name, callable))) {
      errors.push({ ...place, message: `uses "${use.mask}" names no action the caller may call` });
    }
  }
  const allowed = allowedFor(catalogue.callable, masks?.flatMap((use) => useName(use.mask) ?? []), rights);
  const listed = on !== undefined && "subscriptions" in on ? on.subscriptions.map((subscription) => subscription.type) : [];
  // A record of a script that no schema describes carries data of any shape.
  const known = catalogue.triggers ?? [];
  const described = [
    ...known,
    ...listed.filter((type) => type.startsWith(SCRIPT_TYPES) && !known.some((trigger) => trigger.name === type)).map((name) => ({ name, schema: {} })),
  ];
  const titles = phases !== undefined && "phases" in phases ? phases.phases.map((phase) => phase.title) : [];
  const typing = scriptTyping(catalogue.actions, allowed, described.filter((trigger) => listed.includes(trigger.name)), records, catalogue.blocks, titles);
  const harnessesOf = (names: readonly string[]) => new Set(names.flatMap((name) => harnessOfAction(name) ?? []));
  const diagnosis = diagnose(ts, source, typing.declarations, { hosted: harnessesOf(catalogue.actions.map((action) => action.name)), allowed: harnessesOf(allowed) });
  errors.push(...referenceErrors(source.file, referencesOf(ts, diagnosis.program, source.file), catalogue));
  errors.push(...diagnosis.errors);
  return { file: source.file, ok: errors.length === 0, errors, warnings: diagnosis.warnings, readable: declaration !== undefined && "object" in declaration, places };
}
