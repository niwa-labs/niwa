/**
 * Fixtures of pi's protocol, one for each variant of each discriminator.
 *
 * Lines of session files are REAL: copied (trimmed) from sessions that pi 1.5.x wrote. The RPC
 * frames could not be captured, the installed pi being broken and its source having no dependencies
 * installed here, so they are BUILT from the types of pi 1.5.2 (`rpc-types.ts`, `agent-session.ts`,
 * `json-event.ts`) and the literals in its docs; each carries the fields its type requires.
 */

const USAGE = {
  input: 829,
  output: 38,
  cacheRead: 58264,
  cacheWrite: 0,
  reasoning: 8,
  totalTokens: 59131,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ASSISTANT = {
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  api: "openai-completions",
  provider: "bifrost",
  model: "agnes/agnes-2.5-flash",
  usage: USAGE,
  stopReason: "stop",
  timestamp: 1786488979017,
};
const TOOL_CALL = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } };
const TOOL_RESULT = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "bash",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 1788375174463,
};
const USER = { role: "user", content: [{ type: "text", text: "?" }], timestamp: 1782074194588 };

/** One message of each role, by role. */
export const MESSAGE_FIXTURES: Record<string, object> = {
  system: { role: "system", content: "", sections: { preamble: "be brief" }, timestamp: 1791071374723 },
  user: USER,
  assistant: ASSISTANT,
  toolResult: TOOL_RESULT,
  bashExecution: {
    role: "bashExecution",
    command: "ls",
    output: "a",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  },
  custom: { role: "custom", customType: "note", content: "text", display: true, timestamp: 2 },
  branchSummary: { role: "branchSummary", summary: "left", fromId: "e1", timestamp: 3 },
  compactionSummary: { role: "compactionSummary", summary: "so far", tokensBefore: 100, timestamp: 4 },
};

/** One entry of each type of a session file, by type. The ones marked REAL were written by pi. */
export const ENTRY_FIXTURES: Record<string, object> = {
  // REAL
  session: { type: "session", version: 3, id: "c8a5af38-21fa-437d-ab24-31690d683002", timestamp: "2026-09-08T03:50:14.587Z", cwd: "/private/tmp" },
  // REAL
  model_change: { type: "model_change", id: "3bb1cbbc", parentId: null, timestamp: "2026-09-03T08:35:15.184Z", provider: "bifrost", modelId: "kimi/k3" },
  // REAL
  thinking_level_change: { type: "thinking_level_change", id: "87bdec70", parentId: "4bd64e6a", timestamp: "2026-07-22T04:04:23.118Z", thinkingLevel: "off" },
  message: {
    type: "message",
    id: "cac44bb1",
    parentId: "dcfc5264",
    timestamp: "2026-06-21T20:36:34.588Z",
    message: USER,
  },
  usage: {
    type: "usage",
    id: "u1",
    parentId: "cac44bb1",
    timestamp: "2026-06-21T20:36:35.000Z",
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude",
    usage: USAGE,
    note: "warmed",
  },
  compaction: {
    type: "compaction",
    id: "k1",
    parentId: "cac44bb1",
    timestamp: "2026-06-21T20:40:00.000Z",
    summary: "what happened so far",
    firstKeptEntryId: "cac44bb1",
    tokensBefore: 1200,
  },
  branch_summary: {
    type: "branch_summary",
    id: "b1",
    parentId: "cac44bb1",
    timestamp: "2026-06-21T20:41:00.000Z",
    fromId: "cac44bb1",
    summary: "the branch that was left",
  },
  // REAL
  custom: { type: "custom", customType: "intercom_sent", data: { to: "12baf91f", message: { text: "hello" } }, id: "4e7520a5", parentId: "a5c8bf01", timestamp: "2026-08-23T00:54:05.327Z" },
  // REAL
  custom_message: { type: "custom_message", customType: "subagent-notify", content: "Background task failed", display: true, id: "b9474288", parentId: "baa673f3", timestamp: "2026-08-16T21:39:13.245Z" },
  // REAL
  context_edit: { type: "context_edit", id: "f4af2b49", parentId: "317cbe52", timestamp: "2026-10-01T17:08:35.234Z", targetId: "317cbe52", replacement: null },
  label: { type: "label", id: "l1", parentId: "cac44bb1", timestamp: "2026-06-21T20:42:00.000Z", targetId: "cac44bb1", label: "keep" },
  // REAL
  session_info: { type: "session_info", id: "d4c1989e", parentId: null, timestamp: "2026-08-30T14:26:07.961Z", name: "Niwa GLM queue A" },
};

/** A real message line each, by what it holds; the shapes real files have that the type doc does not spell out. */
export const REAL_MESSAGE_LINES: Record<string, string> = {
  user: '{"type":"message","id":"cac44bb1","parentId":"dcfc5264","timestamp":"2026-06-21T20:36:34.588Z","message":{"role":"user","content":[{"type":"text","text":"?"}],"timestamp":1782074194588}}',
  toolResult:
    '{"type":"message","id":"347e04d8","parentId":"bdbbf178","timestamp":"2026-09-02T18:52:54.463Z","message":{"role":"toolResult","toolCallId":"call_8322cb63e06cf0ed","toolName":"read","content":[{"type":"text","text":""}],"isError":false,"timestamp":1788375174463}}',
  assistantTextToolCall:
    '{"type":"message","id":"1f86a031","parentId":"f050b38a","timestamp":"2026-07-07T14:31:55.597Z","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll wait about 25 seconds before replying."},{"type":"toolCall","id":"call_function_muiblx5o48r7_1","name":"bash","arguments":{"command":"sleep 25"}}],"api":"openai-completions","provider":"bifrost","model":"minimax/MiniMax-M3","usage":{"input":10834,"output":36,"cacheRead":114,"cacheWrite":0,"reasoning":0,"totalTokens":10984,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1783434712930,"responseId":"069c40d9ad6dfb1bd54e281240eafb16","responseModel":"MiniMax-M3"}}',
  assistantThinkingText:
    '{"type":"message","id":"2a3cdad6","parentId":"d20c1452","timestamp":"2026-08-11T22:56:20.347Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants me to reply with exactly PI_AGNES_OK.\\n","thinkingSignature":"reasoning"},{"type":"text","text":"\\n\\nPI_AGNES_OK"}],"api":"openai-completions","provider":"bifrost","model":"agnes/agnes-2.5-flash","usage":{"input":897,"output":23,"cacheRead":256,"cacheWrite":0,"reasoning":16,"totalTokens":1176,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1786488979017,"responseId":"b2ba715f59704f5f8a3283cde24a94da","responseModel":"agnes-2.5-flash"}}',
  assistantAborted:
    '{"type":"message","id":"f41f4993","parentId":"4d89d1a8","timestamp":"2026-09-03T03:53:22.465Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool_lMBm7tPplO6nZUIDUPTsTeBE","name":"bash","arguments":{}}],"api":"openai-completions","provider":"bifrost","model":"kimi/k3","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"aborted","timestamp":1788407595401,"responseId":"msg_N1uFwWIbSTp5AN3sz2wnOL4w","errorMessage":"Request was aborted"}}',
  system:
    '{"type":"message","id":"e2c3471b","parentId":"df3ed335","timestamp":"2026-10-03T23:49:34.724Z","message":{"role":"system","content":"","sections":{"preamble":"You answer with only a JSON object."},"timestamp":1791071374723}}',
};

/* ------------------------------------------------------------------ wire */

const MODEL = {
  id: "agnes-2.5-flash",
  name: "Agnes 2.5 Flash",
  api: "openai-completions",
  provider: "bifrost",
  baseUrl: "http://localhost:8080",
  input: ["text"],
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const STATE = {
  model: MODEL,
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  sessionFile: "/tmp/sessions/2026_s1.jsonl",
  sessionId: "s1",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

/** Every event pi writes, by `type`; `summarization_retry_attempt_start` has two shapes, told apart by `source`. */
export const EVENT_FIXTURES: Record<string, object> = {
  agent_start: { type: "agent_start" },
  agent_end: { type: "agent_end", messages: [USER, ASSISTANT], willRetry: false },
  turn_start: { type: "turn_start" },
  turn_end: { type: "turn_end", message: ASSISTANT, toolResults: [TOOL_RESULT] },
  message_start: { type: "message_start", message: USER },
  message_update: { type: "message_update", usage: USAGE, assistantMessageEvent: { type: "start" } },
  message_end: { type: "message_end", message: ASSISTANT },
  tool_execution_start: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  tool_execution_update: {
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "ls" },
    partialResult: { content: [{ type: "text", text: "a" }] },
    parentToolCallId: "call_0",
  },
  tool_execution_end: {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a" }] },
    isError: false,
    durationMs: 12,
  },
  agent_settled: { type: "agent_settled", aborted: false },
  queue_update: { type: "queue_update", steering: ["a"], followUp: [] },
  compaction_start: { type: "compaction_start", reason: "threshold" },
  entry_appended: { type: "entry_appended", entry: ENTRY_FIXTURES.message },
  session_info_changed: { type: "session_info_changed", name: "work" },
  thinking_level_changed: { type: "thinking_level_changed", level: "high" },
  compaction_end: {
    type: "compaction_end",
    reason: "manual",
    result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 },
    aborted: false,
    willRetry: false,
  },
  auto_retry_start: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" },
  auto_retry_end: { type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" },
  summarization_retry_scheduled: {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: "rate limited",
  },
  summarization_retry_attempt_start: { type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" },
  summarization_retry_finished: { type: "summarization_retry_finished" },
  bash_execution_update: { type: "bash_execution_update", id: "b1", delta: "out" },
};

/** The other shape of `summarization_retry_attempt_start`. */
export const BRANCH_SUMMARY_RETRY = { type: "summarization_retry_attempt_start", source: "branchSummary" };

/** Every `assistantMessageEvent`, by `type`, as the RPC mode writes it: no `partial`. */
export const ASSISTANT_EVENT_FIXTURES: Record<string, object> = {
  start: { type: "start" },
  text_start: { type: "text_start", contentIndex: 0 },
  text_delta: { type: "text_delta", contentIndex: 0, delta: "h" },
  text_end: { type: "text_end", contentIndex: 0, content: "hi" },
  thinking_start: { type: "thinking_start", contentIndex: 0 },
  thinking_delta: { type: "thinking_delta", contentIndex: 0, delta: "m" },
  thinking_end: { type: "thinking_end", contentIndex: 0, content: "mm" },
  toolcall_start: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" },
  toolcall_delta: { type: "toolcall_delta", contentIndex: 1, delta: '{"command"' },
  toolcall_end: { type: "toolcall_end", contentIndex: 1, toolCall: TOOL_CALL },
  done: { type: "done", reason: "stop", message: ASSISTANT },
  error: { type: "error", reason: "aborted", error: { ...ASSISTANT, stopReason: "aborted", errorMessage: "Request was aborted" } },
};

/** Every request of an extension, by `method`. */
export const UI_FIXTURES: Record<string, object> = {
  select: { type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"], timeout: 5000 },
  confirm: { type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?", message: "really", timeout: 5000 },
  input: { type: "extension_ui_request", id: "d3", method: "input", title: "Name", placeholder: "x" },
  editor: { type: "extension_ui_request", id: "d4", method: "editor", title: "Edit", prefill: "text" },
  notify: { type: "extension_ui_request", id: "n1", method: "notify", message: "hi", notifyType: "info" },
  setStatus: { type: "extension_ui_request", id: "n2", method: "setStatus", statusKey: "k", statusText: "busy" },
  setWidget: { type: "extension_ui_request", id: "n3", method: "setWidget", widgetKey: "w", widgetLines: ["a"], widgetPlacement: "belowEditor" },
  setTitle: { type: "extension_ui_request", id: "n4", method: "setTitle", title: "pi" },
  set_editor_text: { type: "extension_ui_request", id: "n5", method: "set_editor_text", text: "x" },
};

const response = (command: string, data?: object | null): object => ({
  id: "1",
  type: "response",
  command,
  success: true,
  ...(data === undefined ? {} : { data }),
});

/** The success answer to every command, by `command`. */
export const RESPONSE_FIXTURES: Record<string, object> = {
  prompt: response("prompt", { disposition: "started" }),
  steer: response("steer", { disposition: "queued" }),
  follow_up: response("follow_up", { disposition: "handled" }),
  abort: response("abort"),
  clear_queue: response("clear_queue", { steering: [], followUp: ["x"] }),
  new_session: response("new_session", { cancelled: false }),
  get_state: response("get_state", STATE),
  set_model: response("set_model", MODEL),
  cycle_model: response("cycle_model", { model: MODEL, thinkingLevel: "low", isScoped: false }),
  get_available_models: response("get_available_models", { models: [MODEL] }),
  set_thinking_level: response("set_thinking_level"),
  cycle_thinking_level: response("cycle_thinking_level", { level: "medium" }),
  get_available_thinking_levels: response("get_available_thinking_levels", { levels: ["off", "low"] }),
  set_steering_mode: response("set_steering_mode"),
  set_follow_up_mode: response("set_follow_up_mode"),
  compact: response("compact", { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 }),
  set_auto_compaction: response("set_auto_compaction"),
  set_auto_retry: response("set_auto_retry"),
  abort_retry: response("abort_retry"),
  bash: response("bash", { output: "a", exitCode: 0, cancelled: false, truncated: false }),
  abort_bash: response("abort_bash"),
  get_session_stats: response("get_session_stats", {
    sessionFile: "/tmp/s.jsonl",
    sessionId: "s1",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    cost: 0,
    contextUsage: { tokens: null, contextWindow: 200000, percent: null },
  }),
  export_html: response("export_html", { path: "/tmp/s.html" }),
  switch_session: response("switch_session", { cancelled: false }),
  fork: response("fork", { text: "hi", cancelled: false }),
  clone: response("clone", { cancelled: false }),
  get_fork_messages: response("get_fork_messages", { messages: [{ entryId: "e1", text: "hi" }] }),
  get_entries: response("get_entries", { entries: [ENTRY_FIXTURES.message, ENTRY_FIXTURES.compaction], leafId: "k1" }),
  get_tree: response("get_tree", {
    tree: [{ entry: ENTRY_FIXTURES.message, children: [{ entry: ENTRY_FIXTURES.label, children: [] }], label: "keep" }],
    leafId: null,
  }),
  get_last_assistant_text: response("get_last_assistant_text", { text: null }),
  set_session_name: response("set_session_name"),
  get_messages: response("get_messages", { messages: [USER, ASSISTANT, TOOL_RESULT] }),
  get_commands: response("get_commands", {
    commands: [
      {
        name: "skill:x",
        description: "x",
        source: "skill",
        sourceInfo: { path: "/p", source: "local", scope: "user", origin: "top-level" },
      },
    ],
  }),
};

/** Every command niwa could write, by `type`. */
export const COMMAND_FIXTURES: Record<string, object> = {
  prompt: { id: "1", type: "prompt", message: "hi", images: [{ type: "image", data: "AA==", mimeType: "image/png" }], streamingBehavior: "followUp" },
  steer: { type: "steer", message: "hi" },
  follow_up: { type: "follow_up", message: "hi" },
  abort: { type: "abort" },
  clear_queue: { type: "clear_queue" },
  new_session: { type: "new_session", parentSession: "/tmp/p.jsonl" },
  get_state: { type: "get_state" },
  set_model: { type: "set_model", provider: "bifrost", modelId: "x" },
  cycle_model: { type: "cycle_model" },
  get_available_models: { type: "get_available_models" },
  set_thinking_level: { type: "set_thinking_level", level: "xhigh" },
  cycle_thinking_level: { type: "cycle_thinking_level" },
  get_available_thinking_levels: { type: "get_available_thinking_levels" },
  set_steering_mode: { type: "set_steering_mode", mode: "all" },
  set_follow_up_mode: { type: "set_follow_up_mode", mode: "one-at-a-time" },
  compact: { type: "compact", customInstructions: "short" },
  set_auto_compaction: { type: "set_auto_compaction", enabled: true },
  set_auto_retry: { type: "set_auto_retry", enabled: false },
  abort_retry: { type: "abort_retry" },
  bash: { type: "bash", command: "ls", excludeFromContext: true },
  abort_bash: { type: "abort_bash" },
  get_session_stats: { type: "get_session_stats" },
  export_html: { type: "export_html", outputPath: "/tmp/o.html" },
  switch_session: { type: "switch_session", sessionPath: "/tmp/s.jsonl" },
  fork: { type: "fork", entryId: "e1" },
  clone: { type: "clone" },
  get_fork_messages: { type: "get_fork_messages" },
  get_entries: { type: "get_entries", since: "e1" },
  get_tree: { type: "get_tree" },
  get_last_assistant_text: { type: "get_last_assistant_text" },
  set_session_name: { type: "set_session_name", name: "work" },
  get_messages: { type: "get_messages" },
  get_commands: { type: "get_commands" },
};
