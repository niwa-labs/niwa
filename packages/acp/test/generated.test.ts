import { expect, test } from "bun:test";

import { Acp014, Acp13 } from "../src/index.ts";

const snapshots = [
  ["0.14", Acp014],
  ["1.3", Acp13],
] as const;

test("a response keeps its result whatever method it answers", () => {
  for (const [, acp] of snapshots) {
    const prompted = { id: 1, result: { stopReason: "end_turn" } };
    expect(acp.AgentResponse.parse(prompted)).toEqual(prompted);
    const asked = { id: 2, result: { outcome: { outcome: "selected", optionId: "allow" } } };
    expect(acp.ClientResponse.parse(asked)).toEqual(asked);
    const failed = { id: 3, error: { code: -32602, message: "no" } };
    expect(acp.AgentResponse.parse(failed)).toEqual(failed);
    expect(acp.ClientResponse.parse(failed)).toEqual(failed);
  }
});

test("the result of a request is read by the schema of its method", () => {
  for (const [, acp] of snapshots) {
    expect(acp.ClientToAgentResults["session/prompt"].parse({ stopReason: "end_turn" })).toEqual({ stopReason: "end_turn" });
    expect(acp.ClientToAgentResults["session/prompt"].safeParse({}).success).toBe(false);
    const selected = { outcome: { outcome: "selected", optionId: "allow" } };
    expect(acp.AgentToClientResults["session/request_permission"].parse(selected)).toEqual(selected);
    expect(Object.keys(acp.ClientToAgentResults)).toContain("initialize");
    expect(Object.keys(acp.AgentToClientResults)).toContain("session/request_permission");
  }
});
