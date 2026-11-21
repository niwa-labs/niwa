// Live frames.
//
// The scenario runs against a real host process (fixtures/live-frames-host.ts):
//
//   1. a subscriber connects to the channel "chat"
//   2. a message is written: the handler sends a live frame, and the subscriber receives it
//   3. the journal holds the record and no frame: a frame is not a record
//   4. a subscriber that connected late received none of the frames, and still receives
//      the complete record
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import type { LiveFrame, StoredRecord } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { CHANNEL, Message, sendFrame } from "./fixtures/live-frames-host.ts";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/live-frames-host.ts", import.meta.url));

/** From the beginning of the journal. */
const FROM_START = seq(0);

/**
 * Collect the records through the public subscription.
 *
 * A subscription never ends by itself, so the collection stops itself: it waits for the
 * journal to settle and then closes the subscription.
 */
async function readJournal(
  client: Awaited<ReturnType<typeof connect>>,
  settleMs = 500,
): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  const reading = (async () => {
    for await (const record of client.records.since()) {
      records.push(record);
    }
  })().catch(() => {});
  await Bun.sleep(settleMs);
  await client.close().catch(() => {});
  await reading;
  return records;
}

/**
 * Listen to a channel until it has heard as many frames as it should.
 *
 * The frames are collected in the background; the caller waits for the count and then stops
 * the subscription by closing the client.
 */
function listen(
  client: Awaited<ReturnType<typeof connect>>,
  channel: string,
): { frames: LiveFrame[]; done: Promise<void>; ready: Promise<void> } {
  const frames: LiveFrame[] = [];
  const subscription = client.live.subscribe(channel);
  const done = (async () => {
    for await (const frame of subscription) {
      frames.push(frame);
    }
  })().catch(() => {});
  return { frames, done, ready: subscription.ready };
}

test("live frames: a subscriber receives the frames, the journal holds none of them, and a late subscriber still receives the complete record", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let late: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    client = await connectAsOwner(homePath);

    // 1. A subscriber connects to the channel.
    const subscriber = listen(client, CHANNEL);
    await subscriber.ready;

    // 2. A message is written. The handler sends a live frame, and the
    //    subscriber receives it.
    const written = await client.emit(Message, { text: "hello" });
    await eventually(
      () => subscriber.frames.length === 1,
      10_000,
      "the subscriber should receive the live frame",
    );
    expect(subscriber.frames[0]?.channel).toBe(CHANNEL);
    expect(subscriber.frames[0]?.data).toEqual({ partial: "hello" });

    // 3. The journal holds the record and no frame. The frame is not a record:
    //    it was never written.
    const records = await readJournal(await connectAsOwner(homePath));
    expect(records.some((entry) => entry.id === written.id)).toBe(true);
    expect(records.some((entry) => entry.type === CHANNEL)).toBe(false);
    expect(JSON.stringify(records)).not.toContain("partial");
    const recordsBefore = records.length;

    // 4. A subscriber that connected late received none of the frames, and
    //    still receives the complete record.
    late = await connectAsOwner(homePath);
    const lateSubscriber = listen(late, CHANNEL);
    await lateSubscriber.ready;

    // The frames sent before the late subscriber connected are gone: they were
    // not received by it, and they are not in the journal either.
    expect(lateSubscriber.frames).toHaveLength(0);

    // A frame sent now reaches it.
    await client.call(sendFrame, { text: "later" });
    await eventually(
      () => lateSubscriber.frames.length === 1,
      10_000,
      "the late subscriber should receive the frames sent after it connected",
    );
    expect(lateSubscriber.frames[0]?.data).toEqual({ partial: "later" });

    // A frame sent by a client goes the same way: heard, and written nowhere.
    await client.live.send(CHANNEL, { channel: CHANNEL, data: { partial: "from a client" } });
    await eventually(
      () => lateSubscriber.frames.length === 2,
      10_000,
      "the late subscriber should receive a frame sent by a client",
    );
    expect(lateSubscriber.frames[1]?.data).toEqual({ partial: "from a client" });

    // And it still receives the complete record — the frames are not the
    // message, the record is.
    const lateRecords = await readJournal(await connectAsOwner(homePath));
    const found = lateRecords.find((entry) => entry.id === written.id);
    expect(found).toBeDefined();
    expect(found?.type).toBe(Message.name);
    expect(found?.data).toEqual({ text: "hello" });

    // Three frames were sent since the first read, and the journal did not grow by one record.
    expect(lateRecords).toHaveLength(recordsBefore);
    expect(JSON.stringify(lateRecords)).not.toContain("from a client");
  } finally {
    await client?.close().catch(() => {});
    await late?.close().catch(() => {});
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
