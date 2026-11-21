// Declares an action; the plugin that registers it is shown in a comment below. A host loads that
// plugin with `niwa.use(...)`; run on its own this file does nothing.
//
// An action is something the system can do. Declare it once and it appears
// as an MCP tool, as a CLI command, and in the list of what niwa can do.
// Declaring it is not enough: the plugin registers it with `api.action(...)`,
// and only then is it in that list and callable by name.

import { action } from "@niwa-labs/core";
import { z } from "zod";

// Stand-ins: not part of niwa. A bot that sends a text and says the id of the message, and the
// chat the owner reads. The real Telegram surface is `telegram()` from "@niwa-labs/telegram".
const ownerChat = "owner";
const bot = {
  send: async (chat: string, text: string): Promise<{ messageId: number }> => {
    console.log(`[${chat}] ${text}`);
    return { messageId: 1 };
  },
};

export const sendTelegram = action("telegram.send", {
  description: "Send a text message to a Telegram chat.",
  input: z.object({
    text: z.string(),
    chat: z.string().optional(),
  }),
  output: z.object({ messageId: z.number() }),

  // What is allowed after a call that was cut off by a crash:
  //   "repeat"           safe to call again
  //   "repeat-with-key"  safe, the other side dedupes by the operation id we pass
  //   "do-not-repeat"    the message may already have been delivered
  recovery: "do-not-repeat",

  run: async ({ text, chat }) => bot.send(chat ?? ownerChat, text),
});

// A plugin registers the action with the host. After this, the action is in
// the list of what niwa can do, and `niwa.call(sendTelegram, ...)` works. `sendTelegram`
// is a typed value: the type checker knows its input and its output, and a client that
// imports it calls it the same way the host does. (A bare name "telegram.send" is accepted
// too, and then nothing is checked.)
//
// export default plugin("notify", (api) => {
//   api.action(sendTelegram);
// });
//
// An action of a module is split in two: a typed reference, `actionRef(name, {description,
// input, output})`, which a caller imports, and the real action made from it,
// `action(ref, {recovery, run})`, which the module's factory registers. The schemas live in
// the reference only, so the two cannot drift. `taskCreate` from "@niwa-labs/tasks" is such a
// reference.

// An agent sees the tool `telegram_send` with this schema.
// A person in a terminal runs:
//
//   niwa telegram send --text "done"
