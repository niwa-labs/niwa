import { expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";

import { OpenCodePipe } from "../src/pipe-client.ts";
import { PIPE_ORIGIN, encodeFrame, readFrames } from "../src/pipe-wire.ts";
import type { PipeCommand, PipeReply } from "../src/pipe-wire.ts";

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const failed = mock(() => {});
  const pipe = new OpenCodePipe({ stdin, stdout }, failed);
  const commands = readFrames<PipeCommand>(stdin);
  const reply = (frame: PipeReply) => stdout.write(encodeFrame(frame));
  reply({ kind: "ready" });
  return { pipe, commands, reply, failed, stdin, stdout };
}

function headers(id: number, hasBody: boolean): PipeReply {
  return { kind: "headers", id, status: hasBody ? 200 : 204, statusText: "", headers: [], hasBody };
}

test("a paused event stream leaves other API calls available and sends one demand per read", async () => {
  const { pipe, commands, reply, stdin, stdout } = fixture();
  await pipe.ready;
  try {
    const subscribed = pipe.fetch(`${PIPE_ORIGIN}/api/events`);
    expect((await commands.next()).value).toMatchObject({ kind: "request", id: 1, path: "/api/events" });
    reply(headers(1, true));
    const response = await subscribed;

    const called = pipe.fetch(`${PIPE_ORIGIN}/api/session`);
    expect((await commands.next()).value).toMatchObject({ kind: "request", id: 2, path: "/api/session" });
    reply(headers(2, false));
    expect((await called).status).toBe(204);

    const reader = response.body!.getReader();
    const received = reader.read();
    expect((await commands.next()).value).toEqual({ kind: "pull", id: 1 });
    const payload = Buffer.from('data: {"text":"你好"}\n\n');
    reply({ kind: "chunk", id: 1, base64: payload.toString("base64") });
    expect(Buffer.from((await received).value!)).toEqual(payload);
    await reader.cancel();
    expect((await commands.next()).value).toEqual({ kind: "cancel", id: 1 });
  } finally {
    stdin.end();
    stdout.end();
  }
});

test("cancellation releases its request and EOF rejects requests still waiting for headers", async () => {
  const { pipe, commands, failed, stdin, stdout } = fixture();
  await pipe.ready;
  try {
    const abort = new AbortController();
    const one = pipe.fetch(`${PIPE_ORIGIN}/api/one`, { signal: abort.signal });
    expect((await commands.next()).value).toMatchObject({ id: 1, path: "/api/one" });
    abort.abort();
    await expect(one).rejects.toMatchObject({ name: "AbortError" });
    expect((await commands.next()).value).toEqual({ kind: "cancel", id: 1 });

    const two = pipe.fetch(`${PIPE_ORIGIN}/api/two`);
    expect((await commands.next()).value).toMatchObject({ id: 2, path: "/api/two" });
    stdout.end();
    await expect(two).rejects.toThrow(/closed its pipe/);
    expect(failed).toHaveBeenCalledTimes(1);
  } finally {
    stdin.end();
    stdout.end();
  }
});
