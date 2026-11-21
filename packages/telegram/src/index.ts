/**
 * index.ts — the Telegram surface: the plugin and its actions.
 *
 * The service long-polls Telegram and writes each message of the owner's chat as a record. The
 * id of a record is made from the bot, the run of update ids and the update id, and the offset to
 * ask from is read back from the journal while it is recent, so a restart neither loses an update
 * nor writes one twice. Only the owner's private chat, and the owner in it, is a way into niwa: a
 * message or a press of a button from anywhere else is written down as ignored, without its
 * text, and nothing it sends is done with the owner's rights.
 *
 * The surface speaks for the owner only as an instance configured with `speaksFor`, and then only
 * for input from the owner's chat. Without it the surface is a plain client: an answer from the
 * owner's chat is refused by the requests module, which lets only the addressee answer.
 *
 * What waits for the owner is one list, and this chat is one view of it. A request addressed to
 * the owner is posted as a message, and the message is the way back to the request. The owner
 * answers it by a button (a choice, a confirmation, a permission) or by replying to the message
 * (a text, the numbers of a multiple choice, or a text of his own where the question allows one);
 * the answer is given by calling "request.answer" as the owner. A form is not filled here: the
 * message says where to answer it.
 *
 * A button carries the place of its answer and nothing else: Telegram gives a callback 64 bytes,
 * and the id of a request is longer. A press is written down as it came, and a handler finds the
 * request in the record of the message, by bot, chat and message.
 */

import { NotSent, OptionIdSchema, action, client, optionsOf, owner, providerWrote, questionLines, record } from "@niwa-labs/core";
import type { Action, ActionContext, Answer, Caller, JournalReader, Outcome, RecordType, SpeaksFor, StoredRecord } from "@niwa-labs/core";
import { AgentTurnFailed, AgentTurnQueued, AgentTurnReplied, agentTell } from "@niwa-labs/agent/records";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin, PluginApi, ServiceContext } from "@niwa-labs/plugin";
import { createHash } from "node:crypto";

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
  operatorAnswered,
  requestAsk,
} from "@niwa-labs/requests/records";

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
  type UserId,
  type UpdateId,
} from "./bot.ts";

export const TELEGRAM_SEND = "telegram.send";
export const TELEGRAM_RECEIVED = "telegram.received";
export const TELEGRAM_IGNORED = "telegram.ignored";
export const TELEGRAM_REQUEST = "telegram.request";
export const TELEGRAM_PRESS = "telegram.press";
export const TELEGRAM_ACKNOWLEDGE = "telegram.acknowledge";
export const TELEGRAM_TO_AGENT = "telegram.to-agent";
export const TELEGRAM_POST_REQUEST = "telegram.post-request";

/** The options of what the owner is asked when his message did not reach the agent. */
const RETRY = OptionIdSchema.parse("retry");
const CANCEL = OptionIdSchema.parse("cancel");

/**
 * What the owner is asked when his message did not reach the agent, or may not have.
 *
 * `mayHaveArrived` says whether the agent may already have taken the message: a delivery that was
 * cut off, or that failed after it began, leaves that open, and a retry then repeats the command.
 */
function undelivered(text: string, mayHaveArrived: boolean) {
  return question("telegram.undelivered", {
    kind: "choice",
    title: undeliveredText(text, mayHaveArrived),
    options: [
      { id: RETRY, label: mayHaveArrived ? "send again" : "retry", flavor: "plain" },
      { id: CANCEL, label: "cancel", flavor: "plain" },
    ],
  });
}

/** How much of the message the question quotes. */
const QUOTE_LENGTH = 80;

/** The words that tell the owner what became of his message, with the beginning of it. */
function undeliveredText(text: string, mayHaveArrived: boolean): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // By code points, so an emoji is never cut in half.
  const points = Array.from(flat);
  const quote = points.length > QUOTE_LENGTH ? `${points.slice(0, QUOTE_LENGTH).join("")}...` : flat;
  return mayHaveArrived
    ? `Your message may already have reached the agent: "${quote}". Sending it again repeats it, and the agent may act on it twice. Send it again only if you know it did not arrive, or cancel.`
    : `Your message was NOT delivered to the agent: "${quote}". Retry the delivery or cancel it.`;
}

/** Whether a delivery that ended so may nevertheless have reached the agent. */
function mayHaveArrived(outcome: Outcome<unknown>): boolean {
  switch (outcome.status) {
    case "completed":
    case "unknown":
      return true;
    case "failed":
      return outcome.effectPossible;
    case "denied":
    case "cancelled":
      return false;
  }
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

/**
 * Where an update came from: the bot, and the run of update ids it belongs to.
 *
 * Telegram numbers updates in sequence, but starts again from an arbitrary number after a week
 * without any, and another bot has a numbering of its own. An update is told apart by its
 * numbering and its number, so a number seen again in a new run is a new update, never a repeat.
 */
const Source = {
  /** The id of the bot, the part of its token that is not secret. */
  bot: z.string(),
  /** The run of update ids: the moment it began. */
  epoch: z.number(),
};

/** A message that came in from the owner's chat. */
export const Received = record(
  TELEGRAM_RECEIVED,
  z.object({
    ...Source,
    update: updateSchema,
    chat: chatSchema,
    message: messageSchema,
    text: z.string(),
    /** Who wrote it, as Telegram names them. */
    from: z.string().optional(),
    /** The message it replies to, when it is a reply. */
    reply: messageSchema.optional(),
  }),
  { providerOnly: "telegram" },
);

/** A message from another chat: not the owner's, so only the fact of it is kept. */
export const Ignored = record(
  TELEGRAM_IGNORED,
  z.object({ ...Source, update: updateSchema, chat: chatSchema, message: messageSchema }),
  { providerOnly: "telegram" },
);

/** A request that was posted to the owner, with the buttons that answer it. */
export const Posted = record(
  TELEGRAM_REQUEST,
  z.object({
    /** The bot that sent it: a message id is only unique within the chat of one bot. */
    bot: z.string(),
    /** The id of the request: the message is the way back to it. */
    request: RequestId,
    chat: chatSchema,
    message: messageSchema,
    /** The name of the question that was asked. */
    question: z.string(),
    /** The kind of the question: it says how a reply is read. */
    kind: z.enum(["choice", "multi", "confirm", "text", "form", "permission"]),
    /** Whether a text of the owner's own is an answer too. */
    allowOther: z.boolean(),
    /** The choices the buttons stand for, in the order of the buttons. */
    choices: z.array(z.string()),
  }),
  { providerOnly: "telegram" },
);

/**
 * The press of a button in the owner's chat, as it came: written before the offset passes it, so
 * a press is never lost to the time it takes to find what it answers.
 */
export const Pressed = record(
  TELEGRAM_PRESS,
  z.object({
    ...Source,
    update: updateSchema,
    chat: chatSchema,
    /** The message the button is under. */
    message: messageSchema,
    /** The id of the press, which the acknowledgement answers. */
    query: z.string(),
    /** What the button carried back. */
    data: z.string(),
  }),
  { providerOnly: "telegram" },
);

/** The poller writes directly from its installed service after validating the Bot API update. */
function fromPoller(record: StoredRecord): boolean {
  return record.actor.kind === "host" && record.actor.issuedBy === undefined;
}

/** A day, in milliseconds: how long Telegram keeps an update nobody confirmed. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The record types the polling service restores its offset from. */
const OFFSET_TYPES = [Received, Ignored, Pressed];

export const TelegramReplyDelivery = record("telegram.reply.delivery", z.object({
  turn: z.string(), bot: z.string(), chat: chatSchema, replyTo: messageSchema,
  status: z.enum(["sent", "unsent", "possibly-sent"]), sentParts: z.number().int().nonnegative(),
  reason: z.string().optional(),
}));

export interface TelegramOptions {
  /** The agent whose conversations this bot delivers in both directions. */
  readonly agent?: string;
  /** The token of the bot: what Telegram gave it. */
  readonly token: string;
  /** The private chat of the owner: its id is the owner's user id, and it is positive. Only this chat is read. */
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
  /**
   * How long the offset of the polls is trusted after the last update it passed, in milliseconds.
   * Telegram keeps an update for a day and starts its numbering anew only after a week without
   * updates, so past a day the offset is dropped and a new run of numbers begins. Default: a day.
   */
  readonly offsetTtl?: number;
}

export interface TelegramHooks {
  /**
   * Send a message to the owner's main agent, when the messages plugin is present.
   *
   * The hook runs inside the action that delivers the message, with its context. A call it makes
   * with `ctx.step.outcome` is made by this surface, so with `speaksFor` it is the owner's, as long
   * as the composition gives the modules that bind callers the binding of this instance.
   *
   * It returns what became of the delivery, the outcome of its last call: a call that failed, was
   * denied or was cut short is reported to the owner, who is asked whether to send again. A hook
   * that calls with `ctx.step` instead pauses the invocation on any outcome but success, and the
   * owner is never told. A hook that returns nothing delivered; one that throws did not, though it
   * may have got part of the way.
   *
   * Without it the message stays in the journal and the agent reads it there.
   */
  toAgent?: (text: string, ctx: ActionContext) => Promise<Outcome<unknown> | void>;
}

/** Where an update was numbered: what its record ids are made from. */
interface UpdateSource {
  readonly bot: string;
  readonly epoch: number;
}

/** The id of the record of an incoming message: its source and update id, so a repeat is harmless. */
export function receivedId(source: UpdateSource, update: UpdateId): string {
  return `rec_telegram_${source.bot}_${String(source.epoch)}_${String(update)}`;
}

/** The id of the record of a message from another chat. */
function ignoredId(source: UpdateSource, update: UpdateId): string {
  return `rec_telegram_ignored_${source.bot}_${String(source.epoch)}_${String(update)}`;
}

/** The id of the record of a button press. */
function pressedId(source: UpdateSource, update: UpdateId): string {
  return `rec_telegram_press_${source.bot}_${String(source.epoch)}_${String(update)}`;
}

/**
 * The id of a bot, as its records name it: the number its token starts with, which is public. A
 * token of another shape is named by a digest, never by itself.
 */
export function botIdOf(token: string): string {
  const head = token.split(":")[0] ?? "";
  return /^\d+$/.test(head) ? head : `h${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
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
  readonly botId: string;
  private readonly offsetTtl: number;
  private emit: ServiceContext["emit"] | undefined;
  private now: ServiceContext["now"] | undefined;
  private journal: JournalReader | undefined;
  private offset = 0;
  /** The run of update ids the offset belongs to. */
  private epoch = 0;
  /** When the last update was handled, or the run began. */
  private lastActivity = 0;

  constructor(opts: TelegramOptions, hooks: TelegramHooks) {
    this.bot =
      opts.bot ??
      createBot({ token: opts.token, ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }) });
    this.owner = opts.owner;
    this.botId = botIdOf(opts.token);
    this.offsetTtl = opts.offsetTtl ?? DAY_MS;
    this.pollTimeout = opts.pollTimeout ?? 25;
    this.retryDelay = opts.retryDelay ?? 250;
    this.hooks = hooks;
  }

  get client(): Bot {
    return this.bot;
  }

  /**
   * Start polling. The offset continues after the newest update of this bot the journal holds, as
   * long as that update is recent; the returned function stops the loop and the poll in flight.
   */
  start(ctx: ServiceContext, journal: JournalReader | undefined): () => void {
    this.emit = ctx.emit;
    this.now = () => ctx.now();
    this.journal = journal;
    this.newRun();
    if (journal !== undefined) {
      const mine = journal
        .since(0 as never, OFFSET_TYPES.map((type) => type.name))
        .filter((stored) => fromPoller(stored) && (stored.data as { bot?: string }).bot === this.botId);
      const newest = mine.at(-1);
      if (newest !== undefined && ctx.now() - newest.at <= this.offsetTtl) {
        const epoch = (newest.data as { epoch: number }).epoch;
        const known = mine.filter((stored) => (stored.data as { epoch: number }).epoch === epoch);
        this.epoch = epoch;
        this.lastActivity = newest.at;
        this.offset = Math.max(...known.map((stored) => (stored.data as { update: number }).update + 1));
      }
    }
    const abort = new AbortController();
    void this.poll(abort.signal);
    return () => {
      abort.abort();
      this.emit = undefined;
    };
  }

  /** Begin a run of update ids: nothing is known of them, so Telegram is asked from the first it holds. */
  private newRun(): void {
    const moment = this.now?.() ?? 0;
    this.epoch = moment;
    this.lastActivity = moment;
    this.offset = 0;
  }

  /** Drop an offset nobody has used for so long that Telegram may have numbered anew. */
  private expire(): void {
    if (this.offset !== 0 && this.now !== undefined && this.now() - this.lastActivity > this.offsetTtl) this.newRun();
  }

  private get source(): UpdateSource {
    return { bot: this.botId, epoch: this.epoch };
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.expire();
        const updates = await this.bot.getUpdates(this.offset, this.pollTimeout, signal);
        for (const update of updates) {
          // Below the offset is an update already handled: Telegram may hand it out again.
          if (update.update_id < this.offset) continue;
          await this.handle(update);
          this.offset = update.update_id + 1;
          this.lastActivity = this.now?.() ?? this.lastActivity;
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

    // Who is speaking is the chat and the sender of the update, never anything the text says.
    if (!this.isOwner(message.chat, message.from)) {
      await this.write(
        Ignored,
        { ...this.source, update: update.update_id, chat: message.chat.id, message: message.message_id },
        ignoredId(this.source, update.update_id),
      );
      return;
    }

    const text = message.text ?? "";
    await this.write(
      Received,
      {
        ...this.source,
        update: update.update_id,
        chat: message.chat.id,
        message: message.message_id,
        text,
        ...(message.from?.username === undefined ? {} : { from: message.from.username }),
        ...(message.reply_to_message === undefined ? {} : { reply: message.reply_to_message.message_id }),
      },
      receivedId(this.source, update.update_id),
    );
  }

  /**
   * Whether the update comes from the owner: the owner's private chat, and the owner in it.
   *
   * A private chat has the id of the one who writes in it, so both must say the owner. A group
   * that happens to be configured, or a message forwarded into one, is not the owner: the people
   * in a group are not the owner, whatever the chat id.
   */
  private isOwner(chat: { readonly id: ChatId; readonly type: string }, from: { readonly id: UserId } | undefined): boolean {
    return chat.type === "private" && chat.id === this.owner && from !== undefined && (from.id as number) === (this.owner as number);
  }

  /** A button was pressed: it is written down, and a handler makes it the owner's answer to the request the message shows. */
  private async handleCallback(
    update: UpdateId,
    query: NonNullable<Update["callback_query"]>,
  ): Promise<void> {
    const message = query.message;
    if (message === undefined) return;
    // The chat of the message and the one who pressed decide: a press of another is noted, never
    // obeyed. (A message id is only unique within its chat, so it is not looked up before this check.)
    if (!this.isOwner(message.chat, query.from)) {
      await this.write(
        Ignored,
        { ...this.source, update, chat: message.chat.id, message: message.message_id },
        ignoredId(this.source, update),
      );
      return;
    }
    // The press is written down as it came, and the offset passes it only after that. What it
    // answers is looked up by a handler, which may take as long as it must.
    await this.write(
      Pressed,
      {
        ...this.source,
        update,
        chat: message.chat.id,
        message: message.message_id,
        query: query.id,
        data: query.data ?? "",
      },
      pressedId(this.source, update),
    );
  }

  private async write<T>(type: RecordType<T>, data: T, id?: string): Promise<void> {
    if (this.emit === undefined) throw new Error("the telegram service is not running");
    await this.emit(type, data, id === undefined ? undefined : { id });
  }
}

/** The input of the action that sends a message. */
const SendInput = z.object({ text: z.string(), replyTo: messageSchema.optional() });

/**
 * The action that sends a message to the owner's chat.
 *
 * The message is plain text: the buttons of a message answer a request, and a request is posted by
 * `telegram.post-request`, which also writes down which request the message shows.
 *
 * A send is not idempotent and Telegram takes no key: a call that was cut off may have been
 * delivered, so it is not repeated.
 */
export function telegramSend(opts: {
  bot: Bot;
  owner: ChatId;
}): Action<z.infer<typeof SendInput>, { messageId: MessageId; chat: ChatId }, z.input<typeof SendInput>> {
  return action(TELEGRAM_SEND, {
    description: "Send a text message to the owner's Telegram chat.",
    input: SendInput,
    output: z.object({ messageId: messageSchema, chat: chatSchema }),
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    run: async (input) => {
      if (input.text.length === 0 || (input.text.length > MESSAGE_LIMIT && [...input.text].length > MESSAGE_LIMIT)) throw new NotSent("Telegram text must contain 1 to 4096 characters");
      const sent = await opts.bot.sendMessage(opts.owner, input.text, undefined, input.replyTo);
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
  // Only a private chat is the owner's, and its id is a positive number: the id of a group is
  // negative, and a surface told to speak for the owner in one would speak for everyone in it.
  if (!Number.isSafeInteger(opts.owner) || opts.owner <= 0) {
    throw new Error(`the owner of the telegram surface must be a private chat, whose id is positive: got ${String(opts.owner)}`);
  }
  if (opts.agent !== undefined && (opts.speaksFor !== "owner" || hooks.toAgent !== undefined)) {
    throw new Error("A Telegram agent conversation requires an owner binding and a single delivery target");
  }
  const service = new TelegramService(opts, hooks);
  const send = telegramSend({ bot: service.client, owner: opts.owner });

  const acknowledge = action(TELEGRAM_ACKNOWLEDGE, {
    description: "Tell Telegram that a press of a button was seen, with a word for the one who pressed it.",
    input: z.object({ query: z.string(), text: z.string().max(200).optional() }),
    output: z.object({}),
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    run: async (input) => {
      await service.client.answerCallbackQuery(input.query, input.text);
      return {};
    },
  });

  const toAgent = hooks.toAgent;
  const deliver = action(TELEGRAM_TO_AGENT, {
    description: "Hand a message of the owner's chat to the owner's main agent.",
    input: z.object({ text: z.string() }),
    output: z.object({}),
    recovery: "do-not-repeat",
    effect: "write",
    world: "local",
    run: async (input, ctx) => {
      const outcome = await toAgent?.(input.text, ctx);
      if (outcome === undefined || outcome.status === "completed") return {};
      // The outcome of the call says whether the agent may have the message, and so does the
      // outcome of this action: it is what the owner is told.
      switch (outcome.status) {
        case "denied":
        case "cancelled":
          throw new NotSent(outcome.reason);
        case "failed":
          throw outcome.effectPossible ? new Error(outcome.error) : new NotSent(outcome.error);
        case "unknown":
          throw new Error("it is not known whether the agent took the message");
      }
    },
  });

  /** The journal, when the host gives the plugin one: the requests are read from it. */
  let journal: (() => JournalReader | undefined) | undefined;

  /** Post a request addressed to the owner: what it asks, as the message and the buttons that answer it. */
  const postRequest = action(TELEGRAM_POST_REQUEST, {
    description: "Show an open request addressed to the owner in the owner's Telegram chat.",
    input: z.object({ request: RequestId }),
    output: z.object({ messageId: messageSchema, chat: chatSchema }),
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    run: async (input, ctx) => {
      const reader = journal?.();
      const created = reader === undefined ? undefined : createdOf(reader, input.request);
      if (created === undefined) throw new NotSent(`there is no request "${input.request}"`);
      if (created.to.kind !== "owner") throw new NotSent(`the request "${input.request}" is not addressed to the owner`);
      if (reader !== undefined && endedIn(reader, input.request)) throw new NotSent(`the request "${input.request}" is ended`);
      const options = optionsOf(created.input);
      const shown = render(created);
      const sent = await service.client.sendMessage(opts.owner, shown.text, shown.keyboard);
      await ctx.emit(Posted, {
        bot: service.botId,
        request: created.id,
        chat: opts.owner,
        message: sent.message_id,
        question: created.question,
        kind: created.input.kind,
        allowOther: "allowOther" in created.input && created.input.allowOther,
        choices: options.map((option) => option.id),
      });
      return { messageId: sent.message_id, chat: opts.owner };
    },
  });

  const built = plugin(PLUGIN_NAME, (api: PluginApi) => {
    journal = () => api.journal?.();
    api.declare(Received, Ignored, Posted, Pressed, TelegramReplyDelivery);
    if (opts.agent !== undefined) {
      api.needs({ actions: [agentTell], types: [AgentTurnQueued, AgentTurnFailed, AgentTurnReplied] });
      api.on(AgentTurnFailed, { id: "inbox-failure", from: "start" }, async (failed, step, record) => {
        if (!providerWrote(record, "agents") || failed.agent !== opts.agent) return;
        const row = api.journal?.()?.find({ type: AgentTurnQueued.name, field: "turn", equals: failed.turn }).find((row) => providerWrote(row, "agents"));
        const route = AgentTurnQueued.schema.safeParse(row?.data).data?.replyTo;
        if (route?.channel !== "telegram" || route.bot !== service.botId || route.chat !== opts.owner) return;
        const status = failed.status === "unsent" ? "The agent did not receive this message" : "Delivery to the agent is uncertain";
        await step.outcome(send, { text: fit(`${status}: ${failed.reason}`), replyTo: messageSchema.parse(route.message) });
      });
      api.on(AgentTurnReplied, { id: "reply", from: "start", concurrency: Number.POSITIVE_INFINITY }, async (reply, step, record) => {
        if (!providerWrote(record, "agents")) return;
        const route = reply.replyTo;
        if (reply.agent !== opts.agent || route.channel !== "telegram" || route.bot !== service.botId || route.chat !== opts.owner) return;
        const replyTo = messageSchema.parse(route.message);
        const destination = { turn: reply.turn, bot: route.bot, chat: opts.owner, replyTo };
        let sentParts = 0;
        for (const text of telegramParts(reply.text)) {
          const outcome = await step.outcome(send, { text, replyTo }, { key: `part-${sentParts}` });
          if (outcome.status !== "completed") {
            await step.emit(TelegramReplyDelivery, { ...destination, sentParts, status: mayHaveArrived(outcome) ? "possibly-sent" : "unsent", reason: reasonOf(outcome) });
            return;
          }
          sentParts++;
        }
        await step.emit(TelegramReplyDelivery, { ...destination, sentParts, status: "sent" });
      });
    }
    api.action(send);
    api.action(postRequest);
    api.action(acknowledge);
    // Without a hook nothing is delivered, so no action says that something was.
    if (toAgent !== undefined) api.action(deliver);

    // The poll loop only records. Delivery is a step of this handler, so it never holds up the
    // messages after it. A delivery that failed, or was cut off by a restart, is never resent by
    // itself: the owner is asked, and only his "retry" delivers again.
    // A message the agent cannot take waits for the owner's word: the messages after it do not.
    api.on(Received, { id: "agent", concurrency: Number.POSITIVE_INFINITY }, async (data, step, record) => {
      if (!fromPoller(record) || data.bot !== service.botId || data.chat !== opts.owner || data.text.trim() === "") return;
      // A reply to the message that shows a request answers it: it is the owner's answer, not a
      // word to the agent.
      const shown =
        data.reply === undefined ? undefined : await postedFor(api, { bot: data.bot, chat: data.chat, message: data.reply }, 0);
      if (shown !== undefined) {
        const read = answerFromReply(shown, data.text);
        if ("problem" in read) return void (await step.outcome(send, { text: fit(read.problem) }));
        const outcome = await step.outcome(REQUEST_ANSWER, { id: shown.request, answer: read.answer });
        if (outcome.status === "completed") return void (await step.outcome(send, { text: `Answered: ${shown.question}` }));
        const reason = reasonOf(outcome);
        console.error(`niwa: telegram: the request "${shown.request}" was not answered: ${reason}`);
        return void (await step.outcome(send, { text: fit(`Your answer was not accepted: ${reason}`) }));
      }
      const agent = opts.agent;
      if (agent === undefined && toAgent === undefined) return;
      for (;;) {
        const outcome = agent === undefined
          ? await step.outcome(deliver, { text: data.text })
          : await step.outcome(agentTell, {
              agent, text: data.text, replyTo: { channel: "telegram", bot: data.bot, chat: data.chat, message: data.message },
            });
        if (outcome.status === "completed") return;
        let answer: Answer;
        try {
          ({ answer } = answeredBy(
            await step(requestAsk, { to: { kind: "owner" }, answerPolicy: "owner-only", ...undelivered(data.text, mayHaveArrived(outcome)) }),
          ));
        } catch (error) {
          if (error instanceof RequestCancelled) return;
          throw error;
        }
        if (!("ids" in answer) || answer.ids[0] !== RETRY) return;
      }
    });
    api.service((ctx) => service.start(ctx, api.journal?.()));

    // A request addressed to the owner is shown to him: a message with the choices as buttons.
    // Each request is posted on its own: a post that fails is reported and leaves the requests
    // after it alone. A new subscription reads from the start, so a request that was open before
    // this surface was installed is posted too; one that is ended or already shown is passed over.
    api.on(RequestCreated, { id: "request", from: "start" }, async (data: Created, step, record) => {
      if (!providerWrote(record, "requests") || data.to.kind !== "owner") return;
      if (ended(api, data.id) || postedTo(api, data.id, service.botId, opts.owner)) return;
      const outcome = await step.outcome(postRequest, { request: data.id });
      if (outcome.status === "completed") return;
      console.error(`niwa: telegram: the request "${data.id}" was not posted: ${reasonOf(outcome)}`);
    });

    // A press of a button is the owner's answer: the request is answered, and the one who asked
    // goes on. The press says at once what became of it: a toast on the button, and a message
    // when the answer was not taken, so a refusal is never mistaken for an answer. A press on a
    // request that is not open any more is refused, and nothing waits for a decision.
    api.on(Pressed, { id: "press", concurrency: Number.POSITIVE_INFINITY }, async (data, step, record) => {
      if (!fromPoller(record) || data.bot !== service.botId || data.chat !== opts.owner) return;
      const told = async (toast: string, notice?: string): Promise<void> => {
        await step.outcome(acknowledge, { query: data.query, text: toast });
        if (notice !== undefined) await step.outcome(send, { text: fit(notice) });
      };
      const parsed = parseCallback(data.data);
      if (parsed === undefined) return void (await told("Unknown button"));
      const posted = await postedFor(api, { bot: data.bot, chat: data.chat, message: data.message }, POSTED_WAIT_MS);
      const answer = posted?.choices[parsed.index];
      if (posted === undefined || answer === undefined) {
        return void (await told("Not accepted", "That button does not belong to a request that is open here."));
      }
      const outcome = await step.outcome(REQUEST_ANSWER, { id: posted.request, answer: { ids: [OptionIdSchema.parse(answer)] } });
      if (outcome.status === "completed") return void (await told("Answer sent"));
      const reason = reasonOf(outcome);
      console.error(`niwa: telegram: the request "${posted.request}" was not answered: ${reason}`);
      await told("Not accepted", `Your answer was not accepted: ${reason}`);
    });
  });
  const ownerHandlers = new Set([`${PLUGIN_NAME}/agent`, `${PLUGIN_NAME}/press`]);
  const bind = (fallback: CallerBinding = bindingOf()): CallerBinding => {
    return (caller: Caller) => {
      if (caller.kind === "handler" && ownerHandlers.has(caller.handler)) {
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
  return journal !== undefined && endedIn(journal, request);
}

function endedIn(journal: JournalReader, request: string): boolean {
  const onlyOwner = createdOf(journal, request)?.answerPolicy === "owner-only";
  return END_TYPES.some((type) => journal.find({ type, field: "id", equals: request }).some((row) =>
    providerWrote(row, "requests") && (!onlyOwner || type !== RequestAnswered.name || operatorAnswered(row))));
}

/** The request as it was created, when the journal holds it. */
function createdOf(journal: JournalReader, request: string): Created | undefined {
  const found = journal.find({ type: RequestCreated.name, field: "id", equals: request }).find((row) => providerWrote(row, "requests"));
  if (found === undefined) return undefined;
  const parsed = RequestCreated.schema.safeParse(found.data);
  return parsed.success ? parsed.data : undefined;
}

/** Whether the request is already shown in the chat of the bot: one message of it is enough. */
function postedTo(api: PluginApi, request: string, bot: string, chat: ChatId): boolean {
  const journal = api.journal?.();
  if (journal === undefined) return false;
  return journal.find({ type: Posted.name, field: "request", equals: request }).some((stored) => {
    const parsed = Posted.schema.safeParse(stored.data);
    return providerWrote(stored, "telegram") && parsed.success && parsed.data.bot === bot && parsed.data.chat === chat;
  });
}

/** A message of a chat of a bot: a message id alone is not unique. */
interface MessageAddress {
  readonly bot: string;
  readonly chat: ChatId;
  readonly message: MessageId;
}

/**
 * The request a message shows, when the record of that message is committed.
 *
 * The record is written right after the message is sent, so a press that arrives before it is
 * committed waits for it up to `waitMs`: the owner pressed a button, and the press is not lost.
 */
async function postedFor(
  api: PluginApi,
  at: MessageAddress,
  waitMs: number,
): Promise<z.infer<typeof Posted.schema> | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = api
      .journal?.()
      ?.find({ type: Posted.name, field: "message", equals: at.message })
      .flatMap((stored) => {
        const parsed = Posted.schema.safeParse(stored.data);
        return providerWrote(stored, "telegram") && parsed.success && parsed.data.bot === at.bot && parsed.data.chat === at.chat ? [parsed.data] : [];
      })
      .at(-1);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(POSTED_POLL_MS);
  }
}

/** The most a message of Telegram holds, in the units Telegram counts: UTF-16 code units. */
const MESSAGE_LIMIT = 4096;

/** Split long replies without losing text or cutting a surrogate pair. */
function* telegramParts(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MESSAGE_LIMIT, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(start, end);
    start = end;
  }
}

/** The text, cut to fit `room` units, with a note where it was cut. */
export function fit(text: string, room: number = MESSAGE_LIMIT): string {
  if (text.length <= room) return text;
  const note = "\n[cut]";
  let end = room - note.length;
  // Never between the two halves of a character outside the basic plane.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${note}`;
}

/** Why a step did not complete, in a few words. */
function reasonOf(outcome: Exclude<Outcome<unknown>, { status: "completed" }>): string {
  switch (outcome.status) {
    case "denied":
    case "cancelled":
      return outcome.reason;
    case "failed":
      return outcome.error;
    case "unknown":
      return "the outcome is not known";
  }
}

/** A request as the owner sees it: the message, and the buttons when its answers are buttons. */
function render(created: Created): { text: string; keyboard?: InlineKeyboard } {
  const asked = created.input;
  const options = optionsOf(asked);
  const other = "allowOther" in asked && asked.allowOther;
  const body = [created.question, ...questionLines(asked)].join("\n");
  let footer: string;
  let keyboard: InlineKeyboard | undefined;
  switch (asked.kind) {
    case "choice":
    case "confirm":
    case "permission":
      keyboard = keyboardFor(options.map((option) => option.label));
      footer = other ? "Or reply to this message with your own answer." : "";
      break;
    case "multi":
      footer = [
        ...options.map((option, index) => `${String(index + 1)}. ${option.label}`),
        other
          ? "Reply to this message with the numbers of your choices, for example 1, 3, or with your own answer."
          : "Reply to this message with the numbers of your choices, for example 1, 3.",
      ].join("\n");
      break;
    case "text":
      footer = "Reply to this message with your answer.";
      break;
    case "form":
      footer = `This asks for a form, which cannot be filled in here: answer request ${created.id} in the cockpit or with the CLI.`;
      break;
  }
  if (footer === "") return { text: fit(body), ...(keyboard === undefined ? {} : { keyboard }) };
  // The footer says how to answer: it stays whole when the question is cut.
  const room = MESSAGE_LIMIT - Math.min(footer.length, MESSAGE_LIMIT / 2) - 1;
  return { text: fit(`${fit(body, room)}\n${footer}`), ...(keyboard === undefined ? {} : { keyboard }) };
}

/** What a request is, as the record of its post keeps it. */
type PostedData = z.infer<typeof Posted.schema>;

/**
 * The answer a reply to a posted request makes, or why it makes none.
 *
 * A text question takes the text. A question with options takes the numbers of the options the
 * message lists (one for a choice, any for a multi), or the text itself when it allows another
 * answer. A form cannot be filled in a chat: the owner is told where to answer it.
 */
export function answerFromReply(posted: PostedData, text: string): { answer: Answer } | { problem: string } {
  const said = text.trim();
  switch (posted.kind) {
    case "text":
      return { answer: { text: said } };
    case "form":
      return { problem: `That request is a form, which cannot be filled in here: answer request ${posted.request} in the cockpit or with the CLI.` };
    case "choice":
    case "multi":
    case "confirm":
    case "permission": {
      const count = posted.choices.length;
      if (/^\d+(?:[\s,]+\d+)*$/.test(said)) {
        const places = [...new Set(said.split(/[\s,]+/).map(Number))];
        const ids = places.map((place) => posted.choices[place - 1]);
        const bad = places.find((_, index) => ids[index] === undefined);
        if (bad !== undefined) return { problem: `There is no option ${String(bad)}: reply with a number from 1 to ${String(count)}.` };
        if (posted.kind !== "multi" && ids.length !== 1) return { problem: "Reply with the number of one option." };
        return { answer: { ids: ids.map((id) => OptionIdSchema.parse(id)) } };
      }
      if (posted.allowOther) return { answer: { text: said } };
      return { problem: `Reply with the number of an option, from 1 to ${String(count)}.` };
    }
  }
}

export { createBot, chatId } from "./bot.ts";
export type { Bot, ChatId, InlineKeyboard, InlineButton, MessageId, Update, UpdateId, UserId } from "./bot.ts";
