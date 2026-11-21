import { expect, test } from "bun:test";

import { ProtocolNameSchema } from "@niwa-labs/harness";

import { Acp014, acpVariant, readVariant } from "../src/index.ts";

const protocol = ProtocolNameSchema.parse("acp-0.14.1/claude-code");

test("a message that fits its variant reads as the typed value", () => {
  const frame = { id: 1, method: "session/request_permission", params: { sessionId: "s", toolCall: { toolCallId: "c" }, options: [] } };
  expect(readVariant(Acp014.AgentToClientRequest, frame, protocol, acpVariant)).toMatchObject({ ok: true });
});

test("a method the snapshot does not know is an unknown variant, and so is an update it does not know", () => {
  const request = { id: 1, method: "_zed/unknown", params: {} };
  const read = readVariant(Acp014.AgentToClientRequest, request, protocol, acpVariant);
  expect(read).toEqual({ ok: false, unknown: { protocol, variant: "_zed/unknown", raw: request } });

  const update = { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "compaction_update" } } };
  expect(readVariant(Acp014.AgentToClientNotification, update, protocol, acpVariant)).toEqual({
    ok: false,
    unknown: { protocol, variant: "session/update compaction_update", raw: update },
  });
});

test("a known method whose params do not fit is invalid, with the field it is wrong in, and keeps the raw frame", () => {
  const request = { id: 1, method: "session/request_permission", params: { sessionId: "s", options: "none" } };
  const read = readVariant(Acp014.AgentToClientRequest, request, protocol, acpVariant);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.unknown).toEqual({ protocol, variant: "session/request_permission", raw: request });
  expect(read.invalid).toContain("params.options");
  expect(read.invalid).toContain("params.toolCall");

  const update = { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call" } } };
  const badUpdate = readVariant(Acp014.AgentToClientNotification, update, protocol, acpVariant);
  expect(badUpdate).toMatchObject({ ok: false, unknown: { variant: "session/update tool_call" } });
  expect(badUpdate.ok ? "" : badUpdate.invalid).toContain("params.update.toolCallId");
});
