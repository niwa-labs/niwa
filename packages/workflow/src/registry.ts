/**
 * The registered workflows as the journal holds them.
 *
 * A workflow is a `workflow.registered` record: the first one issues its id, a later one under the
 * same id is a new version. A version is the hash of the source closure of the script, the entry
 * file and the local files it imports, so an edit of a helper is a new version and a dependency
 * from `node_modules` is not. A version whose latest check after a change of a workflow it calls
 * failed is broken.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { EntityDescription, IssuedId, JournalReader, RecordId } from "@niwa-labs/core";

import { contractOf } from "./describe.ts";
import type { Described } from "./describe.ts";
import { SCRIPT_TYPES } from "./language.ts";
import type { WorkflowPhases } from "./language.ts";
import { WorkflowRechecked, WorkflowRegistered, WorkflowVersion } from "./records.ts";
import type { Builtin, ContractHash, EmittedRecord, FlowCall, JsonSchemaValue, Subscription, WorkflowId } from "./records.ts";

/** One version of a registered workflow. */
export interface RegisteredVersion {
  version: WorkflowVersion;
  file: string;
  description: EntityDescription;
  input?: JsonSchemaValue;
  output?: JsonSchemaValue;
  contract: ContractHash;
  uses: string[];
  calls: FlowCall[];
  /** The `name` of the script. */
  name?: string;
  /** The records of scripts it waits for or reads by name. */
  reads: string[];
  /** The record types it declares in `emits`. */
  emits?: EmittedRecord[];
  /** The records that start it once it is installed. */
  on?: Subscription[];
  /** The phases it declares, in order. */
  phases?: WorkflowPhases;
  /** Why it does not start: the errors of its latest check, when that check failed. */
  broken?: string;
  /** A candidate version of a gated built-in, not accepted yet. */
  candidate?: true;
}

/** A registered workflow: its id, the record that issued it, and its versions, the latest last. */
export interface RegisteredWorkflow {
  id: WorkflowId;
  record: RecordId;
  versions: RegisteredVersion[];
  latest: RegisteredVersion;
  /** The built-in it is, when a plugin ships it: registered by the workflow module, never by hand. */
  builtin?: Builtin;
}

/** Every registered workflow, in the order of their first registration. */
export function workflowsOf(journal: JournalReader): RegisteredWorkflow[] {
  const checks = journal.find({ type: WorkflowRechecked.name }).map((row) => WorkflowRechecked.schema.parse(row.data));
  const byId = new Map<WorkflowId, RegisteredWorkflow>();
  for (const row of journal.find({ type: WorkflowRegistered.name })) {
    const data = WorkflowRegistered.schema.parse(row.data);
    const last = checks.filter((check) => check.workflow === data.workflow && check.version === data.version).at(-1);
    const version: RegisteredVersion = {
      version: data.version,
      file: data.file,
      description: data.description,
      ...(data.input === undefined ? {} : { input: data.input }),
      ...(data.output === undefined ? {} : { output: data.output }),
      contract: data.contract,
      uses: data.uses,
      calls: last?.calls ?? data.calls,
      ...(data.name === undefined ? {} : { name: data.name }),
      reads: data.reads ?? [],
      ...(data.emits === undefined ? {} : { emits: data.emits }),
      ...(data.on === undefined ? {} : { on: data.on }),
      ...(data.phases === undefined ? {} : { phases: data.phases }),
      ...(last === undefined || last.ok ? {} : { broken: last.errors.map((error) => `${error.code} ${error.message}`).join("; ") }),
    };
    const known = byId.get(data.workflow);
    if (known === undefined) {
      const first = data.candidate === true ? { ...version, candidate: true as const } : version;
      byId.set(data.workflow, { id: data.workflow, record: row.id, versions: [first], latest: first, ...(data.builtin === undefined ? {} : { builtin: data.builtin }) });
    } else {
      // A version that was accepted stays accepted; a candidate moves the latest version only while no version is accepted.
      const was = known.versions.find((one) => one.version === data.version);
      const candidate = data.candidate === true && (was === undefined || was.candidate === true);
      const now = candidate ? { ...version, candidate: true as const } : version;
      // A version registered again is the same version: it moves to the end, it is not listed twice.
      known.versions = [...known.versions.filter((one) => one.version !== data.version), now];
      if (!candidate || known.latest.candidate === true) known.latest = now;
    }
  }
  return [...byId.values()];
}

/**
 * What a registered version declared, as its registration holds it: the module need not be read for it.
 * Undefined for a version that was not registered, and for one whose registration does not give back the
 * contract it was made under.
 */
export function declaredBy(journal: JournalReader, version: WorkflowVersion): Described | undefined {
  const registered = workflowsOf(journal)
    .flatMap((one) => one.versions)
    .find((one) => one.version === version);
  if (registered === undefined) return undefined;
  const emits = registered.emits?.map(({ record, schema }) => ({ name: record, schema }));
  // The name is kept by the registration; one made before it was kept has it between the parts of its records `wf.<name>.<record>`.
  const first = registered.emits?.[0];
  const name =
    registered.name ??
    (first === undefined || !first.type.startsWith(SCRIPT_TYPES) || !first.type.endsWith(`.${first.record}`) ? undefined : first.type.slice(SCRIPT_TYPES.length, -(first.record.length + 1)));
  const described: Described = {
    ...(name === undefined ? {} : { name }),
    description: registered.description,
    ...(registered.input === undefined ? {} : { input: registered.input }),
    ...(registered.output === undefined ? {} : { output: registered.output }),
    ...(emits === undefined ? {} : { emits }),
    ...(registered.phases === undefined ? {} : { phases: registered.phases }),
    problems: [],
  };
  return contractOf(described) === registered.contract ? described : undefined;
}

/** The registered workflow that is this built-in, when it was registered. */
export const builtinOf = (workflows: readonly RegisteredWorkflow[], builtin: Builtin): RegisteredWorkflow | undefined =>
  workflows.find((one) => one.builtin?.plugin === builtin.plugin && one.builtin.name === builtin.name);

/** The workflow ids that were issued, each with the record it was born in. */
export const workflowIdsOf = (journal: JournalReader): IssuedId[] =>
  workflowsOf(journal).map((one) => ({ id: one.id, seed: one.record }));

/** The workflows whose latest version calls this one. */
export const dependentsOf = (workflows: readonly RegisteredWorkflow[], id: WorkflowId): RegisteredWorkflow[] =>
  workflows.filter((one) => one.id !== id && one.latest.calls.some((call) => call.workflow === id));

/** The workflows whose latest version waits for or reads one of these record types, by name. */
export const readersOf = (workflows: readonly RegisteredWorkflow[], id: WorkflowId, types: ReadonlySet<string>): RegisteredWorkflow[] =>
  workflows.filter((one) => one.id !== id && one.latest.reads.some((type) => types.has(type)));

/** The name of the action a registered workflow is. */
export const flowActionName = (id: WorkflowId): `flow.${WorkflowId}` => `flow.${id}`;

const transpiler = new Bun.Transpiler({ loader: "tsx" });

/** The local file an import names, as the runtime finds it; undefined for a package, or a path that is not there. */
function localImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** The source closure of a script: the entry and every local file it imports, each by its absolute path, with its bytes. */
export interface SourceClosure {
  entry: string;
  files: Map<string, Buffer>;
}

/** The extensions of the files a script imports as code; any other file it imports is data. */
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Is this file of a closure code, whose imports are part of the closure, or data, which imports nothing? */
export const isCode = (path: string): boolean => CODE.test(path);

/** The source closure of a script, as it is on disk now. Undefined when the entry cannot be read. */
export function closureOf(file: string): SourceClosure | undefined {
  if (!existsSync(file)) return undefined;
  const entry = resolve(file);
  const files = new Map<string, Buffer>();
  const pending = [entry];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (files.has(next)) continue;
    const bytes = readFileSync(next);
    files.set(next, bytes);
    // A data file (`./table.json`) is part of the version by its bytes; it is not read for imports.
    if (!isCode(next)) continue;
    for (const { path } of transpiler.scanImports(bytes.toString("utf8"))) {
      const found = localImport(next, path);
      if (found !== undefined) pending.push(found);
    }
  }
  return { entry, files };
}

/** The packages a source closure imports by name: the specifiers of its code files that are not paths. */
export function packageImportsOf(closure: SourceClosure): string[] {
  const named = new Set<string>();
  for (const [path, bytes] of closure.files) {
    if (!isCode(path)) continue;
    for (const { path: specifier } of transpiler.scanImports(bytes.toString("utf8"))) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) named.add(specifier);
    }
  }
  return [...named].sort();
}

/** The version a source closure is: the sha256 of each file by its path relative to the entry and its bytes. */
export function versionOfClosure(closure: SourceClosure): WorkflowVersion {
  const hash = createHash("sha256");
  const home = dirname(closure.entry);
  for (const [path, bytes] of [...closure.files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${relative(home, path)}\0`).update(bytes).update("\0");
  }
  return WorkflowVersion.parse(hash.digest("hex"));
}

/**
 * The version of a script: the sha256 of its source closure, the entry and every local file it imports, each
 * by its path relative to the entry and its bytes. Undefined when the entry cannot be read.
 */
export function versionOf(file: string): WorkflowVersion | undefined {
  const closure = closureOf(file);
  return closure === undefined ? undefined : versionOfClosure(closure);
}
