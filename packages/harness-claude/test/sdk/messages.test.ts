// The messages of the Claude Agent SDK as signs of life: one fixture per message type, `system`
// subtype, streaming event and content block, each through the mapping; the advisor is its own
// sign; a message or block newer than the snapshot is an unknown variant, never a crash.

import { expect, test } from "bun:test";

import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import { LifeEventSchema, ProtocolNameSchema, VariantNameSchema } from "@niwa-labs/harness";
import type { LifeEvent } from "@niwa-labs/harness";
import type { BlockType } from "../../src/code/format.ts";
import { signsOf } from "../../src/sdk/messages.ts";

import { ADVISOR_CALL, BLOCKS } from "../code/blocks.ts";

const AT = 1_000;
const BASE = { uuid: "00000000-0000-4000-8000-000000000000", session_id: "s1" };

type SystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];
type OtherType = Exclude<SDKMessage["type"], "system" | "stream_event" | "assistant">;
type StreamEventType = SDKPartialAssistantMessage["event"]["type"];

/** A message as it comes off the wire: parsed JSON, which the SDK types and does not check. */
function wire(value: object): SDKMessage {
  return JSON.parse(JSON.stringify({ ...BASE, ...value }));
}

function assistant(content: readonly object[], iterations: readonly object[] = []): SDKMessage {
  return wire({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, usage: { iterations } },
  });
}

/** The signs of a variant the snapshot does not have: the unknown, and an activity, so that it is still a sign of life. */
function unknownSigns(variant: string, raw: unknown): LifeEvent[] {
  return [
    {
      kind: "unknown-variant",
      at: AT,
      protocol: ProtocolNameSchema.parse("claude-agent-sdk"),
      variant: VariantNameSchema.parse(variant),
      raw: JSON.parse(JSON.stringify(raw)),
    },
    { kind: "activity", at: AT, detail: variant },
  ];
}

function signs(message: SDKMessage): LifeEvent[] {
  const out = signsOf(message, AT);
  for (const sign of out) expect(LifeEventSchema.safeParse(sign).success).toBe(true);
  return out;
}

const detailOf = (sign: LifeEvent | undefined): string | undefined =>
  sign?.kind === "activity" ? sign.detail : sign?.kind;

const SYSTEM: { readonly [K in SystemSubtype]: object } = {
  init: { model: "haiku", tools: [] },
  compact_boundary: { compact_metadata: { trigger: "auto", pre_tokens: 1 } },
  status: { status: "compacting" },
  api_retry: { attempt: 1 },
  control_request_progress: {},
  model_refusal_fallback: {},
  model_refusal_no_fallback: {},
  local_command_output: { content: "out" },
  hook_started: { hook_id: "h" },
  hook_progress: { hook_id: "h" },
  hook_response: { hook_id: "h" },
  plugin_install: {},
  task_notification: { task_id: "t" },
  task_started: { task_id: "t" },
  task_updated: { task_id: "t" },
  task_progress: { task_id: "t" },
  background_tasks_changed: {},
  thinking_tokens: {},
  session_state_changed: { state: "idle" },
  worker_shutting_down: {},
  commands_changed: {},
  notification: {},
  files_persisted: {},
  memory_recall: {},
  elicitation_complete: {},
  permission_denied: { tool_name: "Bash", tool_use_id: "toolu_1", decision_reason_type: "classifier", message: "no" },
  mirror_error: {},
  informational: {},
  session_writes_lost: {},
};

test("every system subtype is a sign of life; a denial the harness made by itself carries its mark", () => {
  for (const [subtype, fields] of Object.entries(SYSTEM)) {
    const [sign] = signs(wire({ type: "system", subtype, ...fields }));
    expect(detailOf(sign)).toBe(`system:${subtype}`);
  }
  const [denied] = signs(wire({ type: "system", subtype: "permission_denied", ...SYSTEM.permission_denied }));
  expect(denied).toEqual({
    kind: "activity",
    at: AT,
    detail: "system:permission_denied",
    permission: { decision: "deny", decidedBy: "claude", ruleKind: "classifier" },
  });
});

const OTHER: { readonly [K in OtherType]: { readonly fields: object; readonly detail: string } } = {
  user: { fields: { parent_tool_use_id: null, message: { role: "user", content: "hi" } }, detail: "user" },
  result: { fields: { subtype: "success", is_error: false, result: "ok" }, detail: "result:success" },
  tool_progress: { fields: { tool_use_id: "toolu_1", tool_name: "Bash" }, detail: "tool_progress" },
  tool_use_summary: { fields: { summary: "read a file" }, detail: "tool_use_summary" },
  auth_status: { fields: { isAuthenticating: false, output: [] }, detail: "auth_status" },
  rate_limit_event: { fields: { rate_limit_info: {} }, detail: "rate_limit_event" },
  prompt_suggestion: { fields: { suggestion: "next" }, detail: "prompt_suggestion" },
  conversation_reset: { fields: { new_conversation_id: BASE.uuid }, detail: "conversation_reset" },
};

test("every other message type is a sign of life", () => {
  for (const [type, { fields, detail }] of Object.entries(OTHER)) {
    expect(detailOf(signs(wire({ type, ...fields }))[0])).toBe(detail);
  }
});

const STREAM: { readonly [K in StreamEventType]: object } = {
  message_start: { message: {} },
  message_delta: { delta: {}, usage: {} },
  message_stop: {},
  content_block_start: { index: 0, content_block: BLOCKS.server_tool_use },
  content_block_delta: { index: 0, delta: { type: "text_delta", text: "a" } },
  content_block_stop: { index: 0 },
};

test("every streaming event is a sign of life, and never an advisor sign: the whole block comes again", () => {
  for (const [type, fields] of Object.entries(STREAM)) {
    const [sign] = signs(wire({ type: "stream_event", parent_tool_use_id: null, event: { type, ...fields } }));
    expect(detailOf(sign)).toBe(`stream_event:${type}`);
  }
});

const EXPECTED: { readonly [K in BlockType]: string } = {
  text: "text",
  image: "image",
  document: "document",
  search_result: "search_result",
  thinking: "thinking",
  redacted_thinking: "redacted_thinking",
  tool_use: "tool_use:Read",
  server_tool_use: "advisor",
  mcp_tool_use: "mcp_tool_use:lookup",
  tool_result: "tool_result",
  mcp_tool_result: "mcp_tool_result",
  advisor_tool_result: "advisor",
  web_search_tool_result: "web_search_tool_result",
  web_fetch_tool_result: "web_fetch_tool_result",
  code_execution_tool_result: "code_execution_tool_result",
  bash_code_execution_tool_result: "bash_code_execution_tool_result",
  text_editor_code_execution_tool_result: "text_editor_code_execution_tool_result",
  tool_search_tool_result: "tool_search_tool_result",
  container_upload: "container_upload",
  compaction: "compaction",
  fallback: "fallback",
  mcp_tool_listing: "mcp_tool_listing",
};

test("every content block of an answer has its sign", () => {
  for (const block of Object.values(BLOCKS)) {
    expect(detailOf(signs(assistant([block]))[0])).toBe(EXPECTED[block.type]);
  }
  expect(detailOf(signs(assistant([]))[0])).toBe("assistant");
  expect(detailOf(signs(assistant([{ type: "server_tool_use", id: "srvtoolu_ws", name: "web_search", input: {} }]))[0])).toBe(
    "server_tool_use:web_search",
  );
});

test("the advisor is its own sign: started at its call, finished with the kind of its answer and its model", () => {
  expect(signs(assistant([BLOCKS.server_tool_use]))).toEqual([
    { kind: "advisor", at: AT, phase: "started", callId: ADVISOR_CALL },
  ]);
  const usage = [
    { type: "message", model: null },
    { type: "advisor_message", model: "claude-fable-5-1" },
  ];
  expect(signs(assistant([BLOCKS.advisor_tool_result], usage))).toEqual([
    { kind: "advisor", at: AT, phase: "finished", callId: ADVISOR_CALL, model: "claude-fable-5-1", result: "redacted" },
  ]);
  const text = { ...BLOCKS.advisor_tool_result, content: { type: "advisor_result", text: "looks fine", stop_reason: null } };
  expect(signs(assistant([text]))[0]).toMatchObject({ phase: "finished", result: "text" });
  // A code the API's own list does not have yet: the harness writes it, and it is kept.
  const failed = {
    ...BLOCKS.advisor_tool_result,
    content: { type: "advisor_tool_result_error", error_code: "fable_advisor_temporarily_disabled" },
  };
  expect(signs(assistant([failed]))[0]).toEqual({
    kind: "advisor",
    at: AT,
    phase: "finished",
    callId: ADVISOR_CALL,
    result: "error",
    errorCode: "fable_advisor_temporarily_disabled",
  });
});

test("a message, a subtype, an event or a block newer than the snapshot is an unknown variant with its raw data", () => {
  const message = wire({ type: "brand_new", detail: 1 });
  expect(signs(message)).toEqual(unknownSigns("brand_new", message));
  expect(signs(wire({ type: "system", subtype: "brand_new" }))[0]).toMatchObject({
    kind: "unknown-variant",
    variant: "system:brand_new",
  });
  expect(
    signs(wire({ type: "stream_event", parent_tool_use_id: null, event: { type: "brand_new" } }))[0],
  ).toMatchObject({ kind: "unknown-variant", variant: "stream_event:brand_new" });
  const block = { type: "brand_new_block", payload: 1 };
  expect(signs(assistant([block]))).toEqual(unknownSigns("content_block:brand_new_block", block));
});
