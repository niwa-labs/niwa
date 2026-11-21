/**
 * index.ts — the Telegram surface: the plugin and the action telegram.send.
 *
 * The service long-polls Telegram and writes each message of the owner's chat as a record. The
 * id of a record is made from the update id, and the offset to ask from is read back from the
 * journal, so a restart neither loses an update nor writes one twice. A chat that is not the
 * owner's is not a way into niwa: its message, or its press of a button, is written down as
 * ignored, without its text, and nothing it sends is done with the owner's rights.
 *
 * The surface speaks for the owner only as an instance configured with `speaksFor`, and then only
 * for input from the owner's chat. Without it the surface is a plain client: a press of a button
 * in the owner's chat is refused by the requests module, which lets only the addressee answer.
 *
 * What waits for the owner is one list, and this chat is one view of it. A request addressed to
 * the owner is posted as a message with the choices it offers as buttons. A press of a button is the owner's answer: the press is written down, and the request
 * is answered by calling "request.answer" as the owner.
 *
 * A button carries the answer and nothing else: Telegram gives a callback 64 bytes, and the id of
 * a request is longer. The request the press belongs to is the one the message shows, and the
 * record of that message says which request it is.
 */

import { OptionIdSchema, action, client, optionsOf, owner, questionLines, record } from "@niwa-labs/core";
import type { Action, Answer, Caller, JournalReader, RecordType, SpeaksFor } from "@niwa-labs/core";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin, PluginApi, ServiceContext } from "@niwa-labs/plugin";
import { z } from "zod";

import {
  REQUEST_ANSWER,
  RequestAnswered,
  RequestCancelled,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpiredRecord,
  RequestId,
  answeredBy,
  question,
  requestAsk,
} from "@niwa-labs/requests";

import {
  chatSchema,
  createBot,
  messageSchema,
  updateSchema,
  type Bot,
  type ChatId,
  type InlineKeyboard,
  type MessageId,
  type Update,
  type UpdateId,
} from "./bot.ts";

export const TELEGRAM_SEND = "telegram.send";
export const TELEGRAM_RECEIVED = "telegram.received";
export const TELEGRAM_IGNORED = "telegram.ignored";
export const TELEGRAM_REQUEST = "telegram.request";
export const TELEGRAM_ANSWER = "telegram.answer";
export const TELEGRAM_TO_AGENT = "telegram.to-agent";

/** The options of what the owner is asked when his message did not reach the agent. */
const RETRY = OptionIdSchema.parse("retry");
const CANCEL = OptionIdSchema.parse("cancel");

/** What the owner is asked when his message did not reach the agent. */
function undelivered(text: string) {
  return question("telegram.undelivered", {
    kind: "choice",
    title: undeliveredText(text),
    options: [
      { id: RETRY, label: "retry", flavor: "plain" },
      { id: CANCEL, label: "cancel", flavor: "plain" },
    ],
  });
}

/** How much of the message the question quotes. */
const QUOTE_LENGTH = 80;

/** The words that tell the owner his message was not delivered, with the beginning of it. */
function undeliveredText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // By code points, so an emoji is never cut in half.
  const points = Array.from(flat);
  const quote = points.length > QUOTE_LENGTH ? `${points.slice(0, QUOTE_LENGTH).join("")}...` : flat;
  return `Your message was NOT delivered to the agent: "${quote}". Retry the delivery or cancel it.`;
}

/** The name of the plugin: the handlers of the surface are the calls the owner makes here. */
const PLUGIN_NAME = "telegram";

/** The records that end a request: a request that is ended is not one the owner may answer. */
const END_TYPES = [
  RequestAnswered.name,
  RequestCancelledRecord.name,
  RequestExpiredRecord.name,
];

/** How long the service waits for the record of a message that is not committed yet. */
const POSTED_WAIT_MS = 5_000;

/** How long the service waits between two looks for that record. */
const POSTED_POLL_MS = 50;

/** A request as it was created. */
type Created = z.infer<typeof RequestCreated.schema>;

/** A message that came in from the owner's chat. */
export const Received = record(
  TELEGRAM_RECEIVED,
  z.object({
    update: updateSchema,
    chat: chatSchema,
    message: messageSchema,
    text: z.string(),
    /** Who wrote it, as Telegram names them. */
    from: z.string().optional(),
  }),
);

/** A message from another chat: not the owner's, so only the fact of it is kept. */
export const Ignored = record(
  TELEGRAM_IGNORED,
  z.object({ update: updateSchema, chat: chatSchema, message: messageSchema }),
);

/** A request that was posted to the owner, with the buttons that answer it. */
export const Posted = record(
  TELEGRAM_REQUEST,
  z.object({
    /** The id of the request: the message is the way back to it. */
    request: RequestId,
    chat: chatSchema,
    message: messageSchema,
    /** The name of the question that was asked. */
    question: z.string(),
    /** The choices the buttons stand for, in the order of the buttons. */
    choices: z.array(z.string()),
  }),
);

/** The press of a button: the owner chose one of the answers of a request. */
export const Answered = record(
  TELEGRAM_ANSWER,
  z.object({
    update: updateSchema,
    request: RequestId,
    answer: z.string(),
    chat: chatSchema,
  }),
);

/** The record types the polling service restores its offset from. */
const OFFSET_TYPES = [Received, Ignored, Answered];

export interface TelegramOptions {
  /** The token of the bot: what Telegram gave it. */
  readonly token: string;
  /** The chat of the owner. Only this chat is read. */
  readonly owner: ChatId;
  /**
   * Speak for the owner: a press of a button in the owner's chat answers a request addressed to
   * the owner. Without it the surface is a plain client, and the press is refused.
   */
  readonly speaksFor?: SpeaksFor;
  /** The base of the Bot API: the real one, unless a test says otherwise. */
  readonly apiBase?: string;
  /** How long one poll waits for an update, in seconds. */
  readonly pollTimeout?: number;
  /** How long the service waits after a failed poll, in milliseconds. */
  readonly retryDelay?: number;
  /** The bot, when the caller has one of its own. */
  readonly bot?: Bot;
}

export interface TelegramHooks {
  /**
   * Send a message to the owner's main agent, when the messages plugin is present.
   *
   * Without it the message stays in the journal and the agent reads it there.
   */
  toAgent?: (text: string) => Promise<void>;
}

/** The id of the record of an incoming message: the update id, so a repeat is harmless. */
export function receivedId(update: UpdateId): string {
  return `rec_telegram_${String(update)}`;
}

/** The id of the record of a message from another chat. */
function ignoredId(update: UpdateId): string {
  return `rec_telegram_ignored_${String(update)}`;
}

/** The id of the record of a button press. */
function answeredId(update: UpdateId): string {
  return `rec_telegram_answer_${String(update)}`;
}

/**
 * The callback data of a button: the place of its answer among the choices of the message.
 *
 * Telegram gives a callback 64 bytes, and an answer in text (encoded, a Cyrillic letter is twelve
 * bytes) may not fit, so the button carries the place and the record of the message carries the
 * choices.
 */
export function answerCallback(index: number): string {
  return `answer:${String(index)}`;
}

/** The place of the answer a callback carries, or undefined when it carries none. */
export function parseCallback(data: string | undefined): { index: number } | undefined {
  const match = data === undefined ? null : /^answer:(\d+)$/.exec(data);
  if (match === null) return undefined;
  return { index: Number(match[1]) };
}

/** The keyboard of a question: the answers the owner may choose. */
export function keyboardFor(answers: string[]): InlineKeyboard {
  return {
    inline_keyboard: answers.map((answer, index) => [{ text: answer, callback_data: answerCallback(index) }]),
  };
}

/**
 * The part that talks to Telegram and writes what it says.
 *
 * It keeps no list of what waits: the requests module holds that, and the journal is its truth.
 */
export class TelegramService {
  private readonly bot: Bot;
  private readonly owner: ChatId;
  private readonly pollTimeout: number;
  private readonly retryDelay: number;
  private readonly hooks: TelegramHooks;
  private emit: ServiceContext["emit"] | undefined;
  private journal: JournalReader | undefined;
  private offset = 0;

  constructor(opts: TelegramOptions, hooks: TelegramHooks) {
    this.bot =
      opts.bot ??
      createBot({ token: opts.token, ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }) });
    this.owner = opts.owner;
    this.pollTimeout = opts.pollTimeout ?? 25;
    this.retryDelay = opts.retryDelay ?? 250;
    this.hooks = hooks;
  }

  get client(): Bot {
    return this.bot;
  }

  /**
   * Start polling. The offset continues after the newest update the journal holds, and the
   * returned function stops the loop and the poll in flight.
   */
  start(ctx: ServiceContext, journal: JournalReader | undefined): () => void {
    this.emit = ctx.emit;
    this.journal = journal;
    if (journal !== undefined) {
      const known = journal
        .since(0 as never, OFFSET_TYPES.map((type) => type.name))
        .map((stored) => (stored.data as { update: number }).update);
      this.offset = Math.max(this.offset, ...known.map((update) => update + 1));
    }
    const abort = new AbortController();
    void this.poll(abort.signal);
    return () => {
      abort.abort();
      this.emit = undefined;
    };
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await this.bot.getUpdates(this.offset, this.pollTimeout, signal);
        for (const update of updates) {
          // Below the offset is an update already handled: Telegram may hand it out again.
          if (update.update_id < this.offset) continue;
          await this.handle(update);
          this.offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error(`niwa: telegram: ${error instanceof Error ? error.message : String(error)}`);
        await Bun.sleep(this.retryDelay);
      }
    }
  }

  /** One update: a message, a press of a button, or something from a chat that is not the owner's. */
  async handle(update: Update): Promise<void> {
    if (update.callback_query !== undefined) {
      await this.handleCallback(update.update_id, update.callback_query);
      return;
    }
    const message = update.message;
    if (message === undefined) return;

    // Who is speaking is the chat of the update, never anything the text says.
    if (message.chat.id !== this.owner) {
      await this.write(
        Ignored,
        { update: update.update_id, chat: message.chat.id, message: message.message_id },
        ignoredId(update.update_id),
      );
      return;
    }

    const text = message.text ?? "";
    await this.write(
      Received,
      {
        update: update.update_id,
        chat: message.chat.id,
        message: message.message_id,
        text,
        ...(message.from?.username === undefined ? {} : { from: message.from.username }),
      },
      receivedId(update.update_id),
    );
  }

  /** A button was pressed: it is the owner's answer to the request the message shows. */
  private async handleCallback(
    update: UpdateId,
    query: NonNullable<Update["callback_query"]>,
  ): Promise<void> {
    const message = query.message;
    if (message === undefined) return;
    // The chat of the message decides who pressed: a press in another chat is noted, never obeyed.
    // (A message id is only unique within its chat, so it is not looked up before this check.)
    if (message.chat.id !== this.owner) {
      await this.write(
        Ignored,
        { update, chat: message.chat.id, message: message.message_id },
        ignoredId(update),
      );
      return;
    }
    const parsed = parseCallback(query.data);
    if (parsed === undefined) return;

    const posted = await this.postedOf(message.message_id);
    const answer = posted?.choices[parsed.index];
    if (posted === undefined || answer === undefined) return;

    await this.write(
      Answered,
      {
        update,
        request: posted.request,
        answer,
        chat: message.chat.id,
      },
      answeredId(update),
    );
  }

  /**
   * The request the message shows, when the record of that message is committed.
   *
   * The record is written right after the message is sent, so a press that arrives before it is
   * committed waits for it a little: the owner pressed a button, and the press is not lost.
   */
  private async postedOf(message: MessageId): Promise<z.infer<typeof Posted.schema> | undefined> {
    if (this.journal === undefined) return undefined;
    const deadline = Date.now() + POSTED_WAIT_MS;
    for (;;) {
      const found = this.journal.find({ type: Posted.name, field: "message", equals: message });
      const last = found.at(-1);
      if (last !== undefined) {
        const parsed = Posted.schema.safeParse(last.data);
        if (parsed.success) return parsed.data;
      }
      if (Date.now() >= deadline) return undefined;
      await Bun.sleep(POSTED_POLL_MS);
    }
  }

  private async write<T>(type: RecordType<T>, data: T, id?: string): Promise<void> {
    if (this.emit === undefined) throw new Error("the telegram service is not running");
    await this.emit(type, data, id === undefined ? undefined : { id });
  }
}

/** The choices under a message: one button each. */
const Choices = z.array(z.string());

/** The input of the action that sends a message. */
const SendInput = z.object({
  text: z.string(),
  /** The choices the owner may take; without them the message is plain. */
  choices: Choices.optional(),
});

/**
 * The action that sends a message to the owner's chat.
 *
 * A send is not idempotent and Telegram takes no key: a call that was cut off may have been
 * delivered, so it is not repeated.
 */
export function telegramSend(opts: {
  bot: Bot;
  owner: ChatId;
}): Action<z.infer<typeof SendInput>, { messageId: MessageId; chat: ChatId }> {
  return action(TELEGRAM_SEND, {
    description: "Send a text message to the owner's Telegram chat.",
    input: SendInput,
    output: z.object({ messageId: messageSchema, chat: chatSchema }),
    recovery: "do-not-repeat",
    run: async (input) => {
      const keyboard = input.choices === undefined ? undefined : keyboardFor(input.choices);
      const sent = await opts.bot.sendMessage(opts.owner, input.text, keyboard);
      return { messageId: sent.message_id, chat: opts.owner };
    },
  });
}

/** The plugin of the Telegram surface, with the service it runs. */
export interface TelegramPlugin extends Plugin {
  readonly service: TelegramService;
  /**
   * The binding of this instance, for the composition to give the requests module.
   *
   * The requests module binds a caller to an address by the transport, never by a payload.
   * With `speaksFor` the handlers of this surface are the owner, so a press of a button in the
   * owner's chat is the owner's answer and nobody else's. Without it they are a plain client,
   * which may not answer for the owner. Every other caller is bound by `fallback`, the default
   * binding of the messages module unless the composition gives its own.
   */
  bind(fallback?: CallerBinding): CallerBinding;
}

/** The plugin of the Telegram surface. The service polls while the host serves. */
export function telegram(opts: TelegramOptions, hooks: TelegramHooks = {}): TelegramPlugin {
  const service = new TelegramService(opts, hooks);
  const send = telegramSend({ bot: service.client, owner: opts.owner });

  const toAgent = hooks.toAgent;
  const deliver = action(TELEGRAM_TO_AGENT, {
    description: "Hand a message of the owner's chat to the owner's main agent.",
    input: z.object({ text: z.string() }),
    output: z.object({}),
    recovery: "do-not-repeat",
    run: async (input) => {
      await toAgent?.(input.text);
      return {};
    },
  });

  const built = plugin(PLUGIN_NAME, (api: PluginApi) => {
    api.declare(Received, Ignored, Posted, Answered);
    api.action(send);
    api.action(deliver);

    // The poll loop only records. Delivery is a step of this handler, so it never holds up the
    // messages after it. A delivery that failed, or was cut off by a restart, is never resent by
    // itself: the owner is asked, and only his "retry" delivers again.
    api.on(Received, { id: "agent" }, async (data, step) => {
      if (toAgent === undefined || data.text === "") return;
      for (;;) {
        const outcome = await step.outcome(deliver, { text: data.text });
        if (outcome.status === "completed") return;
        let answer: Answer;
        try {
          ({ answer } = answeredBy(await step(requestAsk, { to: { kind: "owner" }, ...undelivered(data.text) })));
        } catch (error) {
          if (error instanceof RequestCancelled) return;
          throw error;
        }
        if (!("ids" in answer) || answer.ids[0] !== RETRY) return;
      }
    });
    api.service((ctx) => service.start(ctx, api.journal?.()));

    // A request addressed to the owner is shown to him: a message with the choices as buttons.
    api.on(RequestCreated, { id: "request" }, async (data: Created, step) => {
      if (data.to.kind !== "owner") return;
      // The request may be ended already: a resolver of the owner may have answered it before it
      // reached him, and a request that is not open is not shown.
      if (ended(api, data.id)) return;
      const options = optionsOf(data.input);
      const sent = await step(send, {
        text: textOf(data),
        ...(options.length === 0 ? {} : { choices: options.map((option) => option.label) }),
      });
      await step.emit(Posted, {
        request: data.id,
        chat: opts.owner,
        message: sent.messageId,
        question: data.question,
        choices: options.map((option) => option.id),
      });
    });

    // A press of a button is the owner's answer: the request is answered, and the one who asked
    // goes on. A press on a request that is not open any more is refused, and the refusal ends
    // the handler: a late answer does nothing, and nothing waits for a decision.
    api.on(Answered, { id: "answer" }, async (data, step) => {
      const outcome = await step.outcome(REQUEST_ANSWER, { id: data.request, answer: { ids: [OptionIdSchema.parse(data.answer)] } });
      if (outcome.status === "completed") return;
      const reason =
        outcome.status === "denied"
          ? outcome.reason
          : outcome.status === "failed"
            ? outcome.error
            : "the answer is not known";
      console.error(`niwa: telegram: the request "${data.request}" was not answered: ${reason}`);
    });
  });
  const handlerPrefix = `${PLUGIN_NAME}/`;
  const bind = (fallback: CallerBinding = bindingOf()): CallerBinding => {
    return (caller: Caller) => {
      if (caller.kind === "handler" && caller.handler.startsWith(handlerPrefix)) {
        return opts.speaksFor === "owner" ? owner : client(PLUGIN_NAME);
      }
      return fallback(caller);
    };
  };
  return { ...built, service, bind };
}

/** Whether the request is already ended: an ended request is not one the owner may answer. */
function ended(api: PluginApi, request: string): boolean {
  const journal = api.journal?.();
  if (journal === undefined) return false;
  return END_TYPES.some((type) => journal.find({ type, field: "id", equals: request }).length > 0);
}

/** The message about a request: the name of the question and what was asked. */
function textOf(created: Created): string {
  return [created.question, ...questionLines(created.input)].join("\n");
}

export { createBot, chatId } from "./bot.ts";
export type { Bot, ChatId, InlineKeyboard, InlineButton, MessageId, Update, UpdateId, UserId } from "./bot.ts";
