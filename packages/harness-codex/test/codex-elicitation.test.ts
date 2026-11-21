// What `mcpServer/elicitation/request` of Codex is as a niwa question, and the reply for each answer
// . The mapping is a pure function: no process is run.

import { expect, test } from "bun:test";

import { OptionIdSchema } from "@niwa-labs/core";
import type { Answer } from "@niwa-labs/core";
import { elicitationOf } from "../src/reverse.ts";
import type { ElicitationRequest } from "../src/reverse.ts";

const picks = (text: string): Answer => ({ ids: [OptionIdSchema.parse(text)] });

function asked(params: Record<string, unknown>): ElicitationRequest {
  return { id: 1, method: "mcpServer/elicitation/request", params: { threadId: "th", turnId: "t1", ...params } } as ElicitationRequest;
}

const approval = (message: string, meta: Record<string, unknown>): ElicitationRequest =>
  asked({ serverName: "niwa", mode: "form", message, _meta: { codex_approval_kind: "mcp_tool_call", ...meta }, requestedSchema: { type: "object", properties: {} } });

test("leave to call a tool names the tool as an MCP tool is named, and what it acts on is the tool with its input", () => {
  const found = elicitationOf(approval('Allow the niwa MCP server to run tool "task_finish"?', { tool_name: "task_finish", tool_params: { id: 7 } }));
  expect(found?.question).toEqual({
    kind: "permission",
    title: 'Allow the niwa MCP server to run tool "task_finish"?',
    detail: '{"id":7}',
    options: [
      { id: OptionIdSchema.parse("accept"), label: "Allow once", flavor: "allow_once" },
      { id: OptionIdSchema.parse("decline"), label: "Decline", flavor: "reject_once" },
    ],
    subject: { tool: "mcp__niwa__task_finish", kind: "mcp", target: 'mcp__niwa__task_finish\n{"id":7}' },
  });
});

test("the tool is read from _meta.tool_name, not from the words; an approval without it is declined", () => {
  const named = elicitationOf(approval("Allow this app to run tool \"other\"?", { tool_name: "finish_task", tool_title: "Finish" }));
  expect(named?.question).toMatchObject({ subject: { tool: "mcp__niwa__finish_task", target: "mcp__niwa__finish_task" } });
  expect(elicitationOf(approval('Allow the niwa MCP server to run tool "x"?', {}))).toBeUndefined();
});

test("the answers to leave to call a tool: allow is accept, reject is decline, anything else is cancel; no persistence is ever asked", () => {
  const found = elicitationOf(approval('Allow the niwa MCP server to run tool "x"?', { tool_name: "x", persist: ["session", "always"] }));
  expect(found?.reply(picks("accept"))).toEqual({ action: "accept", content: null, _meta: null });
  expect(found?.reply(picks("decline"))).toEqual({ action: "decline", content: null, _meta: null });
  expect(found?.reply({ cancelled: true })).toEqual({ action: "cancel", content: null, _meta: null });
});

test("a form is a form question without the nulls Codex writes for what is absent, answered by its value", () => {
  const found = elicitationOf(
    asked({
      serverName: "x",
      mode: "form",
      message: "Which repo?",
      requestedSchema: { $schema: null, type: "object", properties: { repo: { type: "string", title: null, default: null } }, required: null },
    }),
  );
  expect(found?.question).toEqual({
    kind: "form",
    title: "Which repo?",
    schema: { type: "object", properties: { repo: { type: "string" } } },
  });
  expect(found?.reply({ form: { repo: "niwa" } })).toEqual({ action: "accept", content: { repo: "niwa" }, _meta: null });
  // A form cannot be declined: what is not a value is a cancel, whatever else was picked.
  expect(found?.reply(picks("accept"))).toEqual({ action: "cancel", content: null, _meta: null });
  expect(found?.reply({ cancelled: true })).toEqual({ action: "cancel", content: null, _meta: null });
});

test("an elicitation of a kind niwa cannot ask a person is not one", () => {
  expect(elicitationOf(asked({ serverName: "x", mode: "url", elicitationId: "e", message: "open it", url: "https://example.test" }))).toBeUndefined();
  expect(elicitationOf(asked({ serverName: "x", mode: "openaiForm", message: "fill it", requestedSchema: {} }))).toBeUndefined();
  expect(elicitationOf(asked({ serverName: "x", mode: "openai/form", message: "fill it", requestedSchema: {} }))).toBeUndefined();
});
