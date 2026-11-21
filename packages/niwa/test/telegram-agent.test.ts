// The owner's Telegram messages reach an agent as the owner's: the surface gives the default
// composition its binding, and its delivery hook says the message to the agent through the context
// of its action.

import { expect, test } from "bun:test";

import { Pressed, Received, Posted, chatId, telegram } from "@niwa-labs/telegram";
import type { Bot, ChatId, MessageId, Update, UpdateId, UserId } from "@niwa-labs/telegram";
import type { RecordType } from "@niwa-labs/core";
import { connectAsOwner, createNiwa, eventually, loginWeb, tempHome, webFetch } from "@niwa-labs/testing";

import { connect, token } from "@niwa-labs/client";
import { ScriptedControl, HARNESS, installation, transcripts, until } from "./fixtures/agent-host.ts";
import { AgentTurnQueued, AgentTurnReplied, NOTICE_PAGES, NotSent, TOKEN_ENV, grant, principalOf, HarnessInstanceRegistry, agentReply, agentTell, defaultComposition, serveCockpit } from "../src/index.ts";

/** The chat of the owner in the test. */
const OWNER = chatId(4242);

/** A bot that hands out the updates it is given, and keeps what it is asked to send. */
function fakeBot(): { bot: Bot; push(update: Update): void; sent: string[]; targets: (MessageId | undefined)[]; refusals: Set<string> } {
  const waiting: Update[] = [];
  const sent: string[] = [];
  const targets: (MessageId | undefined)[] = [];
  const refusals = new Set<string>();
  const bot: Bot = {
    async getUpdates(offset, _timeout, signal) {
      for (;;) {
        const ready = waiting.filter((update) => update.update_id >= offset);
        if (ready.length > 0 || signal?.aborted === true) return ready;
        await Bun.sleep(20);
      }
    },
    async sendMessage(chat, text, _keyboard, replyTo) {
      if (refusals.has(text)) throw new NotSent("Bot rejected this reply");
      targets.push(replyTo);
      sent.push(text);
      return { message_id: sent.length as MessageId, chat: { id: chat } };
    },
    async answerCallbackQuery() {},
  };
  return { bot, push: (update) => void waiting.push(update), sent, targets, refusals };
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

test("Telegram and Cockpit replies follow their own turns across concurrent calls and a restart", async () => {
  const home = await tempHome();
  const fake = fakeBot();
  const harnesses = new HarnessInstanceRegistry();
  const control = new ScriptedControl();
  harnesses.register({ instance: installation, control, reading: transcripts(new Map()) });
  async function serve() {
    const surface = telegram({ token: "test-token", owner: OWNER, speaksFor: "owner", agent: "rin", bot: fake.bot });
    const host = createNiwa({ home: home.path });
    host.use(...defaultComposition({
      home: home.path, harnesses, agents: { agents: [{ name: "rin", harness: HARNESS, prompt: "Reply to the owner.", hands: ["agent.reply"] }] },
      bind: (fallback) => surface.bind(fallback),
    }), surface);
    await host.serve();
    return host;
  }
  let host = await serve();
  const web = await serveCockpit({ home: home.path, speaksFor: "owner", pages: NOTICE_PAGES });
  try {
    await loginWeb(web);
    fake.push(messageUpdate(20, OWNER, "Telegram first"));
    fake.push(messageUpdate(21, OWNER, "Telegram second"));
    const response = await webFetch(`${web.url}/api/call`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: agentTell.name, input: { agent: "rin", text: "Cockpit", replyTo: { channel: "cockpit", conversation: "work" } } }),
    });
    expect(response.status).toBe(200);
    const cockpit = await response.json() as { message: string };
    const rows = await until(() => host.records.read(), "agent.turn.delivered", 3);
    const turns = rows.filter((row) => row.type === AgentTurnQueued.name).map((row) => AgentTurnQueued.schema.parse(row.data));
    const first = turns.find((row) => row.text === "Telegram first")!;
    const second = turns.find((row) => row.text === "Telegram second")!;
    const secret = token(control.starts[0]!.env![TOKEN_ENV]!);
    const protectedTypes: readonly RecordType<unknown>[] = [Received, Pressed, Posted, AgentTurnReplied];
    const outsider = await connect({ home: home.path, id: "another-session", token: host.issueToken(principalOf("session", "other"), { grant: grant(["agent.reply", ...protectedTypes.map((type) => `emit:${type.name}`)]) }) });
    try {
      // Admission applies before payload parsing or a guard fold, even for an explicit emit rule.
      for (const type of protectedTypes) {
        await expect(outsider.emit(type, {})).rejects.toThrow(/closed/);
      }
      expect(await host.records.read({ types: [AgentTurnReplied.name] })).toHaveLength(0);
      expect(fake.sent).toEqual([]);
      await expect(outsider.call(agentReply, { turn: first.turn, text: "Wrong conversation" })).rejects.toThrow();
    } finally {
      await outsider.close();
    }
    const session = await connect({ home: home.path, id: "agent-session", token: secret });
    try {
      const firstAnswer = { turn: first.turn, text: "First answer" };
      await Promise.all([
        session.call(agentReply, { turn: second.turn, text: "Second answer" }),
        session.call(agentReply, firstAnswer),
        session.call(agentReply, firstAnswer),
        session.call(agentReply, { turn: cockpit.message, text: "Cockpit answer" }),
      ]);
      await expect(session.call(agentReply, { ...firstAnswer, text: "Duplicate" })).rejects.toThrow();
      const impersonation = await webFetch(`${web.url}/api/call`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: agentReply.name, input: firstAnswer }),
      });
      expect(impersonation.ok).toBe(false);
      await until(() => host.records.read(), "telegram.reply.delivery", 2);
      expect(fake.sent.map((text, index) => [text, Number(fake.targets[index])]).sort()).toEqual([["First answer", 200], ["Second answer", 210]]);
      const query = new URLSearchParams({ after: "0", query: JSON.stringify({ types: [AgentTurnReplied.name] }) });
      const history = await (await webFetch(`${web.url}/api/history?${query}`)).json() as { type: string; data: unknown }[];
      const replies = history.filter((row) => row.type === AgentTurnReplied.name).map((row) => AgentTurnReplied.schema.parse(row.data));
      expect(replies.filter((row) => row.replyTo.channel === "cockpit")).toEqual([{ agent: "rin", turn: cockpit.message, text: "Cockpit answer", replyTo: { channel: "cockpit", conversation: "work" } }]);
    } finally {
      await session.close();
    }
    await host.close();
    host = await serve();
    const restarted = await connect({ home: home.path, id: "same-session", token: secret });
    try {
      expect(await restarted.call(agentReply, { turn: first.turn, text: "First answer" })).toEqual({ turn: first.turn });
      const receipts = await host.records.read({ types: [AgentTurnReplied.name] });
      expect(receipts).toHaveLength(3);
      const receipt = receipts[0]!;
      expect(receipt.actor).toMatchObject({ kind: "client", issuedBy: "agents" });
      const reply = AgentTurnReplied.schema.parse(receipt.data);
      const guard = AgentTurnReplied.guard!;
      const unissued = { ...receipt, actor: { ...receipt.actor, issuedBy: undefined } };
      expect(guard.fold(guard.initial(), reply, unissued)).toBe(false);
      expect(guard.fold(guard.initial(), reply, receipt)).toBe(true);
      expect(fake.sent).toHaveLength(2);
      fake.refusals.add("rejected");
      fake.push(messageUpdate(22, OWNER, "Another question"));
      const received = await until(() => host.records.read(), "agent.turn.delivered", 4);
      const turn = received.filter((row) => row.type === AgentTurnQueued.name).map((row) => AgentTurnQueued.schema.parse(row.data)).find((row) => row.text === "Another question")!;
      await restarted.call(agentReply, { turn: turn.turn, text: "rejected" });
      const outcomes = await until(() => host.records.read(), "telegram.reply.delivery", 3);
      expect(outcomes.findLast((row) => row.type === "telegram.reply.delivery")?.data).toMatchObject({ turn: turn.turn, status: "unsent", sentParts: 0, reason: expect.stringContaining("Bot rejected") });
    } finally {
      await restarted.close();
    }
  } finally {
    await web.close();
    await host.close();
    await home.cleanup();
  }
}, 30_000);

test("Telegram reports an inbox that cannot reply to the originating message", async () => {
  const home = await tempHome();
  const fake = fakeBot();
  const surface = telegram({ token: "test-token", owner: OWNER, speaksFor: "owner", agent: "rin", bot: fake.bot });
  const host = createNiwa({ home: home.path });
  try {
    host.use(...defaultComposition({
      home: home.path, harnesses: new HarnessInstanceRegistry(),
      agents: { agents: [{ name: "rin", harness: "unused", prompt: "Read only." }] },
      bind: (fallback) => surface.bind(fallback),
    }), surface);
    await host.serve();
    fake.push(messageUpdate(30, OWNER, "Hello?"));
    await eventually(() => fake.sent.length > 0);
    expect(fake.sent[0]).toContain("needs agent.reply");
    expect(Number(fake.targets[0])).toBe(300);
  } finally {
    await host.close();
    await home.cleanup();
  }
});
