/**
 * index.ts — the MCP server: a thin client of the core.
 *
 * It keeps no list of actions: tools are built from `describe()` on every list and every call.
 * The caller is the MCP session: one core client per session, opened with the session's id and
 * closed when the session ends. A tool argument that names somebody else is only an argument.
 */

import { createHash, randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { z } from "zod";

import { actionName, JsonSchemaValue, recordTypeName, seq } from "@niwa-labs/core";
import type { JsonSchema, Token } from "@niwa-labs/core";
import { HostError, withWorkingDirectory } from "@niwa-labs/client";
import { bind, type Binding, type SessionId } from "./bind.ts";
import {
  OPEN_QUESTIONS,
  SUBMIT_ANSWER,
  TASK_ASSIGNED,
  TASK_FINISH,
  catalogOf,
  withAssignedTasks,
  withOpenQuestions,
} from "./tools.ts";
import type { AssignedTask, OpenQuestion, Tool } from "./tools.ts";

export { catalogOf } from "./tools.ts";
export type { Catalog, Tool } from "./tools.ts";

/**
 * What the server tells an agent that connects: where the skill is, since the tools say what they
 * do and not how niwa is used. The harness shows it with the tools.
 */
export const INSTRUCTIONS = [
  "niwa is the owner's local agent host. How to use it: run `niwa skill` (prints the skill).",
  "To install the skill for yourself: `niwa skill install --harness <your harness kind>`.",
].join("\n");

/** The MCP surface of one home, serving one transport. */
export interface McpServer {
  readonly server: Server;
  connect(transport: Transport): Promise<void>;
  /** Close the server and the core client of its session. */
  close(): Promise<void>;
}

/** What the MCP server of one home is given. */
export interface McpServerOptions {
  readonly home: string;
  /** The actions the session may see; without it, every action. */
  readonly visible?: readonly string[];
  /**
   * The mark the server was given (`NIWA_SESSION_MARK`): it names the session the server serves,
   * so the tool that answers a question can carry the exact schema of its open questions.
   */
  readonly mark?: string;
  /** Who the server is: the token of the session it serves (`NIWA_ID`), else the owner's. */
  readonly token?: Token;
}

/** Build the MCP server of one home. */
export function createMcpServer(opts: McpServerOptions): McpServer {
  // A server serves one transport, so one connection: its fallback session id is its own.
  const connectionId = randomUUID();
  const bindings = new Map<SessionId, Promise<Binding>>();
  const server = new Server(
    { name: "niwa", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );

  const bindingOf = (sessionId: SessionId | undefined): Promise<Binding> => {
    const id = sessionId ?? connectionId;
    const known = bindings.get(id);
    if (known !== undefined) return known;
    const opened = bind({ home: opts.home, sessionId: id, ...(opts.token === undefined ? {} : { token: opts.token }) });
    bindings.set(id, opened);
    // A failed connect is not kept: the next call tries again.
    opened.catch(() => bindings.delete(id));
    return opened;
  };

  const closeBindings = async (): Promise<void> => {
    const open = [...bindings.values()];
    bindings.clear();
    for (const opened of open) {
      const binding = await opened.catch(() => undefined);
      await binding?.api.close();
    }
  };

  // The transport ending ends the session, whoever closed it.
  server.onclose = () => {
    closed = true;
    void watching?.return?.();
    void closeBindings().catch(() => undefined);
  };

  // The tools as the session sees them now, and the fingerprint of the last list the server
  // gave out or looked at: the harness caches `tools[]`, so it is told only when this changes.
  const shownTools = async (api: Binding["api"]) => {
    const { tools, actions } = catalogOf(await api.describe(), opts.visible);
    const shown = await exactFinishTool(api, await exactAnswerTool(api, tools, actions, opts.mark), actions);
    return shown.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
    }));
  };
  let lastShown: string | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const { api } = await bindingOf(extra.sessionId);
    const tools = await shownTools(api);
    lastShown = fingerprintOf(tools);
    return { tools };
  });

  // The tools of a session change with its open questions and with the registered workflows. When
  // the connection is up, the server follows the records that open, answer, cancel or expire a
  // request (and the one that pairs the mark with the session) and the ones that register or
  // recheck a workflow, recomputes the tools on each, and sends
  // `notifications/tools/list_changed` only when the fingerprint of the tools is not the last one.
  let watching: AsyncIterator<unknown> | undefined;
  let closed = false;
  const watch = async (): Promise<void> => {
    const { api } = await bindingOf(undefined);
    const relevant = new Set<string>(TOOL_RECORDS);
    // Where to follow from: the last such record that exists now. The baseline is read after it,
    // so a record that lands in between is only read twice, and the second read changes nothing.
    const past = await api.records.read({ types: TOOL_RECORDS });
    const from = past.at(-1)?.seq ?? seq(0);
    lastShown ??= fingerprintOf(await shownTools(api));
    const live = api.records.since({ from: from })[Symbol.asyncIterator]();
    watching = live;
    if (closed) return void live.return?.();
    for (let next = await live.next(); !next.done; next = await live.next()) {
      if (!relevant.has(next.value.type)) continue;
      const now = fingerprintOf(await shownTools(api));
      if (now === lastShown) continue;
      lastShown = now;
      await server.sendToolListChanged();
    }
  };
  server.oninitialized = () => {
    if (opts.mark === undefined) return;
    // A watch that fails leaves the server as it was: the harness still lists tools on connect.
    void watch().catch(() => undefined);
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const binding = await bindingOf(extra.sessionId);
    try {
      return answer(await callTool(binding, request.params.name, request.params.arguments ?? {}, opts.visible));
    } catch (error) {
      return { content: [{ type: "text", text: errorText(error) }], isError: true };
    }
  });

  return {
    server,
    connect: (transport) => server.connect(transport),
    async close(): Promise<void> {
      await server.close();
      await closeBindings();
    },
  };
}

/**
 * The tools, with the one that answers a question carrying the exact schema of the open
 * questions of the session the server serves.
 *
 * A server with no mark, a session with no open question, or a host that cannot say (no
 * sessions module) shows the tool as the action declares it.
 */
async function exactAnswerTool(
  api: Binding["api"],
  tools: readonly Tool[],
  actions: ReadonlyMap<string, string>,
  mark: string | undefined,
): Promise<Tool[]> {
  const index = tools.findIndex((tool) => actions.get(tool.name) === SUBMIT_ANSWER);
  if (mark === undefined || index === -1) return [...tools];
  let questions: OpenQuestion[];
  try {
    const listed = OpenQuestionsOutput.parse(await api.call(actionName(OPEN_QUESTIONS), { mark }));
    questions = listed.questions;
  } catch {
    return [...tools];
  }
  return tools.map((tool, at) => (at === index ? withOpenQuestions(tool, questions) : tool));
}

/**
 * The tools of a session change with its open questions and with the tasks it owes a result for:
 * these are the records that open or close either, or say which session a mark names.
 */
const QUESTION_RECORDS = [
  "session.marked",
  "request.created",
  "request.answered",
  "request.cancelled",
  "request.expired",
  "task.created",
  "task.done",
].map(recordTypeName);

/** The records that add or change a workflow, which is the tool `flow_<id>`. */
const CATALOG_RECORDS = ["workflow.registered", "workflow.rechecked"].map(recordTypeName);

/** Every record after which the tools may be other than they were. */
const TOOL_RECORDS = [...QUESTION_RECORDS, ...CATALOG_RECORDS];

/** A short hash of the tools as they are listed: equal when no schema, name or description moved. */
function fingerprintOf(tools: unknown): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

/**
 * The tools, with the one that finishes a task carrying the exact result schema of the open tasks
 * the caller is responsible for.
 *
 * A caller that is not shown `task.finish` or `task.assigned`, a caller that owes no result, and a host
 * that cannot say (no tasks module) all get the tool as the action declares it.
 */
async function exactFinishTool(
  api: Binding["api"],
  tools: readonly Tool[],
  actions: ReadonlyMap<string, string>,
): Promise<Tool[]> {
  const index = tools.findIndex((tool) => actions.get(tool.name) === TASK_FINISH);
  // The caller asks only what it may see: a session that was not shown `task.assigned` is not made to be denied it.
  if (index === -1 || ![...actions.values()].includes(TASK_ASSIGNED)) return [...tools];
  let tasks: AssignedTask[];
  try {
    tasks = AssignedTasksOutput.parse(await api.call(actionName(TASK_ASSIGNED), {})).tasks;
  } catch {
    return [...tools];
  }
  return tools.map((tool, at) => (at === index ? withAssignedTasks(tool, tasks) : tool));
}

/** What `task.assigned` answers, as this surface reads it. */
const AssignedTasksOutput = z.object({
  tasks: z.array(
    z.object({ task: z.string().min(1), description: z.string(), result: JsonSchemaValue }),
  ),
});

/** What `session.open-questions` answers, as this surface reads it. */
const OpenQuestionsOutput = z.object({
  questions: z.array(z.object({ request: z.string().min(1), schema: JsonSchemaValue })),
});

function errorText(error: unknown): string {
  // A refusal by a grant says whose grant and which rule is missing, so the agent can ask for it.
  if (error instanceof HostError && error.denied !== undefined) {
    return `${error.message}\n${JSON.stringify({ denied: { grant: error.denied.grant, missing: error.denied.missing } })}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function answer(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }] };
}

/** Run one tool for the session of `binding`; throws when the call fails. */
async function callTool(
  binding: Binding,
  name: string,
  args: Record<string, unknown>,
  visible: readonly string[] | undefined,
): Promise<unknown> {
  const { api } = binding;
  const catalog = catalogOf(await api.describe(), visible);
  // A tool the session may not see is not a tool at all: the call is refused by name.
  if (!catalog.tools.some((tool) => tool.name === name)) {
    throw new Error(`there is no tool "${name}"`);
  }
  const action = catalog.actions.get(name);
  if (action === undefined) throw new Error(`there is no tool "${name}"`);
  // The session works where its server was started: an action that takes a directory is told so when the model names none.
  const input = catalog.tools.find((tool) => tool.name === name)?.inputSchema;
  return api.call(action, withWorkingDirectory(input as JsonSchema | undefined, args));
}

/** Run the MCP server of one home over stdio. */
export async function serveMcp(opts: McpServerOptions): Promise<McpServer> {
  const mcp = createMcpServer(opts);
  await mcp.connect(new StdioServerTransport());
  return mcp;
}
