/**
 * Generates `src/protocol/generated/zcode-protocol.ts`: the zod schemas of the
 * ZCode app-server wire, from ZCode's own zod protocol (`packages/shared/src/zcode-protocol`).
 *
 *   bun scripts/gen-zcode.ts [--zcode <ZCode checkout>]      (default: ~/projects/agents/ZCode)
 *
 * The route: ZCode's zod source is loaded as it is, `z.toJSONSchema` turns each wanted schema into
 * JSON Schema, and the dev dependency `json-schema-to-zod` turns that into zod source. Two things
 * are done to the JSON Schema on the way, both on purpose:
 * - `additionalProperties: false` is dropped. ZCode's schemas are `.strict()` because its own
 *   host drops what it does not know; niwa must not lose a whole message when a newer ZCode adds a
 *   field. The unknown field is stripped, and the raw message is kept elsewhere.
 * - `oneOf` (what a zod discriminated union becomes) is written `anyOf`: the converter would make `oneOf` an
 *   `unknown` checked by a refinement.
 * - `{}` (ZCode's `z.unknown()`) becomes `z.unknown()`, not the `z.any()` the converter writes.
 *
 * ZCode's source needs its own workspace packages and a `zod`. A checkout has no `node_modules`
 * and Bun would otherwise pick a `zod` from its cache or the home directory, so the sources are
 * copied into a temporary directory whose `node_modules` points at this package's `zod`: the
 * run is the same wherever it is made. Nothing is written to the checkout.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { jsonSchemaToZod } from "json-schema-to-zod";
import { z } from "zod";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "src/protocol/generated/zcode-protocol.ts");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One schema of ZCode's, by the module it is exported from and its name there. */
interface Source {
  readonly module: "protocol" | "legacy" | "validation" | "networkCapture";
  readonly name: string;
}

const protocol = (name: string): Source => ({ module: "protocol", name });

/** A notification ZCode sends the client: the method, and the schema of its params. */
const NOTIFICATIONS: ReadonlyArray<{ readonly method: string; readonly id: string; readonly schema: Source }> = [
  { method: "session/event", id: "SessionEvent", schema: protocol("zcodeSessionEventSchema") },
  { method: "state.updated", id: "StateUpdated", schema: protocol("zcodeStateUpdatedNotificationSchema") },
  { method: "session/lifecycle/changed", id: "SessionLifecycleChanged", schema: protocol("sessionLifecycleSnapshotSchema") },
  { method: "startup/pluginsDegraded", id: "PluginsDegraded", schema: protocol("zcodePluginStartupDegradedSchema") },
  { method: "startup/storageState", id: "StorageState", schema: protocol("zcodeStorageStartupStateSchema") },
  {
    method: "interaction/providerRuntimeHeadersCancelled",
    id: "ProviderRuntimeHeadersCancelled",
    schema: protocol("zcodeProviderRuntimeHeadersCancelledSchema"),
  },
  { method: "process/mcpTelemetry", id: "McpTelemetry", schema: protocol("zcodeMcpTelemetryEventSchema") },
  { method: "process/mcpResourceSamples", id: "McpResourceSamples", schema: protocol("zcodeMcpResourceSamplesSchema") },
  { method: "process/toolExecResource", id: "ToolExecResource", schema: protocol("zcodeToolExecResourceSchema") },
  { method: "plugins/operationProgress", id: "PluginOperationProgress", schema: protocol("zcodePluginOperationProgressNotificationSchema") },
  { method: "process/resourceSample", id: "ProcessResourceSample", schema: protocol("zcodeProcessResourceSampleSchema") },
  { method: "process/networkRequests", id: "NetworkRequests", schema: { module: "networkCapture", name: "networkCaptureBatchSchema" } },
  { method: "computer-use/operation-event", id: "ComputerUseOperationEvent", schema: protocol("zcodeComputerUseOperationEventSchema") },
];

/** A request ZCode makes of the client: the method, its params, and the answer it takes. */
const REQUESTS: ReadonlyArray<{ readonly method: string; readonly id: string; readonly params: Source; readonly result: Source }> = [
  {
    method: "session/requestRuntimePreferences",
    id: "RuntimePreferences",
    params: protocol("zcodeSessionRequestRuntimePreferencesParamsSchema"),
    result: protocol("zcodeSessionRuntimePreferencesResultSchema"),
  },
  {
    method: "interaction/requestPermission",
    id: "Permission",
    params: protocol("zcodePermissionRequestParamsSchema"),
    result: { module: "legacy", name: "zcodePermissionResponseSchema" },
  },
  {
    method: "interaction/requestUserInput",
    id: "UserInput",
    params: protocol("zcodeUserInputRequestParamsSchema"),
    result: protocol("zcodeUserInputResponseSchema"),
  },
  {
    method: "interaction/requestProviderRuntimeHeaders",
    id: "ProviderRuntimeHeaders",
    params: protocol("zcodeProviderRuntimeHeadersRequestParamsSchema"),
    result: protocol("zcodeProviderRuntimeHeadersResponseSchema"),
  },
  {
    method: "interaction/requestOfficialMcpAuthHeaders",
    id: "OfficialMcpAuthHeaders",
    params: protocol("zcodeOfficialMcpAuthHeadersRequestParamsSchema"),
    result: protocol("zcodeOfficialMcpAuthHeadersResponseSchema"),
  },
  {
    method: "interaction/requestCredentialCipher",
    id: "CredentialCipher",
    params: { module: "validation", name: "credentialCipherRequestSchema" },
    result: { module: "validation", name: "credentialCipherReplySchema" },
  },
  {
    method: "interaction/browserList",
    id: "BrowserList",
    params: protocol("zcodeBrowserListParamsSchema"),
    result: protocol("zcodeBrowserListResultSchema"),
  },
  {
    method: "interaction/browserExecute",
    id: "BrowserExecute",
    params: protocol("zcodeBrowserExecuteParamsSchema"),
    result: protocol("zcodeBrowserExecuteResultSchema"),
  },
  {
    method: "subagents/readRuntimeConfig",
    id: "SubagentsRuntimeConfig",
    params: protocol("zcodeSubagentsReadRuntimeConfigParamsSchema"),
    result: protocol("subagentRuntimeConfigSchema"),
  },
  {
    method: "bot/channel/reply",
    id: "ChannelReply",
    params: protocol("channelReplyRequestSchema"),
    result: protocol("channelReplyResultSchema"),
  },
  {
    method: "topic/resource/read",
    id: "TopicResourceRead",
    params: protocol("zcodeTopicResourceReadParamsSchema"),
    result: protocol("zcodeTopicResourceReadResultSchema"),
  },
  {
    method: "topic/resource/cancel",
    id: "TopicResourceCancel",
    params: protocol("zcodeTopicResourceCancelParamsSchema"),
    result: protocol("zcodeTopicResourceCancelResultSchema"),
  },
];

/** The app-control intents: one request each, `appControl/<intent>`, and `appControl/cancel`. */
const APP_CONTROL_INTENTS = [
  "listProjects",
  "listSessions",
  "readSession",
  "createSession",
  "forkSession",
  "sendToSession",
  "waitSessions",
  "interruptSession",
  "renameSession",
  "openSession",
  "setSessionArchived",
  "setSessionPinned",
] as const;

/** What niwa reads of the answers to its own calls: one message of a `session/messages` result. */
const CALLS: ReadonlyArray<{ readonly id: string; readonly schema: Source }> = [
  { id: "SessionMessage", schema: { module: "legacy", name: "zcodeMessageWithPartsSchema" } },
];

/**
 * Methods under `interaction/` that ZCode defines are all requests of the server to the client.
 * One that is not in `REQUESTS` fails the generation: a snapshot with a new one is not silently left out.
 */
const REQUEST_FAMILY = /^interaction\/(request|browser)/;

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const checkout = resolve((argument("--zcode") ?? join(homedir(), "projects/agents/ZCode")).replace(/^~/, homedir()));

function git(...args: string[]): string {
  const run = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${checkout}: ${run.stderr}`);
  return run.stdout.trim();
}

function versionOf(path: string): string {
  const manifest = JSON.parse(readFileSync(join(checkout, path), "utf8")) as { version?: string };
  if (manifest.version === undefined) throw new Error(`${path} has no version`);
  return manifest.version;
}

/** Copies the sources the protocol needs into a temporary directory that has its own `node_modules`. */
function stage(): string {
  const dir = mkdtempSync(join(tmpdir(), "niwa-zcode-gen-"));
  const packages = ["shared", "session-control", "model-option-map"];
  for (const name of packages) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    cpSync(join(checkout, "packages", name, "package.json"), join(dir, "packages", name, "package.json"));
    cpSync(join(checkout, "packages", name, "src"), join(dir, "packages", name, "src"), { recursive: true });
  }
  mkdirSync(join(dir, "node_modules/@zcode"), { recursive: true });
  symlinkSync(dirname(realpathSync(Bun.resolveSync("zod/package.json", ROOT))), join(dir, "node_modules/zod"));
  symlinkSync(join(dir, "packages/session-control"), join(dir, "node_modules/@zcode/session-control"));
  symlinkSync(join(dir, "packages/model-option-map"), join(dir, "node_modules/@zcode/model-option-map"));
  return dir;
}

/** Drops `additionalProperties: false`, and refuses what the converter cannot carry. */
function relax(node: Json, where: string): Json {
  if (Array.isArray(node)) return node.map((item, index) => relax(item, `${where}[${index}]`));
  if (typeof node !== "object" || node === null) return node;
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") throw new Error(`${where}: a $ref (a recursive schema) is not carried by the converter`);
    if (key === "additionalProperties" && value === false) continue;
    if (key === "$schema") continue;
    // zod writes a discriminated union as `oneOf`, whose converter checks "exactly one" in a refinement
    // and types the value `unknown`. The members of such a union exclude each other already, so `anyOf` says the same.
    out[key === "oneOf" ? "anyOf" : key] = relax(value, `${where}.${key}`);
  }
  return out;
}

function toZod(schema: z.ZodType, where: string): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-7" }) as Json;
  const code = jsonSchemaToZod(relax(json, where) as never, { module: "none", zodVersion: 4 });
  return code.replaceAll("z.any()", "z.unknown()");
}

/** A discriminated union of objects, as the discriminator and the members by its value. */
function membersOf(schema: z.ZodType): { discriminator: string; members: Array<{ value: string; schema: z.ZodType }> } | undefined {
  const def = (schema as unknown as { _zod: { def: { type: string; discriminator?: string; options?: z.ZodType[] } } })._zod.def;
  if (def.type !== "union" || def.discriminator === undefined || def.options === undefined) return undefined;
  const discriminator = def.discriminator;
  const members = def.options.map((option) => {
    const shape = (option as unknown as { _zod: { def: { shape: Record<string, z.ZodType> } } })._zod.def.shape;
    const literal = shape[discriminator] as unknown as { _zod: { def: { values: unknown[] } } } | undefined;
    return { value: literal?._zod.def.values[0], schema: option };
  });
  // A union on a boolean (`ok`, `headersApplied`) stays one schema: its members have no name to take.
  const named = members.flatMap((member) => (typeof member.value === "string" ? [{ value: member.value, schema: member.schema }] : []));
  if (named.length !== members.length) return undefined;
  return { discriminator, members: named };
}

const pascal = (value: string): string => value.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, letter: string) => letter.toUpperCase());

interface Output {
  readonly lines: string[];
  readonly names: Set<string>;
}

function declare(out: Output, name: string, code: string): void {
  if (out.names.has(name)) throw new Error(`${name} is declared twice`);
  out.names.add(name);
  out.lines.push(`export const ${name}Schema = ${code};`, `export type ${name} = z.output<typeof ${name}Schema>;`, "");
}

/** A schema as a declaration; a union on a discriminator is a union of declared members, so each is a type of its own. */
function emit(out: Output, name: string, schema: z.ZodType): { discriminator: string; values: string[] } | undefined {
  const union = membersOf(schema);
  if (union === undefined) {
    declare(out, name, toZod(schema, name));
    return undefined;
  }
  const parts: string[] = [];
  for (const member of union.members) {
    const part = `${name}${pascal(member.value)}`;
    declare(out, part, toZod(member.schema, part));
    parts.push(`${part}Schema`);
  }
  declare(out, name, `z.discriminatedUnion(${JSON.stringify(union.discriminator)}, [${parts.join(", ")}])`);
  return { discriminator: union.discriminator, values: union.members.map((member) => member.value) };
}

const dir = stage();
try {
  const modules = {
    protocol: (await import(join(dir, "packages/shared/src/zcode-protocol/index.ts"))) as Record<string, unknown>,
    legacy: (await import(join(dir, "packages/shared/src/zcode-protocol-legacy-types.ts"))) as Record<string, unknown>,
    validation: (await import(join(dir, "packages/shared/src/validation.ts"))) as Record<string, unknown>,
    networkCapture: (await import(join(dir, "packages/shared/src/networkCapture.ts"))) as Record<string, unknown>,
  };
  const pick = (source: Source): z.ZodType => {
    const found = modules[source.module][source.name];
    if (!(found instanceof z.ZodType)) throw new Error(`${source.module} exports no schema ${source.name}`);
    return found;
  };

  // The snapshot must hold every notification and every request-family method it names.
  const methods = modules.protocol["zcodeProtocolMethods"] as Record<string, string>;
  const notifications = modules.protocol["zcodeProtocolNotifications"] as Record<string, string>;
  const knownRequests = new Set([...REQUESTS.map((request) => request.method), ...APP_CONTROL_INTENTS.map((intent) => `appControl/${intent}`)]);
  for (const method of Object.values(methods)) {
    if (REQUEST_FAMILY.test(method) && !knownRequests.has(method)) throw new Error(`the request ${method} is not in the generator's list`);
  }
  const knownNotifications = new Set(NOTIFICATIONS.map((notification) => notification.method));
  for (const method of Object.values(notifications)) {
    if (!knownNotifications.has(method)) throw new Error(`the notification ${method} is not in the generator's list`);
  }
  if (!knownNotifications.has(methods["sessionLifecycleChanged"] ?? "") || !knownNotifications.has(methods["computerUseOperationEvent"] ?? "")) {
    throw new Error("a notification the method table names is not in the generator's list");
  }

  const v4 = (await import(join(dir, "packages/shared/src/zcode-protocol-v4/transport.ts"))) as Record<string, unknown>;
  const v4Notifications = Object.values(v4["V4_NOTIFICATIONS"] as Record<string, string>);

  const out: Output = { lines: [], names: new Set() };
  const unions: Record<string, { discriminator: string; values: string[] }> = {};
  const notificationTable: string[] = [];
  for (const notification of NOTIFICATIONS) {
    const union = emit(out, `Notification${notification.id}`, pick(notification.schema));
    if (union !== undefined) unions[`Notification${notification.id}`] = union;
    notificationTable.push(`  ${JSON.stringify(notification.method)}: Notification${notification.id}Schema,`);
  }
  const requestTable: string[] = [];
  const answerTable: string[] = [];
  const requests = [
    ...REQUESTS,
    ...APP_CONTROL_INTENTS.map((intent) => {
      const contract = (modules.protocol["appControlProtocol"] as Record<string, { method: string; params: z.ZodType; result: z.ZodType }>)[intent];
      if (contract === undefined) throw new Error(`appControlProtocol has no ${intent}`);
      return { method: contract.method, id: `AppControl${pascal(intent)}`, params: contract.params, result: contract.result };
    }),
    {
      method: modules.protocol["appControlCancelMethod"] as string,
      id: "AppControlCancel",
      params: pick(protocol("appControlCancelParamsSchema")),
      result: pick(protocol("appControlCancelResultSchema")),
    },
  ];
  for (const request of requests) {
    const params = request.params instanceof z.ZodType ? request.params : pick(request.params);
    const result = request.result instanceof z.ZodType ? request.result : pick(request.result);
    emit(out, `Request${request.id}Params`, params);
    emit(out, `Request${request.id}Answer`, result);
    requestTable.push(`  ${JSON.stringify(request.method)}: Request${request.id}ParamsSchema,`);
    answerTable.push(`  ${JSON.stringify(request.method)}: Request${request.id}AnswerSchema,`);
  }
  for (const call of CALLS) emit(out, call.id, pick(call.schema));

  const sessionEvent = unions["NotificationSessionEvent"];
  if (sessionEvent === undefined) throw new Error("the session event is not a union on a discriminator");

  const commit = git("rev-parse", "HEAD");
  const subject = git("log", "-1", "--format=%s");
  const header = [
    "// GENERATED by scripts/gen-zcode.ts: do not edit. Regenerate with:",
    "//   bun scripts/gen-zcode.ts --zcode <ZCode checkout>",
    "//",
    `// Upstream: ZCode ${versionOf("package.json")} (apps/zcode-cli ${versionOf("apps/zcode-cli/package.json")}), commit ${commit} ("${subject}"),`,
    "// packages/shared/src/zcode-protocol (zod, converted with z.toJSONSchema, then json-schema-to-zod).",
    "// Objects are not strict (a field a newer ZCode adds is dropped, not a reason to lose the message);",
    "// What ZCode leaves open (z.unknown()) stays unknown, never any. Refinements and transforms are not carried.",
    "",
    'import { z } from "zod";',
    "",
  ];
  const tables = [
    "/** The notifications ZCode sends, by method: the schema of their params. */",
    "export const NOTIFICATION_SCHEMAS = {",
    ...notificationTable,
    "} as const;",
    "",
    "/** The requests ZCode makes of the client, by method: the schema of their params. */",
    "export const REQUEST_SCHEMAS = {",
    ...requestTable,
    "} as const;",
    "",
    "/** The requests ZCode makes of the client, by method: the schema of the answer it takes. */",
    "export const ANSWER_SCHEMAS = {",
    ...answerTable,
    "} as const;",
    "",
    "/** The types of the session event, by the discriminator the snapshot names. */",
    `export const SESSION_EVENT_TYPES = ${JSON.stringify(sessionEvent.values)} as const;`,
    "",
    "/** The notifications of ZCode's v4 side channel (the conversation view of its own desktop). They have no meaning for a session driver. */",
    `export const V4_NOTIFICATION_METHODS = ${JSON.stringify(v4Notifications)} as const;`,
    "",
  ];
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, [...header, ...out.lines, ...tables].join("\n"));
  console.log(`wrote ${OUT} (${out.names.size} schemas)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!existsSync(OUT)) throw new Error("nothing was written");
