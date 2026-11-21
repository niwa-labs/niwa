/**
 * live.ts — the live stream of frames that are not recorded.
 *
 * A frame is never a source of truth and never reaches the journal. A subscriber that is not
 * listening when a frame is sent misses it: there is no history, no cursor and no replay.
 */

import type { LiveFrame } from "@niwa-labs/core";

import type { LiveSubscription } from "./client-types.ts";

/** The name of a channel: a key that travels through the socket, so no empty name and no whitespace. */
export function channelName(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`a channel name must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) {
    throw new TypeError("a channel name must not be empty");
  }
  if (/\s/.test(value)) {
    throw new TypeError(`a channel name must not contain whitespace: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The frame that goes on a channel. The frame names its own channel and it must agree with the
 * one it is sent on: a frame for another channel is a bug in the sender, not something to move.
 */
export function frameFor(channel: string, frame: LiveFrame): LiveFrame {
  const name = channelName(channel);
  if (frame.channel !== name) {
    throw new TypeError(`the frame names the channel "${frame.channel}" but it is sent on "${name}"`);
  }
  return { channel: name, data: frame.data };
}

/** Frames a listener holds for a consumer that reads slowly; past it the oldest frame is dropped. */
export const MAX_QUEUED_FRAMES = 1024;

/** One listener of one channel: the frames are queued until the consumer takes them. */
export class LiveFeed {
  private readonly queue: LiveFrame[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  /**
   * The frames from now on, until the feed is closed. Returning from the iterator closes the feed
   * first, so a read that waits on a quiet channel ends with it, and a feed that was never read
   * leaves its channel all the same. The feed is registered already: it is ready.
   */
  iterate(): LiveSubscription {
    const frames = this.frames();
    const subscription: LiveSubscription = {
      [Symbol.asyncIterator]() { return this; },
      next: () => frames.next(),
      return: () => {
        this.close();
        return frames.return();
      },
      ready: Promise.resolve(),
    };
    return subscription;
  }

  private async *frames(): AsyncGenerator<LiveFrame, void, undefined> {
    try {
      for (;;) {
        const frame = this.queue.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      this.close();
    }
  }

  push(frame: LiveFrame): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUED_FRAMES) this.queue.shift();
    this.queue.push(frame);
    this.wake();
  }

  /** No more frames come; the feed leaves its channel. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/** The channels, and the feeds listening to each. A channel nobody listens to does not exist. */
export class LiveBus {
  private readonly channels = new Map<string, Set<LiveFeed>>();
  private closed = false;

  /** Hand the frame to the feeds listening right now. */
  send(channel: string, frame: LiveFrame): void {
    for (const feed of this.channels.get(channel) ?? []) feed.push(frame);
  }

  /** Listen to a channel. The feed is registered before it is returned. */
  subscribe(channel: string): LiveFeed {
    const feed: LiveFeed = new LiveFeed(() => {
      const feeds = this.channels.get(channel);
      feeds?.delete(feed);
      if (feeds?.size === 0) this.channels.delete(channel);
    });
    if (this.closed) {
      feed.close();
      return feed;
    }
    let feeds = this.channels.get(channel);
    if (feeds === undefined) {
      feeds = new Set<LiveFeed>();
      this.channels.set(channel, feeds);
    }
    feeds.add(feed);
    return feed;
  }

  /** Every feed ends. */
  close(): void {
    this.closed = true;
    for (const feeds of [...this.channels.values()]) {
      for (const feed of [...feeds]) feed.close();
    }
  }
}
