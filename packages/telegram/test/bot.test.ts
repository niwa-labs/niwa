// The client of the Bot API never lets its token out in an error, whatever Telegram, or what stands
// in its place, says back.

import { expect, test } from "bun:test";

import { createBot } from "../src/bot.ts";
import { chatId } from "../src/index.ts";

const TOKEN = "123456:secret-token/with+chars";

/** A server that answers every call with the given response, quoting the path it was called on. */
function echoing(respond: (path: string) => Response): { base: string; stop(): void } {
  const server = Bun.serve({ port: 0, fetch: (request) => respond(new URL(request.url).pathname) });
  return { base: server.url.toString().replace(/\/$/, ""), stop: () => void server.stop(true) };
}

async function failure(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the call should have failed");
}

test("bot: a body that is not JSON is not quoted, so an echoed path cannot leak the token", async () => {
  const server = echoing((path) => new Response(`<html>no such path ${path}</html>`, { status: 502 }));
  try {
    const bot = createBot({ token: TOKEN, apiBase: server.base });
    const message = await failure(() => bot.sendMessage(chatId(1), "hi"));
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(encodeURIComponent(TOKEN));
    expect(message).toContain("sendMessage");
    expect(message).toContain("502");
  } finally {
    server.stop();
  }
});

test("bot: the description of a refusal is redacted", async () => {
  const server = echoing((path) => Response.json({ ok: false, error_code: 404, description: `Not Found: ${path}` }, { status: 404 }));
  try {
    const bot = createBot({ token: TOKEN, apiBase: server.base });
    const message = await failure(() => bot.getUpdates(0, 0));
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(encodeURIComponent(TOKEN));
    expect(message).toContain("Not Found");
  } finally {
    server.stop();
  }
});

test("bot: a body that breaks off while it is read does not leak the token", async () => {
  const real = globalThis.fetch;
  // A body that fails the way a dropped connection does, quoting the URL it was read from.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error(`connection lost on ${String(input)}`));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  try {
    const bot = createBot({ token: TOKEN, apiBase: "http://telegram.invalid" });
    const message = await failure(() => bot.sendMessage(chatId(1), "hi"));
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(encodeURIComponent(TOKEN));
    expect(message).toContain("sendMessage");
    expect(message).toContain("connection lost");
  } finally {
    globalThis.fetch = real;
  }
});
