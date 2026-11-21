import { expect, test } from "bun:test";

import { hasProfileReply } from "../src/conformance/profile.ts";
import { SessionRecordSchema } from "../src/reading.ts";

async function* transcript(...records: Record<string, unknown>[]) {
  for (const [index, record] of records.entries()) {
    yield SessionRecordSchema.parse({ locator: `l${index}`, ...record });
  }
}

test("a profile check accepts only a complete assistant reply carrying the requested word", async () => {
  const user = { kind: "user", text: "Reply with the single word PONG and nothing else." };
  const thought = { kind: "thinking", text: "PONG", redacted: false };
  const tool = { kind: "tool-result", callId: "c1", output: "PONG" };
  const incomplete = { kind: "assistant", text: "PONG", incomplete: true };
  const extraText = { kind: "assistant", text: "The word is PONG." };
  expect(await hasProfileReply(transcript(user, thought, tool, incomplete, extraText))).toBe(false);
  expect(await hasProfileReply(transcript(user, { kind: "assistant", text: "PONG\n" }))).toBe(true);
});
