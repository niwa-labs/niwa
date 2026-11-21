// What the actions say about a message that cannot be taken.
//
// Only the public API is used: the entries of core and messages, and testing.

import { expect, test } from "bun:test";

import { createNiwa, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { messageReceive, messageSend, messages } from "../src/index.ts";

/** A host with the messages module alone. */
async function serve(home: string): Promise<Host> {
  const niwa = createNiwa({ home });
  niwa.use(messages({ bind: () => undefined }));
  await niwa.serve();
  return niwa;
}

const TO = { kind: "agent" as const, id: "rin" };

test("a message without a known sender is refused as not sent", async () => {
  const home = await tempHome();
  const niwa = await serve(home.path);
  try {
    for (const action of [messageSend(), messageReceive()]) {
      const refused = await niwa.call(action, { to: TO, body: { type: "update", text: "hello" } }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
      expect((refused as { effectPossible?: boolean }).effectPossible).toBe(false);
    }
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
