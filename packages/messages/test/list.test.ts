// What the list says about a message that can be taken.
//
// Only the public API is used: the entries of core and messages, and testing.

import { expect, test } from "bun:test";

import { createNiwa, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { messageListRef, messageSend, messages } from "../src/index.ts";

/** A host with the messages module alone. */
async function serve(home: string): Promise<Host> {
  const niwa = createNiwa({ home });
  niwa.use(messages({ bind: () => undefined }));
  await niwa.serve();
  return niwa;
}

const TO = { kind: "agent" as const, id: "rin" };

test("a text with a lone carriage return or a line break does not break the list", async () => {
  const home = await tempHome();
  const niwa = await serve(home.path);
  try {
    const from = { kind: "owner" as const };
    for (const text of ["a\rb", "first\nsecond", "\r\nsecond line", "plain"]) {
      await niwa.call(messageSend(), { from, to: TO, body: { type: "update", text } });
    }
    const listed = await niwa.call(messageListRef, {});
    expect(listed.items.map((item) => item.description)).toEqual(["update: a", "update: first", "update:", "update: plain"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
