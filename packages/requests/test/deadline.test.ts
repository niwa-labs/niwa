// A request whose deadline passed takes no answer, even before the timer has written the expiry.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { owner } from "@niwa-labs/core";
import { connectAsOwner, createNiwa, pick, tempHome, testClock } from "@niwa-labs/testing";

import { REQUEST_ANSWER, REQUEST_ASK, REQUEST_GET, requests } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("an answer after the deadline is not accepted before the timer ran, and the request is expired", async () => {
  const home = await tempHome();
  // The clock is not advanced, so the timer never fires: only the answer can notice the deadline.
  const host = createNiwa({ home: home.path, clock: testClock(1_700_000_000_000) });
  host.use(requests());
  await host.serve();
  const client = await connectAsOwner(home.path);
  cleanups.push(async () => {
    await client.close();
    await host.close();
    await home.cleanup();
  });

  const { id } = z.object({ id: z.string() }).parse(
    await client.call(REQUEST_ASK, {
      to: owner,
      question: "q.late",
      input: { kind: "choice", title: "Go?", options: [{ id: "yes", label: "Yes", flavor: "plain" }] },
      deadline: 0,
    }),
  );
  const answered = await client.call(REQUEST_ANSWER, { id, answer: pick("yes") });
  expect(answered).toEqual({ id, accepted: false, reason: "expired" });
  expect(await client.call(REQUEST_GET, { id })).toMatchObject({ status: "expired" });
});
