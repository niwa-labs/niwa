/**
 * bot.ts — a tiny client of the Telegram Bot API.
 *
 * Only `fetch` and the Telegram API itself: no SDK, no dependency, nothing that decides what a
 * message means. This file knows how to ask Telegram to do something and how to read what it
 * says back; everything else — who the owner is, what a message means — belongs to index.ts.
 *
 * The API base is a parameter, so a test can point the client at a fake server and watch
 * exactly what it would have sent to the real one.
 */

import { z } from "zod";

/** Domain identifiers of Telegram. Branded: a bare number is not accepted where one is expected. */
export const chatSchema = z.number().brand<"ChatId">();
export const userSchema = z.number().brand<"UserId">();
export const updateSchema = z.number().brand<"UpdateId">();
export const messageSchema = z.number().brand<"MessageId">();
export type ChatId = z.infer<typeof chatSchema>;
export type UserId = z.infer<typeof userSchema>;
export type UpdateId = z.infer<typeof updateSchema>;
export type MessageId = z.infer<typeof messageSchema>;

/** A chat id, as Telegram gave it. */
export const chatId = (n: number): ChatId => chatSchema.parse(n);

/** The default base of the Telegram Bot API. */
export const API_BASE = "https://api.telegram.org";

/** One keyboard button. */
export interface InlineButton {
  /** The text on the button. */
  readonly text: string;
  /**
   * The data the button carries back when it is pressed.
   *
   * It is the callback of the button: Telegram hands it back with the press, and that is how
   * the press is matched with the thing it answers.
   */
  readonly callback_data: string;
}

/** The keyboard under a message. */
export interface InlineKeyboard {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<InlineButton>>;
}

/** One update from Telegram: something happened in a chat. */
export interface Update {
  readonly update_id: UpdateId;
  readonly message?: {
    readonly message_id: MessageId;
    readonly chat: { readonly id: ChatId; readonly type: string };
    readonly date: number;
    readonly text?: string;
    readonly from?: { readonly id: UserId; readonly username?: string };
    /** The message this one answers, when the sender replied to one. */
    readonly reply_to_message?: { readonly message_id: MessageId };
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly message?: {
      readonly message_id: MessageId;
      readonly chat: { readonly id: ChatId; readonly type: string };
    };
    readonly from?: { readonly id: UserId; readonly username?: string };
  };
}

/** What the Bot API says about a call. */
export interface BotResult<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

/** A message the client sent. */
export interface SentMessage {
  readonly message_id: MessageId;
  readonly chat: { readonly id: number };
  readonly text?: string;
}

/** The client of the Bot API of one bot. */
export interface Bot {
  /** The updates from the offset on. Telegram forgets the updates below the offset. */
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<Update[]>;

  /** Send a text message to a chat. */
  sendMessage(chat: ChatId, text: string, keyboard?: InlineKeyboard): Promise<SentMessage>;

  /**
   * Tell Telegram a press of a button was seen, with a short word to show the one who pressed it.
   * Until then the button shows that it is waiting.
   */
  answerCallbackQuery(query: string, text?: string): Promise<void>;
}

/** The options of the client. */
export interface BotOptions {
  /** The token of the bot: what Telegram gave it. */
  readonly token: string;
  /** The base of the API. The real one, unless a test says otherwise. */
  readonly apiBase?: string;
}

/**
 * The client of the Bot API.
 *
 * Every call goes through one place: the URL is built here, the body is JSON, and the answer
 * is checked here. A failure of Telegram is an error with Telegram's own words.
 */
export function createBot(opts: BotOptions): Bot {
  const apiBase = (opts.apiBase ?? API_BASE).replace(/\/$/, "");
  const token = opts.token;

  /**
   * The URL carries the token, and anything that came back may quote the URL: the token is never
   * let out in an error, in either of the forms it can be written in a path.
   */
  const redact = (text: string): string =>
    [token, encodeURIComponent(token)].reduce(
      (kept, secret) => (secret === "" ? kept : kept.replaceAll(secret, "<token>")),
      text,
    );

  /** One call to the Bot API. */
  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${apiBase}/bot${token}/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new Error(`telegram ${method} failed: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(
        `telegram ${method} answered ${String(response.status)} and its body could not be read: ${redact(error instanceof Error ? error.message : String(error))}`,
      );
    }
    let parsed: BotResult<T>;
    try {
      parsed = JSON.parse(text) as BotResult<T>;
    } catch {
      // The body of something that is not the Bot API is never quoted: it may echo the request.
      throw new Error(`telegram answered ${method} with ${String(response.status)} and a body that is not JSON`);
    }
    if (!parsed.ok) {
      const reason = parsed.description === undefined ? `code ${String(parsed.error_code)}` : redact(parsed.description).slice(0, 200);
      throw new Error(`telegram refused ${method} (${String(response.status)}): ${reason}`);
    }
    if (parsed.result === undefined) {
      throw new Error(`telegram answered ${method} without a result`);
    }
    return parsed.result;
  }

  return {
    async getUpdates(offset, timeoutSeconds, signal) {
      return call<Update[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
        signal,
      );
    },

    async sendMessage(chat, text, keyboard) {
      return call<SentMessage>("sendMessage", {
        chat_id: chat,
        text,
        ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
      });
    },

    async answerCallbackQuery(query, text) {
      await call<boolean>("answerCallbackQuery", {
        callback_query_id: query,
        ...(text === undefined ? {} : { text }),
      });
    },
  };
}
