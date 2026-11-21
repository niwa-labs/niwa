// The host program for the scenario "live frames".
//
// "Live frames do not appear in the journal. A subscriber that
// received none of them still receives the complete record."
//
// The plugin declares one record type, Message { text }, and a handler on it. The handler
// sends a live frame on the channel "chat" and then writes the complete message as a record:
// the frame is what the interface is showing right now, the record is what happened.
//
// The two actions let the test send a frame and read the journal through the public API:
//
//   "live-frames.frame" — send a live frame on the channel "chat"
//
// The home directory comes from argv[2]. The test imports this file for the record types and
// the action, so the host only starts when the file is run directly.

import { action, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";

/** The complete message: the record the journal holds. */
export const Message = record("live-frames.message", z.object({ text: z.string() }), { open: true });

/** The channel the live frames travel on. */
export const CHANNEL = "chat";

/** The shape of the input of the action that sends a frame. */
const Text = z.object({ text: z.string() });

/** The shape of the output of that action. */
const Ok = z.object({ ok: z.boolean() });

/** Send a live frame on the channel. */
export const sendFrame = action("live-frames.frame", {
  description: "Send a live frame on the channel chat.",
  input: Text,
  output: Ok,
  recovery: "repeat",
  effect: "write",
  run: async (input) => {
    // The frame is not a record: it is never written to the journal.
    if (niwa === undefined) {
      throw new Error("live-frames.frame: the host is not running");
    }
    await niwa.live.send(CHANNEL, { channel: CHANNEL, data: { partial: input.text } });
    return { ok: true };
  },
});

/** The host this program runs: the action needs it to send a frame. */
let niwa: ReturnType<typeof createNiwa> | undefined;

/** The plugin of this scenario. */
export function makePlugin() {
  return plugin("live-frames", (api) => {
    api.declare(Message);
    api.action(sendFrame);
    api.on(Message, async (data) => {
      // The live frame: what an interface shows while the message is being written.
      api.live(CHANNEL, { channel: CHANNEL, data: { partial: data.text } });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun live-frames-host.ts <home>");
    process.exit(2);
  }

  const host = createNiwa({ home });
  niwa = host;
  host.use(makePlugin());
  await host.serve();

  process.on("SIGTERM", () => {
    void host.close().then(() => process.exit(0));
  });
}
