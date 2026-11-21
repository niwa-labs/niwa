// The wait between reconnect attempts leaves nothing behind.

import { expect, test } from "bun:test";

import { RetryPause } from "../src/pause.ts";

test("a cancel ends the wait at once", async () => {
  const pause = new RetryPause();
  const waiting = pause.wait(60_000);
  pause.cancel();
  expect(await Promise.race([waiting.then(() => "ended"), Bun.sleep(1_000).then(() => "stuck")])).toBe("ended");
});

test("a wait that ran out holds nothing: a later cancel is a no-op", async () => {
  const pause = new RetryPause();
  await pause.wait(5);
  pause.cancel();
  await pause.wait(5);
});
