// The local feed of a channel: it ends when its reader returns, and it holds a bounded backlog.

import { expect, test } from "bun:test";
import type { LiveFrame } from "@niwa-labs/core";

import { LiveBus, LiveFeed, MAX_QUEUED_FRAMES } from "../src/index.ts";

const frame = (n: number): LiveFrame => ({ channel: "c", data: n });

async function settles<T>(work: Promise<T>): Promise<T | "stuck"> {
  return await Promise.race([work, Bun.sleep(1_000).then(() => "stuck" as const)]);
}

test("returning while a read waits on a quiet channel ends the read and leaves the channel", async () => {
  const bus = new LiveBus();
  const stream = bus.subscribe("c").iterate();
  const waiting = stream.next();
  expect(await settles(stream.return())).toEqual({ done: true, value: undefined });
  expect(await settles(waiting)).toEqual({ done: true, value: undefined });
  // The channel has no listener left: a frame sent now finds nobody.
  const late = bus.subscribe("c").iterate();
  bus.send("c", frame(1));
  expect((await late.next()).value).toEqual(frame(1));
});

test("returning before the first read leaves the channel", async () => {
  let left = false;
  const stream = new LiveFeed(() => {
    left = true;
  }).iterate();
  await stream.return();
  expect(left).toBe(true);
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});

test("a reader that is slower than the sender loses the oldest frames", async () => {
  const bus = new LiveBus();
  const stream = bus.subscribe("c").iterate();
  const total = MAX_QUEUED_FRAMES + 10;
  for (let n = 0; n < total; n += 1) bus.send("c", frame(n));
  const first = await stream.next();
  expect(first.value).toEqual(frame(10));
  let rest = 0;
  for (; rest < MAX_QUEUED_FRAMES - 1; rest += 1) await stream.next();
  expect(rest).toBe(MAX_QUEUED_FRAMES - 1);
  bus.send("c", frame(-1));
  expect((await stream.next()).value).toEqual(frame(-1));
  await stream.return();
});
