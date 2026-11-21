/**
 * How the control side refuses a request of `codex app-server` that nobody can be asked about.
 *
 * Codex is always answered: unanswered, its turn waits forever. A session that has nobody to ask
 * gets each request refused in the words Codex takes for a refusal, and so does a request whose
 * parameters this build does not read. A request that has no answer niwa can give is answered with
 * a JSON-RPC error. A session in `full` mode is never asked, so only `ask` and `auto` sessions get
 * here, and only to leave their sandbox.
 */

import type {
  ApplyPatchApprovalResponse,
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallResponse,
  ExecCommandApprovalResponse,
  FileChangeRequestApprovalResponse,
  JSONRPCErrorError,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse,
  ServerRequest,
  ToolRequestUserInputResponse,
} from "./protocol/generated/app-server.ts";

/** The method not found: what JSON-RPC says of a request that is not served. */
const METHOD_NOT_FOUND = -32601;

/** What goes back to Codex: the result it takes, or an error. */
export type Reply =
  | {
      readonly result:
        | CommandExecutionRequestApprovalResponse
        | FileChangeRequestApprovalResponse
        | PermissionsRequestApprovalResponse
        | ToolRequestUserInputResponse
        | McpServerElicitationRequestResponse
        | DynamicToolCallResponse
        | ApplyPatchApprovalResponse
        | ExecCommandApprovalResponse;
    }
  | { readonly error: JSONRPCErrorError };

function cannotServe(method: string): Reply {
  return { error: { code: METHOD_NOT_FOUND, message: `this control side cannot serve ${method}` } };
}

/** The refusal of each request Codex makes: one for every method, or it does not compile. */
const REFUSALS: { readonly [Method in ServerRequest["method"]]: Reply } = {
  "item/commandExecution/requestApproval": { result: { decision: "decline" } },
  "item/fileChange/requestApproval": { result: { decision: "decline" } },
  // Nothing is granted, and what was not granted is not granted for the turn.
  "item/permissions/requestApproval": { result: { permissions: {}, scope: "turn" } },
  "item/tool/requestUserInput": { result: { answers: {} } },
  // niwa gives a session its tools as MCP servers; it serves no dynamic tool of its own.
  "item/tool/call": { result: { contentItems: [], success: false } },
  // An elicitation niwa cannot ask a person (a link to open, a form of OpenAI's own kind), and one of a session with nobody to ask: declined.
  "mcpServer/elicitation/request": { result: { action: "decline", content: null, _meta: null } },
  // The requests of the older protocol, for the clients that speak it: the same refusal in its words.
  applyPatchApproval: { result: { decision: { denied: { rejection: "niwa asks nobody to approve a patch here" } } } },
  execCommandApproval: { result: { decision: { denied: { rejection: "niwa asks nobody to approve a command here" } } } },
  // niwa holds no sign-in of Codex's and attests nothing: there is no answer to give.
  "account/chatgptAuthTokens/refresh": cannotServe("account/chatgptAuthTokens/refresh"),
  "attestation/generate": cannotServe("attestation/generate"),
};

function isKnown(method: string): method is ServerRequest["method"] {
  return Object.hasOwn(REFUSALS, method);
}

/** The reply that refuses a request, whether or not the method is one the schemas know. */
export function refusalOf(method: string): Reply {
  return isKnown(method) ? REFUSALS[method] : cannotServe(method);
}
