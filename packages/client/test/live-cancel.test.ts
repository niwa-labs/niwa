// A live subscription gives its socket back when the consumer stops, even on a channel that says nothing.

import { expect, test } from "bun:test";

import { connect } from "../src/index.ts";
import { quietHost, within } from "./helpers.ts";

test("returning a live subscription wakes the read that waits on a quiet channel and releases the socket", async () => {
  const host = quietHost();
  const client = await connect({ home: host.home });
  try {
    const frames = client.live.subscribe("quiet")[Symbol.asyncIterator]();
    const waiting = frames.next();
    // The subscription has its own socket, next to the one of the calls.
    expect(await within(2_000, () => host.accepted() === 2)).toBe(true);
    const stopped = await Promise.race([frames.return?.().then(() => "returned"), Bun.sleep(2_000).then(() => "stuck")]);
    expect(stopped).toBe("returned");
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(await within(2_000, () => host.ended() === 1)).toBe(true);
  } finally {
    await client.close();
    host.stop();
  }
}, 15_000);
