/**
 * One content block of every type the Messages API names, as Claude Code writes them in its log and
 * the Agent SDK carries them. The table is keyed by the type, so a type the API adds fails to compile
 * here until it has a fixture. The advisor blocks are real ones (the sealed content cut short).
 */

import type { BlockType } from "../../src/code/format.ts";

export const ADVISOR_CALL = "srvtoolu_01G1aJqE7cuA8AmgJJv6pBx3";

export const BLOCKS: { readonly [K in BlockType]: { readonly type: K } & Record<string, unknown> } = {
  text: { type: "text", text: "hello" },
  image: { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
  document: { type: "document", source: { type: "text", media_type: "text/plain", data: "a page" } },
  search_result: { type: "search_result", source: "https://example.org", title: "t", content: [] },
  thinking: { type: "thinking", thinking: "let me see", signature: "sig" },
  redacted_thinking: { type: "redacted_thinking", data: "sealed" },
  tool_use: { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } },
  server_tool_use: { type: "server_tool_use", id: ADVISOR_CALL, name: "advisor", input: {} },
  mcp_tool_use: { type: "mcp_tool_use", id: "mcptoolu_1", name: "lookup", server_name: "kb", input: { q: "x" } },
  tool_result: { type: "tool_result", tool_use_id: "toolu_1", content: "file text", is_error: false },
  mcp_tool_result: { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: "found", is_error: true },
  advisor_tool_result: {
    type: "advisor_tool_result",
    tool_use_id: ADVISOR_CALL,
    content: { type: "advisor_redacted_result", encrypted_content: "EpEiCioIFBgCIiQ0NzFk" },
  },
  web_search_tool_result: { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws", content: [] },
  web_fetch_tool_result: {
    type: "web_fetch_tool_result",
    tool_use_id: "srvtoolu_wf",
    content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
  },
  code_execution_tool_result: {
    type: "code_execution_tool_result",
    tool_use_id: "srvtoolu_ce",
    content: { type: "code_execution_result", stdout: "1", stderr: "", return_code: 0, content: [] },
  },
  bash_code_execution_tool_result: {
    type: "bash_code_execution_tool_result",
    tool_use_id: "srvtoolu_bash",
    content: { type: "bash_code_execution_result", stdout: "", stderr: "", return_code: 0, content: [] },
  },
  text_editor_code_execution_tool_result: {
    type: "text_editor_code_execution_tool_result",
    tool_use_id: "srvtoolu_te",
    content: { type: "text_editor_code_execution_view_result", content: "x", file_type: "text" },
  },
  tool_search_tool_result: {
    type: "tool_search_tool_result",
    tool_use_id: "srvtoolu_ts",
    content: { type: "tool_search_tool_search_result", tool_references: [] },
  },
  container_upload: { type: "container_upload", file_id: "file_1" },
  compaction: { type: "compaction", content: "what came before", encrypted_content: null },
  fallback: { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal" } },
  mcp_tool_listing: { type: "mcp_tool_listing", mcp_server_name: "kb", tools: [] },
};
