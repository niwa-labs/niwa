/**
 * What Codex asks its client in the middle of a turn, as niwa's common questions.
 *
 * `codex app-server` makes five requests that wait for a person: the approval of a command, of a
 * file change and of extra permissions, `item/tool/requestUserInput`, and `mcpServer/elicitation/request`,
 * which is where Codex asks leave to call a tool of an MCP server and where a server asks for a form to be filled.
 * This module turns each into a `Question` and turns the answer back into the reply Codex takes. It never talks to
 * the process: the control side sends and receives.
 *
 * Codex has more words for a decision than niwa has: "accept for the session", an exec-policy or a
 * network-policy amendment, a permission granted for the session. None of them is ever sent: an
 * approval is `accept`, `decline` or `cancel`, and a permission is granted for the turn. "Always" is
 * niwa's own memory.
 */

import { assertNever, JsonSchemaValue, OptionIdSchema, pickedOptions, stableJson } from "@niwa-labs/core";
import type { Answer, Question, QuestionOption } from "@niwa-labs/core";

import type {
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse,
  ServerRequest,
  ToolRequestUserInputParams,
} from "./protocol/generated/app-server.ts";

/** The approvals of Codex: of a command, of a file change, of extra permissions. */
export type ApprovalRequest = Extract<
  ServerRequest,
  {
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval"
      | "item/permissions/requestApproval";
  }
>;

/** The elicitation of an MCP server: the approval of one of its tools, or a form it wants filled. */
export type ElicitationRequest = Extract<ServerRequest, { method: "mcpServer/elicitation/request" }>;

/** The requests niwa routes to the one who started the session: the approvals and the questions. */
export type ReversedRequest =
  | ApprovalRequest
  | ElicitationRequest
  | Extract<ServerRequest, { method: "item/tool/requestUserInput" }>;

/** How much of the request is carried in a question's detail; the whole of it is kept in `raw`. */
const DETAIL_CHARS = 500;

/** What Codex is told of an approval: `cancel` also interrupts the turn. */
type Decision = "accept" | "decline" | "cancel";

/** The two options of an approval: the once-only ones Codex has, under its own words for them. */
const OPTIONS: readonly QuestionOption[] = [
  { id: OptionIdSchema.parse("accept"), label: "Allow once", flavor: "allow_once" },
  { id: OptionIdSchema.parse("decline"), label: "Decline", flavor: "reject_once" },
];

/** An approval of Codex: the question for the starter, and the reply Codex takes for each answer. */
export interface Approval {
  readonly question: Question;
  reply(answer: Answer): CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse | PermissionsRequestApprovalResponse;
}

function decisionOf(question: Question, answer: Answer): Decision {
  const picked = pickedOptions(question, answer)[0];
  if (picked?.flavor === "allow_once") return "accept";
  if (picked?.flavor === "reject_once") return "decline";
  return "cancel";
}

function lines(...parts: ReadonlyArray<string | null | undefined>): string | undefined {
  const given = parts.filter((part): part is string => part !== null && part !== undefined && part !== "");
  return given.length === 0 ? undefined : given.join("\n");
}

/**
 * The approval a request of Codex is. `changed` are the paths of the file change the request is
 * about, as Codex announced the item: the request itself names none.
 */
export function approvalOf(request: ApprovalRequest, changed: readonly string[] | undefined): Approval {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const { command, cwd, reason, networkApprovalContext: network, approvalId, itemId } = request.params;
      const host = network == null ? undefined : `${network.protocol}://${network.host}`;
      const target = command == null ? undefined : (lines(cwd, command) ?? command);
      const title = command ?? (host === undefined ? "Run a command" : `Network access: ${host}`);
      const detail = lines(reason, cwd == null ? undefined : `in ${cwd}`);
      const question: Question = {
        kind: "permission",
        title,
        ...(detail === undefined ? {} : { detail }),
        options: [...OPTIONS],
        subject: {
          tool: "commandExecution",
          kind: command == null && host !== undefined ? "network" : "execute",
          target: target ?? host ?? approvalId ?? itemId,
        },
      };
      return { question, reply: (answer) => ({ decision: decisionOf(question, answer) }) };
    }
    case "item/fileChange/requestApproval": {
      const { reason, grantRoot, itemId } = request.params;
      const paths = [...(changed ?? []), ...(grantRoot === null || grantRoot === undefined ? [] : [`root ${grantRoot}`])];
      const question: Question = {
        kind: "permission",
        title: paths.length === 0 ? "Change files" : `Change files: ${paths.join(", ")}`,
        ...(reason == null || reason === "" ? {} : { detail: reason }),
        options: [...OPTIONS],
        subject: { tool: "fileChange", kind: "edit", target: paths.length === 0 ? itemId : paths.join("\n") },
      };
      return { question, reply: (answer) => ({ decision: decisionOf(question, answer) }) };
    }
    case "item/permissions/requestApproval": {
      const { network, fileSystem } = request.params.permissions;
      const granted = {
        ...(network == null ? {} : { network }),
        ...(fileSystem == null ? {} : { fileSystem }),
      };
      const asked = stableJson(granted);
      const question: Question = {
        kind: "permission",
        title: "Extra permissions",
        detail: lines(request.params.reason, asked.slice(0, DETAIL_CHARS)) ?? asked,
        options: [...OPTIONS],
        subject: { tool: "permissions", kind: "permissions", target: asked },
      };
      // Granted for the turn: the "session" scope is Codex's own "always".
      return {
        question,
        reply: (answer) => ({ permissions: decisionOf(question, answer) === "accept" ? granted : {}, scope: "turn" }),
      };
    }
    default:
      return assertNever(request, "codex approval request");
  }
}

/** One question of a `requestUserInput` call, as Codex names it and as niwa asks it. */
export interface UserQuestion {
  readonly id: string;
  readonly question: Question;
}

/** The questions of a `requestUserInput` call. */
export function userQuestionsOf(params: ToolRequestUserInputParams): readonly UserQuestion[] {
  return params.questions.map((asked) => {
    const title = asked.question !== "" ? asked.question : asked.header !== "" ? asked.header : "A question";
    const detail = asked.header !== "" && asked.header !== title ? { detail: asked.header } : {};
    const offered = asked.options ?? [];
    if (offered.length === 0) return { id: asked.id, question: { kind: "text", title, ...detail } };
    const options: QuestionOption[] = offered.map((option, index) => ({
      id: OptionIdSchema.parse(`option-${index + 1}`),
      label: option.label,
      ...(option.description === "" ? {} : { description: option.description }),
      flavor: "plain",
    }));
    return { id: asked.id, question: { kind: "choice", title, ...detail, options, allowOther: asked.isOther } };
  });
}

/** What Codex takes as the answer to one question: the labels picked or the words given; none when it went unanswered. */
export function userAnswerOf(question: Question, answer: Answer): string[] | undefined {
  if ("text" in answer) return [answer.text];
  if ("ids" in answer) return pickedOptions(question, answer).map((option) => option.label);
  return undefined;
}

/** What Codex puts in the `_meta` of the elicitation that asks leave to call an MCP tool. */
const TOOL_APPROVAL_KIND = "mcp_tool_call";

/** A member of the `_meta` of an elicitation, when it is there. */
function metaOf(params: McpServerElicitationRequestParams, key: string): unknown {
  const meta = params._meta;
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta[key] : undefined;
}

/**
 * The tool an approval asks leave for: Codex names it in `_meta.tool_name`
 * (codex-rs/protocol/src/mcp_approval_meta.rs); the server is the request's `serverName`.
 */
function toolOfApproval(params: McpServerElicitationRequestParams): string | undefined {
  const name = metaOf(params, "tool_name");
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** A JSON value without its nulls: Codex writes an absent member of a schema as `null`, which no schema reads. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== null)
      .map(([key, member]) => [key, withoutNulls(member)]),
  );
}

/** An elicitation of an MCP server: the question for the starter, and the reply Codex takes for each answer. */
export interface Elicitation {
  readonly question: Question;
  reply(answer: Answer): McpServerElicitationRequestResponse;
}

function elicitationReply(action: McpServerElicitationRequestResponse["action"], content: McpServerElicitationRequestResponse["content"]): McpServerElicitationRequestResponse {
  return { action, content: content ?? null, _meta: null };
}

/**
 * The elicitation an MCP server's request is, or `undefined` for one niwa cannot ask a person (a link to open, a form of
 * OpenAI's own kind): those stay declined.
 *
 * Leave to call a tool is a `permission` question under the tool's name as an MCP tool is named everywhere
 * (`mcp__<server>__<tool>`), with the once-only options; "always" (Codex's `persist`) is never sent. A form is a `form`
 * question, answered by its value; there is no declining a form, so a cancelled answer is Codex's `cancel`.
 */
export function elicitationOf(request: ElicitationRequest): Elicitation | undefined {
  const { params } = request;
  if (params.mode !== "form") return undefined;
  if (metaOf(params, "codex_approval_kind") === TOOL_APPROVAL_KIND) {
    const name = toolOfApproval(params);
    if (name === undefined) return undefined;
    const tool = `mcp__${params.serverName}__${name}`;
    const given = metaOf(params, "tool_params");
    const asked = given === undefined ? undefined : stableJson(given);
    const question: Question = {
      kind: "permission",
      title: params.message,
      ...(asked === undefined ? {} : { detail: asked.slice(0, DETAIL_CHARS) }),
      options: [...OPTIONS],
      subject: { tool, kind: "mcp", target: asked === undefined ? tool : `${tool}\n${asked}` },
    };
    return { question, reply: (answer) => elicitationReply(decisionOf(question, answer), null) };
  }
  const schema = JsonSchemaValue.safeParse(withoutNulls(params.requestedSchema));
  if (!schema.success) return undefined;
  const question: Question = { kind: "form", title: params.message, schema: schema.data };
  return {
    question,
    reply: (answer) => ("form" in answer ? elicitationReply("accept", answer.form) : elicitationReply("cancel", null)),
  };
}
