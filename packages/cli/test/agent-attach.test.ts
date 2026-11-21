// Which native session runs `niwa agent attach`: read from the environment its harness gives the command.

import { expect, test } from "bun:test";

import { callerSession } from "../src/agent.ts";

test("ZCode is told first, as it also sets the variables of Claude Code", () => {
  expect(callerSession({ ZCODE_SESSION_ID: "z-1", CLAUDE_CODE_SESSION_ID: "z-1", CLAUDE_PID: "12" })).toEqual({ kind: "zcode", native: "z-1", from: "ZCODE_SESSION_ID" });
});

test("Codex, pi and Claude Code are told by their own variables", () => {
  expect(callerSession({ CODEX_THREAD_ID: "c-1" })).toEqual({ kind: "codex", native: "c-1", from: "CODEX_THREAD_ID" });
  expect(callerSession({ PI_SESSION_ID: "p-1" })).toEqual({ kind: "pi", native: "p-1", from: "PI_SESSION_ID" });
  expect(callerSession({ CLAUDE_CODE_SESSION_ID: "cc-1", CLAUDE_PID: "4242" })).toEqual({ kind: "claude-code", native: "cc-1", from: "CLAUDE_CODE_SESSION_ID", pid: 4242 });
  expect(callerSession({ CLAUDE_CODE_SESSION_ID: "cc-1", CLAUDE_PID: "not a pid" })).toEqual({ kind: "claude-code", native: "cc-1", from: "CLAUDE_CODE_SESSION_ID" });
});

test("no variable, or an empty one, tells nothing", () => {
  expect(callerSession({})).toBeUndefined();
  expect(callerSession({ CODEX_THREAD_ID: " " })).toBeUndefined();
});
