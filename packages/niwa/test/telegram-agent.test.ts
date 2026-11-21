// The owner's Telegram messages reach an agent as the owner's: the surface gives the default
// composition its binding, and its delivery hook says the message to the agent through the context
// of its action.

import { expect, test } from "bun:test";

import { chatId, telegram } from "@niwa-labs/telegram";
import type { Bot, ChatId, MessageId, Update, UpdateId, UserId } from "@niwa-labs/telegram";
import { connectAsOwner, createNiwa, eventually, tempHome } from "@niwa-labs/testing";

import { HarnessInstanceRegistry, agentTell, defaultComposition } from "../src/index.ts";

/** The chat of the owner in the test. */
const OWNER = chatId(4242);

/** A bot that hands out the updates it is given, and keeps what it is asked to send. */
function fakeBot(): { bot: Bot; push(update: Update): void; sent: string[] } {
  const waiting: Update[] = [];
  const sent: string[] = [];
  const bot: Bot = {
    async getUpdates(offset, _timeout, signal) {
      for (;;) {
        const ready = waiting.filter((update) => update.update_id >= offset);
        if (ready.length > 0 || signal?.aborted === true) return ready;
        await Bun.sleep(20);
      }
    },
    async sendMessage(chat, text) {
      sent.push(text);
      return { message_id: sent.length as MessageId, chat: { id: chat } };
    },
  };
  return { bot, push: (update) => void waiting.push(update), sent };
}

function messageUpdate(id: number, chat: ChatId, text: string): Update {
  return {
    update_id: id as UpdateId,
    message: { message_id: (id * 10) as MessageId, chat: { id: chat, type: "private" }, date: 1_700_000_000, text, from: { id: chat as number as UserId } },
  };
}

test("a message of the owner's chat is said to the agent as the owner", async () => {
  const home = await tempHome();
  const fake = fakeBot();
  const surface = telegram(
    { token: "test-token", owner: OWNER, speaksFor: "owner", bot: fake.bot, retryDelay: 20 },
    {
      toAgent: async (text, ctx) => {
        return ctx.step.outcome(agentTell, { agent: "rin", text });
      },
    },
  );
  const host = createNiwa({ home: home.path });
  try {
    host.use(
      ...defaultComposition({
        home: home.path,
        harnesses: new HarnessInstanceRegistry(),
        agents: { agents: [{ name: "rin", harness: "none", prompt: "You keep the owner's work in order." }] },
        bind: (fallback) => surface.bind(fallback),
      }),
      surface,
    );
    await host.serve();
    fake.push(messageUpdate(10, OWNER, "good morning"));

    const owner = await connectAsOwner(home.path);
    try {
      const sent = async () => {
        const found = [];
        for await (const record of owner.records.since({ types: ["message.sent"] as never })) {
          found.push(record);
          if (found.length === 1) break;
        }
        return found;
      };
      await eventually(async () => (await Promise.race([sent(), Bun.sleep(300).then(() => [])])).length === 1, 5_000, "the message should reach the agent");
      const [message] = await sent();
      expect(message?.data).toMatchObject({ from: { kind: "owner" }, to: { kind: "agent", id: "rin" }, body: { text: "good morning" } });
    } finally {
      await owner.close();
    }
  } finally {
    await host.close();
    await home.cleanup();
  }
}, 30_000);
