// The checks of the Telegram surface, against a fake Bot API.
//
//   1. the owner's message is one record, a foreign chat is only noted, and the offset sent to
//      Telegram moves past what was handled;
//   2. after a restart the offset comes from the journal: nothing is lost, nothing is written twice;
//   3. the action telegram.send posts to the owner's chat, once;
//   4. a request to the owner is a message with its choices, a press answers it, and the one who
//      asked goes on;
//   5. a request to somebody else is not shown to the owner;
//   6. the polling stops with the host, and the token is in no record.

import { expect, test } from "bun:test";

import { Address, NotSent, action, record, seq } from "@niwa-labs/core";
import type { Caller, HandlerId, InvocationId, StoredRecord } from "@niwa-labs/core";
import { messageSend, messages } from "@niwa-labs/messages";
import { messageSendRef } from "@niwa-labs/messages/records";
import type { CallerBinding } from "@niwa-labs/plugin";
import { answeredBy, RequestAnswered, RequestCreated, requestAsk, question, requests } from "@niwa-labs/requests";
import { z } from "zod";

import {
  Pressed,
  Ignored,
  Posted,
  Received,
  botIdOf,
  keyboardFor,
  parseCallback,
  receivedId,
  chatId,
  telegram,
  telegramSend,
} from "../src/index.ts";
import type { UpdateId } from "../src/index.ts";
import { createNiwa, eventually, tempHome, connectAsOwner, opt, plugin } from "@niwa-labs/testing";

/** The chat of the owner in the test. */
const OWNER = chatId(4242);

/** The chat of somebody else in the test. */
const FOREIGN = chatId(777);

/** The question the owner is asked in the test, and the choices it offers. */
const Choice = question("test.choice", {
  kind: "choice",
  title: "Ship the release?",
  detail: "the release",
  options: [opt("yes", "Yes, ship it"), opt("no", "No, hold it")],
});

/** Wakes the one who asks a question. */
const Start = record("test.start", z.object({ to: Address, detail: z.string().optional() }), { open: true });

/** The answer of the owner, as the one who asked sees it. */
const Continued = record("test.continued", z.object({ answer: z.string() }));

/**
 * The one who asks a question and goes on when the answer arrives.
 *
 * The question is asked from inside the host: a question holds its schemas, so it cannot travel
 * over the wire.
 */
function asker(): ReturnType<typeof plugin> {
  return plugin("test-asker", (api) => {
    api.declare(Start, Continued);
    // Each question is asked on its own: one that waits does not hold up the next.
    api.on(Start, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const asked = data.detail === undefined ? Choice : { ...Choice, input: { ...Choice.input, detail: data.detail } };
      const { answer } = answeredBy(await step(requestAsk, { to: data.to, ...asked }));
      await step.emit(Continued, { answer: JSON.stringify(answer) });
    });
  });
}

/**
 * The fake Bot API: like Telegram, it keeps an update until a call asks from an offset past it.
 */
function fakeTelegram(): {
  base: string;
  sent: Array<{
    chat_id: number;
    text: string;
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }>;
  /** The offsets the polls asked from. */
  offsets: number[];
  /** What the surface told Telegram of the presses it saw. */
  acks: Array<{ callback_query_id: string; text?: string }>;
  /** Refuse this many of the next sends, as Telegram does when it will not take a message. */
  refuse(count: number): void;
  push(update: unknown): void;
  stop(): void;
} {
  const sent: ReturnType<typeof fakeTelegram>["sent"] = [];
  const offsets: number[] = [];
  const acks: ReturnType<typeof fakeTelegram>["acks"] = [];
  let pending: Array<{ update_id: number }> = [];
  let refusing = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").pop() ?? "";
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

      if (method === "getUpdates") {
        const offset = Number(body["offset"]);
        offsets.push(offset);
        pending = pending.filter((update) => update.update_id >= offset);
        const updates = [...pending];
        if (updates.length === 0) await Bun.sleep(30);
        return Response.json({ ok: true, result: updates });
      }

      if (method === "sendMessage") {
        // What Telegram does with a message it will not take, or one that is too long.
        if (refusing > 0 || String(body["text"]).length > 4096) {
          refusing = Math.max(0, refusing - 1);
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is too long" }, { status: 400 });
        }
        sent.push(body as (typeof sent)[number]);
        return Response.json({
          ok: true,
          result: { message_id: sent.length, chat: { id: Number(body["chat_id"]) }, text: body["text"] },
        });
      }

      if (method === "answerCallbackQuery") {
        acks.push(body as (typeof acks)[number]);
        return Response.json({ ok: true, result: true });
      }

      return Response.json({ ok: false, description: `unknown method ${method}` }, { status: 404 });
    },
  });

  return {
    base: server.url.toString().replace(/\/$/, ""),
    sent,
    offsets,
    acks,
    refuse(count: number) {
      refusing = count;
    },
    push(update: unknown) {
      pending.push(update as { update_id: number });
    },
    stop() {
      server.stop(true);
    },
  };
}

/** A message update from a chat. */
function messageUpdate(updateId: number, chat: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: chat, type: "private" },
      date: 1_700_000_000,
      text,
      from: { id: chat, username: chat === OWNER ? "owner" : "stranger" },
    },
  };
}

/** A button press on a message. */
function callbackUpdate(updateId: number, messageId: number, data: string, chat: number = OWNER): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${String(updateId)}`,
      data,
      message: { message_id: messageId, chat: { id: chat, type: "private" } },
      from: { id: chat, username: chat === OWNER ? "owner" : "stranger" },
    },
  };
}

/**
 * The records of the journal, read through the public API.
 *
 * A subscription never ends by itself, so the read stops itself: it waits for the journal to
 * settle and then stops.
 */
async function recordsOf(home: string, settleMs = 500): Promise<StoredRecord[]> {
  const client = await connectAsOwner(home);
  const records: StoredRecord[] = [];
  const reading = (async () => {
    for await (const record of client.records.since()) {
      records.push(record);
    }
  })().catch(() => undefined);
  await Bun.sleep(settleMs);
  await client.close().catch(() => undefined);
  await reading;
  return records;
}

const options = (base: string) =>
  ({ token: "test-token", owner: OWNER, speaksFor: "owner", apiBase: base, retryDelay: 20 }) as const;

/** The same surface without `speaksFor`: a plain client. */
const plainOptions = (base: string) =>
  ({ token: "test-token", owner: OWNER, apiBase: base, retryDelay: 20 }) as const;

test("telegram: the owner's message is one record, a foreign chat is only noted", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(telegram(options(fake.base)));
    await host.serve();

    fake.push(messageUpdate(100, OWNER, "hello Rin"));
    fake.push(messageUpdate(100, OWNER, "hello Rin"));
    fake.push(messageUpdate(101, FOREIGN, "let me in"));
    await eventually(() => fake.offsets.includes(102), 5_000, "the offset should pass the updates");

    const records = await recordsOf(home.path);
    const received = records.filter((record) => record.type === Received.name);
    const ignored = records.filter((record) => record.type === Ignored.name);

    expect(received).toHaveLength(1);
    const { epoch } = received[0]?.data as { epoch: number };
    expect(received[0]?.id).toBe(receivedId({ bot: botIdOf("test-token"), epoch }, 100 as UpdateId) as never);
    expect(received[0]?.data).toMatchObject({ text: "hello Rin", chat: OWNER });

    expect(ignored).toHaveLength(1);
    expect(ignored[0]?.data).toEqual({ bot: botIdOf("test-token"), epoch, update: 101, chat: FOREIGN, message: 1010 });
    expect(JSON.stringify(records)).not.toContain("let me in");
    expect(JSON.stringify(records)).not.toContain("test-token");
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: only the owner's private chat is the owner, a group of the same id is not", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(telegram(options(fake.base)));
    await host.serve();

    // A group with the configured id, a private chat written to by somebody else, and a message
    // that names no sender: none of them is the owner.
    const inGroup = messageUpdate(110, OWNER, "from a group") as { message: { chat: { type: string } } };
    inGroup.message.chat.type = "supergroup";
    const bySomebodyElse = messageUpdate(111, OWNER, "from a stranger") as { message: { from: { id: number } } };
    bySomebodyElse.message.from.id = FOREIGN;
    const anonymous = messageUpdate(112, OWNER, "from nobody") as { message: { from?: unknown } };
    delete anonymous.message.from;
    for (const update of [inGroup, bySomebodyElse, anonymous]) fake.push(update);
    fake.push(messageUpdate(113, OWNER, "from the owner"));
    await eventually(() => fake.offsets.includes(114), 5_000, "the offset should pass the updates");

    const records = await recordsOf(home.path);
    expect(records.filter((record) => record.type === Received.name).map((record) => (record.data as { text: string }).text)).toEqual([
      "from the owner",
    ]);
    expect(records.filter((record) => record.type === Ignored.name)).toHaveLength(3);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a button pressed by somebody else in the owner's chat is not the owner's answer", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");
    const data = fake.sent[0]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";

    const press = callbackUpdate(520, 1, data) as { callback_query: { from: { id: number }; message: { chat: { type: string } } } };
    press.callback_query.from.id = FOREIGN;
    fake.push(press);
    const inGroup = callbackUpdate(521, 1, data) as { callback_query: { message: { chat: { type: string } } } };
    inGroup.callback_query.message.chat.type = "group";
    fake.push(inGroup);
    await eventually(() => fake.offsets.includes(522), 5_000, "the presses should be handled");

    const records = await recordsOf(home.path);
    expect(records.filter((record) => record.type === Ignored.name)).toHaveLength(2);
    expect(records.filter((record) => record.type === RequestAnswered.name)).toHaveLength(0);
    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a surface for the owner is refused when its chat is not a private one", () => {
  const options = { token: "test-token", owner: chatId(-1001234567890), speaksFor: "owner" } as const;
  expect(() => telegram(options)).toThrow("private chat");
  expect(() => telegram({ ...options, owner: chatId(0) })).toThrow("private chat");
  expect(() => telegram({ ...options, owner: chatId(1.5) })).toThrow("private chat");
});

test("telegram: the action that hands a message to the agent exists only when there is a hook for it", async () => {
  const fake = fakeTelegram();
  const served = async (hooks: Parameters<typeof telegram>[1]): Promise<boolean> => {
    const home = await tempHome();
    const host = createNiwa({ home: home.path });
    try {
      host.use(telegram(options(fake.base), hooks));
      await host.serve();
      return await host.call("telegram.to-agent", { text: "hello" }).then(
        () => true,
        () => false,
      );
    } finally {
      await host.close();
      await home.cleanup();
    }
  };
  try {
    expect(await served({})).toBe(false);
    expect(await served({ toAgent: async () => undefined })).toBe(true);
  } finally {
    fake.stop();
  }
}, 30_000);

test("telegram: after a restart the offset comes from the journal", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const toAgent: string[] = [];

  try {
    const first = createNiwa({ home: home.path });
    first.use(telegram(options(fake.base), { toAgent: async (text) => void toAgent.push(text) }));
    await first.serve();
    fake.push(messageUpdate(200, OWNER, "one"));
    await eventually(() => fake.offsets.includes(201), 5_000, "the first update should be handled");
    await first.close();

    // Telegram still holds update 200 as far as the second host knows: the fake is not told.
    // The second host must ask from the journal's offset, not from zero.
    fake.offsets.length = 0;
    const second = createNiwa({ home: home.path });
    second.use(telegram(options(fake.base), { toAgent: async (text) => void toAgent.push(text) }));
    await second.serve();
    fake.push(messageUpdate(201, OWNER, "two"));
    await eventually(() => fake.offsets.includes(202), 5_000, "the second update should be handled");
    const received = (await recordsOf(home.path)).filter((record) => record.type === Received.name);
    await second.close();

    expect(fake.offsets[0]).toBe(201);
    expect(received.map((record) => (record.data as { text: string }).text)).toEqual(["one", "two"]);
    expect(toAgent).toEqual(["one", "two"]);
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

/** The texts of the messages the owner has written, as the journal holds them. */
async function receivedTexts(home: string): Promise<string[]> {
  return (await recordsOf(home, 200))
    .filter((record) => record.type === Received.name)
    .map((record) => (record.data as { text: string }).text);
}

test("telegram: past the time Telegram keeps updates, numbers it hands out again are new messages", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const quick = { ...options(fake.base), token: "111:first", offsetTtl: 400 };

  try {
    const first = createNiwa({ home: home.path });
    first.use(telegram(quick));
    await first.serve();
    fake.push(messageUpdate(5000, OWNER, "before the silence"));
    await eventually(() => fake.offsets.includes(5001), 5_000, "the first update should be handled");
    await first.close();

    // After a week of silence Telegram numbers anew, from any number: here a lower one, and one
    // that is the same as a number already seen.
    await Bun.sleep(600);
    fake.offsets.length = 0;
    const second = createNiwa({ home: home.path });
    second.use(telegram(quick));
    await second.serve();
    fake.push(messageUpdate(10, OWNER, "after the silence"));
    fake.push(messageUpdate(5000, OWNER, "same number, other message"));
    await eventually(() => fake.offsets.includes(5001), 5_000, "the new updates should be handled");
    const texts = await receivedTexts(home.path);
    await second.close();

    expect(fake.offsets[0]).toBe(0);
    expect(texts).toEqual(["before the silence", "after the silence", "same number, other message"]);
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a host that is up through the silence also starts a new run of numbers", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(telegram({ ...options(fake.base), offsetTtl: 400 }));
    await host.serve();
    fake.push(messageUpdate(5000, OWNER, "before the silence"));
    await eventually(() => fake.offsets.includes(5001), 5_000, "the first update should be handled");

    await Bun.sleep(700);
    fake.push(messageUpdate(10, OWNER, "after the silence"));
    await eventually(() => fake.offsets.includes(11), 5_000, "the new update should be handled");
    expect(await receivedTexts(home.path)).toEqual(["before the silence", "after the silence"]);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: another bot's numbers do not continue the offset of the one before it", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();

  try {
    const first = createNiwa({ home: home.path });
    first.use(telegram({ ...options(fake.base), token: "111:first" }));
    await first.serve();
    fake.push(messageUpdate(5000, OWNER, "from the first bot"));
    await eventually(() => fake.offsets.includes(5001), 5_000, "the first update should be handled");
    await first.close();

    fake.offsets.length = 0;
    const second = createNiwa({ home: home.path });
    second.use(telegram({ ...options(fake.base), token: "222:second" }));
    await second.serve();
    fake.push(messageUpdate(5000, OWNER, "from the second bot"));
    await eventually(() => fake.offsets.includes(5001), 5_000, "the second bot's update should be handled");
    const texts = await receivedTexts(home.path);
    await second.close();

    expect(fake.offsets[0]).toBe(0);
    expect(texts).toEqual(["from the first bot", "from the second bot"]);
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a failing delivery to the agent does not hold up the next message", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const delivered: string[] = [];
  const host = createNiwa({ home: home.path });

  try {
    host.use(
      telegram(options(fake.base), {
        toAgent: async (text) => {
          if (text === "bad") throw new Error("the agent is down");
          delivered.push(text);
        },
      }),
    );
    await host.serve();
    fake.push(messageUpdate(500, OWNER, "bad"));
    fake.push(messageUpdate(501, OWNER, "good"));
    await eventually(() => delivered.includes("good"), 5_000, "the next message should be delivered");
    expect(fake.offsets.includes(502)).toBe(true);
    const received = (await recordsOf(home.path)).filter((record) => record.type === Received.name);
    expect(received.map((record) => (record.data as { text: string }).text)).toEqual(["bad", "good"]);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a delivery cut off by a restart is not repeated, and does not block the next message", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const delivered: string[] = [];
  let started = false;

  try {
    // The first host is stopped while the agent is taking the message.
    const first = createNiwa({ home: home.path });
    first.use(
      telegram(options(fake.base), {
        toAgent: async () => {
          started = true;
          await new Promise(() => undefined);
        },
      }),
    );
    await first.serve();
    fake.push(messageUpdate(300, OWNER, "old"));
    await eventually(() => started, 5_000, "the delivery should have begun");
    await first.close();

    const second = createNiwa({ home: home.path });
    second.use(telegram(options(fake.base), { toAgent: async (text) => void delivered.push(text) }));
    await second.serve();
    fake.push(messageUpdate(301, OWNER, "new"));
    await eventually(() => delivered.includes("new"), 5_000, "the new message should be delivered");
    await second.close();

    // "old" may have reached the agent before the cut: it is never sent a second time.
    expect(delivered).toEqual(["new"]);
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: the message reaches the agent, and telegram.send posts once to the owner", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(messages());
    const plugin = telegram(options(fake.base), {
      toAgent: async (text) => {
        await host.call(messageSend(), {
          from: { kind: "owner" },
          to: { kind: "agent", id: "rin" },
          body: { type: "assignment", text },
        } as never);
      },
    });
    host.use(plugin);
    await host.serve();

    fake.push(messageUpdate(300, OWNER, "do the thing"));
    await eventually(() => fake.offsets.includes(301), 5_000, "the update should be handled");

    const sent = (await recordsOf(home.path)).filter((record) => record.type === "message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toMatchObject({
      to: { kind: "agent", id: "rin" },
      body: { type: "assignment", text: "do the thing" },
    });

    const posted = await host.call(telegramSend({ bot: plugin.service.client, owner: OWNER }), {
      text: "done",
    });
    expect(posted.chat).toBe(OWNER);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ chat_id: OWNER, text: "done" });
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: the hook steps an action as the owner, so what it sends is the owner's word", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base), {
      toAgent: async (text, ctx) => {
        return ctx.step.outcome(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text } });
      },
    });
    host.use(messages({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();

    fake.push(messageUpdate(310, OWNER, "good morning"));
    await eventually(() => fake.offsets.includes(311), 5_000, "the update should be handled");

    const sent = (await recordsOf(home.path)).filter((record) => record.type === "message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toMatchObject({
      from: { kind: "owner" },
      to: { kind: "agent", id: "rin" },
      body: { type: "update", text: "good morning" },
    });
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a request to the owner is a message, and a press answers it", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();

    // The question is asked of the owner: the one who asked waits for the answer.
    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");

    // The owner sees the request and its choices as buttons.
    const posted = fake.sent[0];
    expect(posted?.chat_id).toBe(OWNER);
    expect(posted?.text).toContain("test.choice");
    expect(posted?.text).toContain("the release");
    const buttons = posted?.reply_markup?.inline_keyboard ?? [];
    // The buttons show the labels; a press answers with the id of the option.
    expect(buttons.flat().map((button) => button.text)).toEqual(["Yes, ship it", "No, hold it"]);

    const data = buttons[0]?.[0]?.callback_data;
    expect(parseCallback(data)?.index).toBe(0);

    // The press is the owner's answer: the request is answered, and the one who asked goes on.
    fake.push(callbackUpdate(400, 1, data ?? ""));
    await eventually(
      async () => (await recordsOf(home.path, 200)).some((record) => record.type === Continued.name),
      5_000,
      "the one who asked should go on",
    );

    const records = await recordsOf(home.path);
    expect(records.some((record) => record.type === Posted.name)).toBe(true);
    const presses = records.filter((record) => record.type === Pressed.name);
    expect(presses).toHaveLength(1);
    expect(presses[0]?.data).toMatchObject({ message: 1, query: "cb400", data: "answer:0" });
    expect(fake.acks).toEqual([{ callback_query_id: "cb400", text: "Answer sent" }]);

    // The answer is the request's: it is written by the requests module, and it is the owner's.
    const answered = records.filter((record) => record.type === RequestAnswered.name);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toMatchObject({ answer: { ids: ["yes"] }, by: { kind: "owner" } });
    const continued = records.filter((record) => record.type === Continued.name);
    expect(continued[0]?.data).toMatchObject({ answer: JSON.stringify({ ids: ["yes"] }) });

    // A second press on the same message is late: it changes nothing and the handler ends.
    fake.push(callbackUpdate(401, 1, buttons[1]?.[0]?.callback_data ?? ""));
    await eventually(
      async () => (await recordsOf(home.path, 300)).filter((r) => r.type === Pressed.name).length === 2,
      5_000,
      "the late press should be written down",
    );
    const after = await recordsOf(home.path, 300);
    expect(after.filter((record) => record.type === RequestAnswered.name)).toHaveLength(1);
    // The owner is told the late press was not taken, on the button and in the chat.
    expect(fake.acks.map((ack) => ack.text)).toEqual(["Answer sent", "Not accepted"]);
    expect(fake.sent.at(-1)?.text).toContain("was not accepted");

    // Every button of a long Cyrillic choice stays inside the 64 bytes Telegram allows.
    const long = keyboardFor(["Разрешить всё до конца сессии", "Отклонить и объяснить причину"]);
    for (const row of long.inline_keyboard) {
      for (const button of row) {
        expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
      }
    }

    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a request that cannot be posted does not hold up the requests after it", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();
    fake.refuse(1);

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await Bun.sleep(300);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the second request should be posted");
    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a question longer than a message is cut to fit and still posted with its buttons", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" }, detail: "x\u{1F600}".repeat(3_000) });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");
    expect(fake.sent[0]?.text.length).toBeLessThanOrEqual(4096);
    expect(fake.sent[0]?.text.isWellFormed()).toBe(true);
    expect(fake.sent[0]?.reply_markup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Yes, ship it", "No, hold it"]);
    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a request that was open before the surface was installed is posted when it is", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();

  try {
    const before = createNiwa({ home: home.path });
    before.use(requests());
    before.use(asker());
    await before.serve();
    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(
      async () => (await recordsOf(home.path, 100)).some((record) => record.type === RequestCreated.name),
      5_000,
      "the request should be open",
    );
    await client.close();
    await before.close();

    const after = createNiwa({ home: home.path });
    const surface = telegram(options(fake.base));
    after.use(requests({ bind: surface.bind() }));
    after.use(asker());
    after.use(surface);
    await after.serve();
    await eventually(() => fake.sent.length === 1, 5_000, "the open request should be posted");
    await Bun.sleep(300);
    expect(fake.sent).toHaveLength(1);
    await after.close();
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: telegram.send is plain text, the buttons belong to requests", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(telegram(options(fake.base)));
    await host.serve();
    await host.call("telegram.send", { text: "pick one", choices: ["a", "b"] });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.reply_markup).toBeUndefined();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a press from another chat is only noted, and the owner's request stays open", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");
    const data = fake.sent[0]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";

    // The stranger presses the same button of the same message number: message numbers are per
    // chat, so only the chat tells whose press it is.
    fake.push(callbackUpdate(500, 1, data, FOREIGN));
    await eventually(() => fake.offsets.includes(501), 5_000, "the press should be handled");
    const records = await recordsOf(home.path);
    expect(records.filter((record) => record.type === Ignored.name)).toHaveLength(1);
    expect(records.filter((record) => record.type === Pressed.name)).toHaveLength(0);
    expect(records.filter((record) => record.type === RequestAnswered.name)).toHaveLength(0);
    expect(records.filter((record) => record.type === Continued.name)).toHaveLength(0);

    // The request is still open: the owner's own press answers it.
    fake.push(callbackUpdate(501, 1, data));
    await eventually(
      async () => (await recordsOf(home.path, 200)).some((record) => record.type === RequestAnswered.name),
      5_000,
      "the owner's press should answer",
    );

    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a press that answers nothing is written down and the owner is told", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(requests());
    host.use(telegram(options(fake.base)));
    await host.serve();
    fake.push(callbackUpdate(530, 999, "answer:0"));
    await eventually(() => fake.sent.length === 1, 15_000, "the owner should be told");
    expect(fake.sent[0]?.text).toContain("does not belong to a request");
    expect(fake.acks).toEqual([{ callback_query_id: "cb530", text: "Not accepted" }]);
    const presses = (await recordsOf(home.path, 200)).filter((record) => record.type === Pressed.name);
    expect(presses).toHaveLength(1);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a press is resolved by the chat as well as the message, so a former chat's post is not found", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const FORMER = chatId(5555);

  try {
    const first = createNiwa({ home: home.path });
    const surface = telegram(options(fake.base));
    first.use(requests({ bind: surface.bind() }));
    first.use(asker());
    first.use(surface);
    await first.serve();
    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");
    const data = fake.sent[0]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    await client.close();
    await first.close();

    // The owner's chat is another now: message 1 of it is not message 1 of the old chat.
    const second = createNiwa({ home: home.path });
    const moved = telegram({ ...options(fake.base), owner: FORMER });
    second.use(requests({ bind: moved.bind() }));
    second.use(asker());
    second.use(moved);
    await second.serve();
    fake.push(callbackUpdate(540, 1, data, FORMER));
    await eventually(() => fake.acks.length === 1, 15_000, "the press should be answered");
    expect(fake.acks[0]?.text).toBe("Not accepted");
    expect((await recordsOf(home.path, 200)).filter((record) => record.type === RequestAnswered.name)).toHaveLength(0);
    await second.close();
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 40_000);

test("telegram: without speaksFor the surface is a plain client, and its press is refused", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(plainOptions(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(asker());
    host.use(surface);
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    await eventually(() => fake.sent.length === 1, 5_000, "the request should be posted");
    const data = fake.sent[0]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";

    // The owner's chat pressed it, but this instance does not speak for the owner.
    fake.push(callbackUpdate(510, 1, data));
    await eventually(
      async () => (await recordsOf(home.path, 200)).some((record) => record.type === Pressed.name),
      5_000,
      "the press should be written down",
    );
    await Bun.sleep(300);
    const records = await recordsOf(home.path, 200);
    expect(records.filter((record) => record.type === RequestAnswered.name)).toHaveLength(0);
    expect(records.filter((record) => record.type === Continued.name)).toHaveLength(0);

    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: the binding is the owner with speaksFor and a plain client without it", () => {
  const handler: Caller = { kind: "handler", handler: "telegram/answer" as HandlerId, invocation: "inv" as InvocationId };
  expect(telegram(options("http://localhost")).bind()(handler)).toEqual({ kind: "owner" });
  expect(telegram(plainOptions("http://localhost")).bind()(handler)).toEqual({ kind: "client", id: "telegram" });
});

test("telegram: the binding of the surface composes with another binding", () => {
  const other: CallerBinding = () => ({ kind: "agent", id: "rin" });
  const surface = telegram(options("http://localhost"));
  expect(surface.bind()({ kind: "host" })).toBeUndefined();
  expect(surface.bind(other)({ kind: "host" })).toEqual({ kind: "agent", id: "rin" });
});

test("telegram: a request to somebody else is not shown to the owner", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(asker());
    const surface = telegram(options(fake.base));
    host.use(requests({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "agent", id: "rin" } });
    await eventually(
      async () => (await recordsOf(home.path, 200)).some((record) => record.type === RequestCreated.name),
      5_000,
      "the request should be created",
    );

    // Nothing was posted to the owner: the request is not his.
    expect(fake.sent).toHaveLength(0);

    await client.close();
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: closing the host stops the polling", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    host.use(telegram(options(fake.base)));
    await host.serve();
    await eventually(() => fake.offsets.length > 0, 5_000, "the service should poll");
    await host.close();
    await Bun.sleep(100);
    const polls = fake.offsets.length;
    await Bun.sleep(200);
    expect(fake.offsets.length).toBe(polls);
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

/** Presses the button with this text on the last message the owner was sent. */
function press(fake: ReturnType<typeof fakeTelegram>, updateId: number, label: string): void {
  const message = fake.sent.length;
  const buttons = fake.sent[message - 1]?.reply_markup?.inline_keyboard.flat() ?? [];
  const data = buttons.find((button) => button.text === label)?.callback_data;
  fake.push(callbackUpdate(updateId, message, data ?? ""));
}

test("telegram: a delivery that throws asks the owner, and retry delivers exactly once", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const delivered: string[] = [];
  let calls = 0;
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base), {
      toAgent: async (text) => {
        calls += 1;
        if (calls === 1) throw new NotSent("the agent is down");
        delivered.push(text);
      },
    });
    host.use(requests({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();
    fake.push(messageUpdate(600, OWNER, "please deploy the release to production now"));
    await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
    expect(fake.sent[0]?.text).toContain("NOT delivered");
    expect(fake.sent[0]?.text).toContain("please deploy the release");
    expect(fake.sent[0]?.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual(["retry", "cancel"]);
    expect(calls).toBe(1);
    expect(delivered).toEqual([]);

    press(fake, 601, "retry");
    await eventually(() => delivered.length === 1, 5_000, "retry should deliver");
    await Bun.sleep(300);
    expect(delivered).toEqual(["please deploy the release to production now"]);
    expect(calls).toBe(2);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: a delivery cut off by a restart asks the owner and is not resent", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const delivered: string[] = [];
  let started = false;

  try {
    const first = createNiwa({ home: home.path });
    const surface = telegram(options(fake.base), {
      toAgent: async () => {
        started = true;
        await new Promise(() => undefined);
      },
    });
    first.use(requests({ bind: surface.bind() }));
    first.use(surface);
    await first.serve();
    fake.push(messageUpdate(700, OWNER, "old message"));
    await eventually(() => started, 5_000, "the delivery should have begun");
    await first.close();

    const second = createNiwa({ home: home.path });
    const resumed = telegram(options(fake.base), { toAgent: async (text) => void delivered.push(text) });
    second.use(requests({ bind: resumed.bind() }));
    second.use(resumed);
    await second.serve();
    await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
    // The agent may have the message already: the owner is not told that it was not delivered.
    expect(fake.sent[0]?.text).not.toContain("NOT delivered");
    expect(fake.sent[0]?.text).toContain("may already have reached the agent");
    expect(fake.sent[0]?.text).toContain("old message");
    expect(fake.sent[0]?.text).toContain("repeats");
    await Bun.sleep(300);
    expect(delivered).toEqual([]);
    await second.close();
  } finally {
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

/** An action that fails the way the one a hook calls can: sure that nothing went, or not. */
function failing(name: string, sure: boolean): ReturnType<typeof plugin> {
  return plugin(`test-${name}`, (api) => {
    api.action(
      action(`test.${name}`, {
        description: "Fails.",
        input: z.object({ text: z.string() }),
        output: z.object({}),
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async () => {
          throw sure ? new NotSent("the agent is down") : new Error("the connection broke");
        },
      }),
    );
  });
}

test("telegram: a call of the hook that fails reaches the owner, who is told whether the agent may have it", async () => {
  for (const sure of [true, false]) {
    const home = await tempHome();
    const fake = fakeTelegram();
    const host = createNiwa({ home: home.path });
    const name = sure ? "tell-sure" : "tell-unsure";

    try {
      const surface = telegram(options(fake.base), {
        toAgent: async (text, ctx) => ctx.step.outcome(`test.${name}`, { text }),
      });
      host.use(requests({ bind: surface.bind() }));
      host.use(failing(name, sure));
      host.use(surface);
      await host.serve();
      fake.push(messageUpdate(850, OWNER, "tell Rin to deploy"));
      await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
      const text = fake.sent[0]?.text ?? "";
      expect(text).toContain("tell Rin to deploy");
      if (sure) {
        expect(text).toContain("NOT delivered");
        expect(fake.sent[0]?.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual(["retry", "cancel"]);
      } else {
        expect(text).not.toContain("NOT delivered");
        expect(text).toContain("may already have reached the agent");
        expect(fake.sent[0]?.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual(["send again", "cancel"]);
      }
    } finally {
      await host.close();
      fake.stop();
      await home.cleanup();
    }
  }
}, 30_000);

test("telegram: a hook that throws a plain error may have delivered, and the owner is told so", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base), {
      toAgent: async () => {
        throw new Error("the connection broke");
      },
    });
    host.use(requests({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();
    fake.push(messageUpdate(860, OWNER, "restart the server"));
    await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
    expect(fake.sent[0]?.text).toContain("may already have reached the agent");
    expect(fake.sent[0]?.text).not.toContain("NOT delivered");
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: cancel after a failed delivery delivers nothing", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  let calls = 0;
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base), {
      toAgent: async () => {
        calls += 1;
        throw new Error("the agent is down");
      },
    });
    host.use(requests({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();
    fake.push(messageUpdate(800, OWNER, "never mind"));
    await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
    press(fake, 801, "cancel");
    await eventually(
      async () => (await recordsOf(home.path, 200)).some((r) => r.type === RequestAnswered.name),
      5_000,
      "the cancel should answer the request",
    );
    await Bun.sleep(300);
    expect(calls).toBe(1);
    expect(fake.sent).toHaveLength(1);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);

test("telegram: the quote of a long message never cuts an emoji in half", async () => {
  const home = await tempHome();
  const fake = fakeTelegram();
  const host = createNiwa({ home: home.path });

  try {
    const surface = telegram(options(fake.base), {
      toAgent: async () => {
        throw new Error("the agent is down");
      },
    });
    host.use(requests({ bind: surface.bind() }));
    host.use(surface);
    await host.serve();
    fake.push(messageUpdate(900, OWNER, "\u{1F600}".repeat(81)));
    await eventually(() => fake.sent.length === 1, 5_000, "the owner should be asked");
    const text = fake.sent[0]?.text ?? "";
    expect(text).toContain(`"${"\u{1F600}".repeat(80)}..."`);
    expect(text.isWellFormed()).toBe(true);
  } finally {
    await host.close();
    fake.stop();
    await home.cleanup();
  }
}, 30_000);
