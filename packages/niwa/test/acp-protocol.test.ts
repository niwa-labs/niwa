/**
 * The ACP protocol types: the two generated snapshots of the
 * official protocol, and the dialect of each harness over its snapshot — Claude Code's adapter
 * over 0.14.1, upstream MiniMax Code over 1.3.0, the owner's fork as a layer over upstream.
 *
 * Each dialect is checked against what its harness really sends: Claude Code's frames are made by
 * the adapter's own `toAcpNotifications`, upstream's were captured from `mcode acp` 0.7.1
 * (`test/fixtures/acp/mcode-0.7.1-upstream.jsonl`), the fork's refusal from the fork 0.7.2 and its
 * marks from its sources. Every frame goes through the parser and through the control side.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { toAcpNotifications } from "@zed-industries/claude-code-acp";

import { z } from "zod";

import { promptFromText, harnessId, sessionId } from "@niwa-labs/harness";
import type { LifeEvent, SessionControl } from "@niwa-labs/harness";
import { Acp014, Acp13 } from "@niwa-labs/acp";
import {
  ClaudeAgentNotification,
  ClaudeAgentRequest,
  claudeToolName,
  claudeCodeControl,
} from "@niwa-labs/harness-claude";
import {
  mcodeControl,
  McodeAgentNotification,
  McodeAgentRequest,
  NcodeSessionUpdate,
  ncodeMarks,
  refusesSessionMode,
} from "@niwa-labs/harness-mcode";
import type { MinimaxLineage, NcodeSessionUpdate as NcodeUpdate } from "@niwa-labs/harness-mcode";
import { tempDir } from "@niwa-labs/testing";

import { REPLAY_SESSION, replayAgent, signsOf, untilTurnEnds, update } from "./fixtures/acp-replay.ts";

let dir = "";
/** A control side this file starts, and so disposes. */
type OwnedControl = SessionControl & { dispose(): Promise<void> };

let control: OwnedControl | undefined;

beforeEach(async () => {
  dir = await tempDir("acp-protocol");
});

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function frames(name: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(import.meta.dir, "fixtures", "acp", `${name}.jsonl`), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The signs of life of the turn in which the agent replays its frames. */
async function replayedTurn(side: OwnedControl): Promise<LifeEvent[]> {
  const { session: id } = await side.start({ prompt: promptFromText("hello"), cwd: dir });
  // The first turn is over before the turn that replays starts.
  for (let i = 0; i < 100 && (await side.state(id)) !== "idle"; i += 1) await Bun.sleep(20);
  // The first watcher is also told of the first turn: only the second is the one that replays.
  const life = untilTurnEnds(side.life(id), 2);
  await side.send(id, "go");
  return await life;
}

// ---------------------------------------------------------------------------
// The snapshots
// ---------------------------------------------------------------------------

/** One update of each kind the 0.14.1 snapshot has; a kind added to the snapshot has to be added here. */
const UPDATES_014: Record<Acp014.SessionUpdate["sessionUpdate"], Record<string, unknown>> = {
  user_message_chunk: { content: { type: "text", text: "hi" } },
  agent_message_chunk: { content: { type: "text", text: "hello" } },
  agent_thought_chunk: { content: { type: "text", text: "hmm" } },
  tool_call: { toolCallId: "t1", title: "ls", kind: "execute", status: "pending" },
  tool_call_update: { toolCallId: "t1", status: "completed" },
  plan: { entries: [{ content: "a", priority: "medium", status: "pending" }] },
  available_commands_update: { availableCommands: [{ name: "init", description: "init", input: null }] },
  current_mode_update: { currentModeId: "acceptEdits" },
  config_option_update: { configOptions: [] },
  session_info_update: { title: "a session" },
  usage_update: { used: 10, size: 1000 },
};

/** One update of each kind the 1.3.0 snapshot has. */
const UPDATES_13: Record<Acp13.SessionUpdate["sessionUpdate"], Record<string, unknown>> = {
  ...UPDATES_014,
  plan_update: { plan: { type: "markdown", planId: "p1", content: "# plan" } },
  plan_removed: { planId: "p1" },
};

test("every update kind of each snapshot parses, and its kind is kept", () => {
  for (const [kind, body] of Object.entries(UPDATES_014)) {
    expect(Acp014.SessionUpdate.parse({ sessionUpdate: kind, ...body }).sessionUpdate as string).toBe(kind);
  }
  for (const [kind, body] of Object.entries(UPDATES_13)) {
    expect(Acp13.SessionUpdate.parse({ sessionUpdate: kind, ...body }).sessionUpdate as string).toBe(kind);
  }
});

test("an update kind the snapshot does not have does not parse", () => {
  expect(Acp014.SessionUpdate.safeParse({ sessionUpdate: "plan_update", plan: {} }).success).toBe(false);
  expect(Acp13.SessionUpdate.safeParse({ sessionUpdate: "compaction_update" }).success).toBe(false);
});

test("a field the protocol reads leniently reads as absent, not as a failed message", () => {
  const option = Acp13.SessionConfigOption.parse({ type: "select", id: "m", name: "Model", currentValue: "a", options: [], category: 42 });
  expect(option.category).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** What Claude Code's adapter sends for the blocks of an SDK message, made by the adapter itself. */
function adapterFrames(content: Parameters<typeof toAcpNotifications>[0], role: "assistant" | "user", cache: Parameters<typeof toAcpNotifications>[3]) {
  const logger = { log: () => {}, error: () => {} };
  // Without hooks the adapter never calls its client.
  const client = {} as Parameters<typeof toAcpNotifications>[4];
  return toAcpNotifications(content, role, REPLAY_SESSION, cache, client, logger, { registerHooks: false }).map((notification) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: notification,
  }));
}

function claudeFrames(): Array<Record<string, unknown>> {
  const cache = {};
  return [
    ...adapterFrames("hi", "user", cache),
    ...adapterFrames(
      [
        { type: "thinking", thinking: "hmm", signature: "" },
        { type: "text", text: "hello ", citations: null },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        { type: "server_tool_use", id: "adv1", name: "advisor", input: {} },
        { type: "tool_use", id: "todo1", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending", activeForm: "doing a" }] } },
      ],
      "assistant",
      cache,
    ),
    ...adapterFrames(
      [
        { type: "tool_result", tool_use_id: "tu1", content: "file", is_error: false },
        { type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true },
      ],
      "user",
      cache,
    ),
    ...adapterFrames([{ type: "text", text: "world", citations: null }], "assistant", cache),
    // From the adapter's sources: the mode a permission answer switches to, and the commands.
    update({ sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" }),
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "Initialize", input: { hint: "path" } }] }),
  ];
}

test("Claude Code: every frame the adapter makes parses with the dialect, and names its tool", () => {
  const made = claudeFrames();
  const kinds = made.map((frame) => {
    const parsed = ClaudeAgentNotification.parse(frame);
    if (parsed.method !== "session/update") throw new Error("not an update");
    return parsed.params.update.sessionUpdate;
  });
  expect(kinds).toEqual([
    "user_message_chunk",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call",
    "plan",
    "tool_call_update",
    "tool_call_update",
    "agent_message_chunk",
    "current_mode_update",
    "available_commands_update",
  ]);
  const tools = made.flatMap((frame) => {
    const parsed = ClaudeAgentNotification.parse(frame);
    if (parsed.method !== "session/update") return [];
    const body = parsed.params.update;
    return body.sessionUpdate === "tool_call" || body.sessionUpdate === "tool_call_update" ? [claudeToolName(body._meta)] : [];
  });
  expect(tools).toEqual(["Bash", "advisor", "Bash", "Bash"]);
});

test("Claude Code: the permission request of the adapter parses with its options", () => {
  const request = ClaudeAgentRequest.parse({
    jsonrpc: "2.0",
    id: 0,
    method: "session/request_permission",
    params: {
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      sessionId: REPLAY_SESSION,
      toolCall: { toolCallId: "tu1", rawInput: { command: "ls" }, title: "`ls`" },
    },
  });
  expect(request.method).toBe("session/request_permission");
});

test("Claude Code: each update is its own sign of life, the advisor its own, and the answer is the text", async () => {
  const replayed = [
    ...claudeFrames(),
    // The advisor's result, as the adapter passes it on: a tool call update of the advisor's call.
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "adv1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Advisor guidance applied server-side." } }],
      _meta: { claudeCode: { toolName: "advisor" } },
    }),
    // What the adapter 0.16.2 never sends and the snapshot has.
    update({ sessionUpdate: "config_option_update", configOptions: [] }),
    update({ sessionUpdate: "session_info_update", title: "t" }),
    update({ sessionUpdate: "usage_update", used: 1, size: 2 }),
  ];
  const side = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [await replayAgent(dir, replayed)] });
  control = side;
  expect(signsOf(await replayedTurn(side))).toEqual([
    "user_message_chunk",
    "thinking",
    "text",
    "tool_call",
    "advisor",
    "plan",
    "tool_call_update",
    "tool_call_update",
    "text",
    "current_mode_update",
    "available_commands_update",
    "advisor",
    "config_option_update",
    "session_info_update",
    "usage_update",
  ]);
});

test("Claude Code: the advisor's call and its answer are the advisor sign, paired by the call's id", async () => {
  const replayed = [
    ...claudeFrames(),
    update({ sessionUpdate: "tool_call_update", toolCallId: "adv1", status: "in_progress", _meta: { claudeCode: { toolName: "advisor" } } }),
    // An update that does not name the tool is placed by the call it belongs to.
    update({ sessionUpdate: "tool_call_update", toolCallId: "adv1", status: "completed" }),
    update({ sessionUpdate: "tool_call", toolCallId: "adv2", title: "advisor", status: "pending", _meta: { claudeCode: { toolName: "advisor" } } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "adv2", status: "failed", _meta: { claudeCode: { toolName: "advisor" } } }),
  ];
  const side = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [await replayAgent(dir, replayed)] });
  control = side;
  const advisor = (await replayedTurn(side)).flatMap((event) => (event.kind === "advisor" ? [event] : []));
  expect(advisor.map(({ at: _at, ...rest }) => rest)).toEqual([
    { kind: "advisor", phase: "started", callId: "adv1" },
    { kind: "advisor", phase: "finished", callId: "adv1", result: "text" },
    { kind: "advisor", phase: "started", callId: "adv2" },
    { kind: "advisor", phase: "finished", callId: "adv2", result: "error" },
  ]);
});

test("Claude Code: an update or a request the snapshot does not know is a typed unknown; the request is refused", async () => {
  const replayed = [
    update({ sessionUpdate: "compaction_update", stage: "started" }),
    { jsonrpc: "2.0", id: "x1", method: "_zed/unknown", params: {} },
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still here" } }),
  ];
  const side = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [await replayAgent(dir, replayed)] });
  control = side;
  expect(signsOf(await replayedTurn(side))).toEqual([
    "unknown:session/update compaction_update",
    "session/update compaction_update",
    "unknown:_zed/unknown",
    "_zed/unknown",
    "text",
  ]);
  const replies = (await readFile(join(dir, "replies.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(replies).toContainEqual({ jsonrpc: "2.0", id: "x1", error: { code: -32601, message: "this control side cannot serve _zed/unknown" } });
});

test("Claude Code: a request of a known method with params that do not fit is refused as invalid params, with the field", async () => {
  const replayed = [{ jsonrpc: "2.0", id: "x2", method: "session/request_permission", params: { sessionId: REPLAY_SESSION, options: "none" } }];
  const side = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [await replayAgent(dir, replayed)] });
  control = side;
  expect(signsOf(await replayedTurn(side))).toEqual(["unknown:session/request_permission", "session/request_permission"]);
  const replies = (await readFile(join(dir, "replies.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(replies).toContainEqual({
    jsonrpc: "2.0",
    id: "x2",
    error: { code: -32602, message: expect.stringContaining("params.options") as unknown },
  });
});

test("Claude Code: `advisor: false` switches the advisor off in the adapter's environment; left out, nothing is set", async () => {
  const seen = join(dir, "env.log");
  const script = join(dir, "env-acp");
  await Bun.write(script, `#!/bin/sh\necho "advisor=$CLAUDE_CODE_DISABLE_ADVISOR_TOOL" >> ${seen}\nexit 1\n`);
  await Bun.spawn(["chmod", "+x", script]).exited;
  for (const claude of [{ advisor: false }, {}]) {
    const side = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [script], claude });
    await side.start({ prompt: promptFromText("x"), cwd: dir }).catch(() => undefined);
    await side.dispose();
  }
  expect((await readFile(seen, "utf8")).trim().split("\n")).toEqual(["advisor=1", "advisor="]);
});

test("Claude Code: the options of a start stand over the instance's, and a resume that names them launches the process with them", async () => {
  const seen = join(dir, "start-env.log");
  const script = join(dir, "start-env-acp");
  await Bun.write(script, `#!/bin/sh\necho "advisor=$CLAUDE_CODE_DISABLE_ADVISOR_TOOL" >> ${seen}\nexit 1\n`);
  await Bun.spawn(["chmod", "+x", script]).exited;
  const harness = harnessId("fake");
  const asleep = async (side: ReturnType<typeof claudeCodeControl>, act: () => Promise<unknown>): Promise<void> => {
    await act().catch(() => undefined);
    await side.dispose();
  };
  // The instance leaves the advisor on; the start takes it away.
  const open = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [script] });
  await asleep(open, () => open.start({ prompt: promptFromText("x"), cwd: dir, blocks: { claude: { advisor: false } } }));
  // The instance takes it away; the start gives it back.
  const closed = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [script], claude: { advisor: false } });
  await asleep(closed, () => closed.start({ prompt: promptFromText("x"), cwd: dir, blocks: { claude: { advisor: true } } }));
  // A control side that never held the session is given the options it was started with.
  const fresh = claudeCodeControl({ harness: "fake", executable: "/bin/true", command: [script] });
  await asleep(fresh, () => fresh.resume(sessionId(harness, "native-1"), { blocks: { claude: { advisor: false } } }));
  expect((await readFile(seen, "utf8")).trim().split("\n")).toEqual(["advisor=1", "advisor=", "advisor=1"]);
});

// ---------------------------------------------------------------------------
// MiniMax Code: upstream, and the fork over it
// ---------------------------------------------------------------------------

async function minimaxSide(lineage: MinimaxLineage, replayed: readonly unknown[]) {
  const captured = await frames("mcode-0.7.1-upstream");
  const upstream = captured.find((frame) => frame["id"] === 1)?.["result"] as { _meta?: Record<string, { methods: string[] }> };
  // The capture is of the published build. The fork also serves the turn status and the history, and
  // the handshake tells the two apart by them.
  const initialize =
    lineage === "upstream"
      ? upstream
      : {
          ...upstream,
          _meta: {
            "minimax-code/extensions": {
              ...upstream._meta?.["minimax-code/extensions"],
              methods: [...(upstream._meta?.["minimax-code/extensions"]?.methods ?? []), "mcode/session/turn_status", "session/history"],
            },
          },
        };
  return mcodeControl({
    mode: "full",
    harness: harnessId("replay"),
    lineage,
    binary: await replayAgent(dir, replayed, initialize),
  });
}

test("upstream: every captured frame parses with upstream's dialect", async () => {
  const captured = await frames("mcode-0.7.1-upstream");
  const notifications = captured.filter((frame) => frame["method"] !== undefined && frame["id"] === undefined);
  expect(notifications.length).toBeGreaterThan(20);
  for (const frame of notifications) expect(McodeAgentNotification.safeParse(frame).error).toBeUndefined();
  const methods = new Set(notifications.map((frame) => McodeAgentNotification.parse(frame).method));
  expect([...methods].sort()).toEqual(["mcode/session/delegation_update", "session/update"]);
});

test("upstream: the captured turn is text, tool calls and signs of life, and it never reads a fork mark", async () => {
  const captured = await frames("mcode-0.7.1-upstream");
  const replayed = [
    ...captured.filter((frame) => frame["method"] !== undefined && frame["id"] === undefined).map(frame =>
      frame["method"] === "session/update" ? { ...frame, params: { ...(frame["params"] as object), sessionId: REPLAY_SESSION } } : frame),
    // What only the fork sends: upstream's reading does not look at it.
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", _meta: { "minimax-code/permission": { decision: "allow", decidedBy: "mode", ruleKind: null, mode: "bypassPermissions", reason: "bypass" } } }),
  ];
  const side = await minimaxSide("upstream", replayed);
  control = side;
  const events = await replayedTurn(side);
  const signs = signsOf(events);
  expect(signs.filter((sign) => sign.startsWith("unknown:"))).toEqual([]);
  expect(new Set(signs)).toEqual(
    new Set([
      "available_commands_update",
      "config_option_update",
      "session_info_update",
      "tool_call",
      "tool_call_update",
      "text",
      "usage_update",
      "mcode/session/delegation_update",
    ]),
  );
  expect(events.every((event) => event.kind !== "activity" || event.permission === undefined)).toBe(true);
});

test("upstream: the permission request and the questionnaire are requests of upstream's dialect", () => {
  const permission = McodeAgentRequest.parse({
    jsonrpc: "2.0",
    id: 4,
    method: "session/request_permission",
    params: {
      sessionId: "s",
      toolCall: { toolCallId: "c1", title: "bash", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  });
  expect(permission.method).toBe("session/request_permission");
  const form = McodeAgentRequest.parse({
    jsonrpc: "2.0",
    id: 5,
    method: "elicitation/create",
    params: { mode: "form", sessionId: "s", message: "MiniMax Code needs your input", requestedSchema: { type: "object", properties: { pick: { type: "string", enum: ["a", "b"] } }, required: ["pick"] } },
  });
  expect(form.method).toBe("elicitation/create");
});

/** A fork tool call, as the fork's `updates.ts` makes it. */
const FORK_MARK = { decision: "deny", decidedBy: "rule", ruleKind: "builtin", mode: "auto", reason: "denied by a rule" } as const;

test("fork: its marks are read off its updates, with the mark's every key; an upstream update carries none", () => {
  const marked = Acp13.SessionUpdate.parse({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "bash",
    kind: "execute",
    _meta: { "minimax-code/permission": FORK_MARK, "minimax-code/parentToolCallId": "run-code-1" },
  });
  expect(ncodeMarks(marked)).toEqual({ informational: false, permission: { ...FORK_MARK } });
  const fork = NcodeSessionUpdate.parse(marked);
  if (fork.sessionUpdate !== "tool_call") throw new Error("not a tool call");
  expect(fork._meta?.["minimax-code/parentToolCallId"]).toBe(Acp13.ToolCallId.parse("run-code-1"));

  const service = Acp13.SessionUpdate.parse({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "\nWaiting for the subscription\n" },
    _meta: { informational: true, severity: "warning", subscriptionStatus: "waiting", nextRetryAtMs: 1 },
  });
  expect(ncodeMarks(service).informational).toBe(true);
  // A mark not of the shape is no mark; the update is still read.
  const bad = Acp13.SessionUpdate.parse({ sessionUpdate: "tool_call", toolCallId: "c2", title: "x", _meta: { "minimax-code/permission": { decision: "maybe" } } });
  expect(ncodeMarks(bad)).toEqual({ informational: false, permission: undefined });

  // An upstream update is not a fork one: only the fork's reading makes one.
  // @ts-expect-error -- an update of upstream's snapshot is not an update of the fork.
  const notFork: NcodeUpdate = marked;
  void notFork;
});

test("fork: service speech never enters the answer, and the decision rides the sign of life without its reason", async () => {
  const replayed = [
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compacting" }, _meta: { compactionStage: "preparing", informational: true } }),
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", _meta: { "minimax-code/permission": FORK_MARK } }),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }),
  ];
  const side = await minimaxSide("fork", replayed);
  control = side;
  const events = await replayedTurn(side);
  expect(signsOf(events)).toEqual(["informational", "tool_call", "text"]);
  const { reason: _reason, ...withoutReason } = FORK_MARK;
  expect(events.flatMap((event) => (event.kind === "activity" && event.permission !== undefined ? [event.permission] : []))).toEqual([withoutReason]);
});

test("fork: the captured refusal of a daemon too old for the mode of a session is recognized; upstream's errors are not", async () => {
  const [, refusal] = await frames("ncode-0.7.2-fork");
  const { error } = z.object({ error: z.object({ code: z.number(), message: z.string() }) }).parse(refusal);
  expect(refusesSessionMode(error.code, error.message)).toBe(true);
  expect(refusesSessionMode(-32603, "Internal error: MiniMax Code refused the prompt (local_session_busy)")).toBe(false);
});

for (const lineage of ["upstream", "fork"] as const) {
  test(`${lineage}: a request of a known method with params that do not fit is refused as invalid params, an unknown one as not found`, async () => {
    const replayed = [
      { jsonrpc: "2.0", id: "x2", method: "session/request_permission", params: { sessionId: REPLAY_SESSION, options: "none" } },
      { jsonrpc: "2.0", id: "x3", method: "_zed/unknown", params: {} },
    ];
    const side = await minimaxSide(lineage, replayed);
    control = side;
    await replayedTurn(side);
    const replies = (await readFile(join(dir, "replies.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(replies).toContainEqual({
      jsonrpc: "2.0",
      id: "x2",
      error: { code: -32602, message: expect.stringContaining("params.options") as unknown },
    });
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: "x3", error: { code: -32601, message: "niwa does not serve _zed/unknown" } });
  });

  test(`${lineage}: an unknown notification is a typed unknown, never a crash`, async () => {
    const replayed = [{ jsonrpc: "2.0", method: "mcode/session/brand_new", params: {} }, update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } })];
    const side = await minimaxSide(lineage, replayed);
    control = side;
    const events = await replayedTurn(side);
    expect(signsOf(events)).toEqual(["unknown:mcode/session/brand_new", "mcode/session/brand_new", "text"]);
    const unknown = events.find((event) => event.kind === "unknown-variant");
    expect(unknown).toMatchObject({ protocol: lineage === "fork" ? "acp-1.3.0/ncode" : "acp-1.3.0/mcode", raw: replayed[0] });
  });
}
