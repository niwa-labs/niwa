// A cancelled wait releases what it holds, on the host and across the wire.
//
//   1. a caller that aborts its request — a single wait or a group wait — is released at once,
//      well before the next poll: the commit waiter it held is dropped, and the refusal it gets is
//      the cancellation's own. The turns it waited on are left exactly as they were: they settle
//      and are waited for again, and a caller that never asked to cancel is not disturbed;
//   2. the same over the wire: a cancelled call is stopped on the host, a retry under the same
//      operation id runs again and answers what the turn settled to, and the settled operation
//      answers the same to the call after it.
//
// The host-side half is checked in-process, where only the host's own release of the wait can end
// the call; the wire half with a spawned host checks the cancellation travelling the transport.

import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { connectAsOwner, spawnHost, tempHome } from "@niwa-labs/testing";

import { sessionStart, sessionTurnSend, sessionTurnWait, sessionTurnWaitMany } from "../src/index.ts";
import { fakeHost, HARNESS, INSTRUCTIONS, SESSION } from "./fixtures/restart-host.ts";

const HOST = new URL("./fixtures/restart-host.ts", import.meta.url).pathname;

/** What an aborted call rejects with, and how long it took to come back. */
async function refused(call: Promise<unknown>): Promise<{ name: string; ms: number }> {
  const at = Date.now();
  const error: unknown = await call.then(
    (value) => new Error(`the call answered instead: ${JSON.stringify(value)}`),
    (caught: unknown) => caught,
  );
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : String(error);
  return { name, ms: Date.now() - at };
}

test("an aborted wait is released at once and leaves the turns and the other callers live", async () => {
  const home = await tempHome();
  const client = fakeHost(home.path, true);
  const write = (lines: string) => appendFileSync(join(home.path, INSTRUCTIONS), lines);
  try {
    await client.serve();
    const started = await client.call(sessionStart, { harness: HARNESS, prompt: "open", operation: "open" });
    const handle = started.handle!;

    // A caller of its own, waiting on the same handle with no cancellation to its name.
    const independent = client.call(sessionTurnWait, { ...handle, timeoutMs: 8000 });

    // The group wait the caller will cancel: with its deadline far away and nothing settling,
    // only the host releasing its waiter can end it now.
    const group = new AbortController();
    const cancelledGroup = client.call(
      sessionTurnWaitMany, { handles: [handle], until: "all", timeoutMs: 8000 }, { signal: group.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    group.abort();
    const gone = await refused(cancelledGroup);
    expect(gone.name).toBe("AbortError");
    expect(gone.ms).toBeLessThan(500);

    // The single wait cancels the same way, on a turn of its own.
    const second = await client.call(sessionTurnSend, { session: SESSION, message: "two", operation: "two" });
    const single = new AbortController();
    const cancelledSingle = client.call(
      sessionTurnWait, { ...second.handle, timeoutMs: 8000 }, { signal: single.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    single.abort();
    const goneSingle = await refused(cancelledSingle);
    expect(goneSingle.name).toBe("AbortError");
    expect(goneSingle.ms).toBeLessThan(500);

    // The cancelled turns were nothing of the host's business: they settle, the caller that never
    // cancelled is answered, and both handles are waited for again, alone and as a group.
    write("turn-started 1\nturn-started 2\nturn-ended 1 completed after cancel\nturn-ended 2 completed second answer\n");
    expect(await independent).toEqual({ status: "completed", value: "after cancel" });
    expect(await client.call(sessionTurnWait, { ...second.handle, timeoutMs: 3000 })).toEqual({ status: "completed", value: "second answer" });
    expect(await client.call(sessionTurnWaitMany, { handles: [handle, second.handle], until: "all", timeoutMs: 3000 })).toEqual({
      done: [
        { index: 0, handle, result: { status: "completed", value: "after cancel" } },
        { index: 1, handle: second.handle, result: { status: "completed", value: "second answer" } },
      ],
      pending: [],
      timedOut: false,
    });
  } finally {
    await client.close();
    await home.cleanup();
  }
}, 20_000);

test("a cancelled wait over the wire stops on the host, and the operation stays exact", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST, home.path, ["--tracked"]);
  try {
    await host.ready();
    const client = await connectAsOwner(home.path);
    try {
      const started = await client.call(sessionStart, { harness: HARNESS, prompt: "open", operation: "wire-open" });
      const handle = started.handle!;

      // The cancelled call runs under an operation id, as a caller that retries would make it.
      const controller = new AbortController();
      const cancelled = client.call(
        sessionTurnWaitMany, { handles: [handle], until: "all", timeoutMs: 9000 },
        { operation: "wire-wait", signal: controller.signal },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      const gone = await refused(cancelled);
      expect(gone.name).toBe("AbortError");
      expect(gone.ms).toBeLessThan(500);

      // The host stopped the first call: the retry under the same id runs again instead of waiting
      // out the dead deadline of the call it replaced, and answers when the turn settles. A retry
      // that outruns the unwind shares the dying call's cancellation — that is what the operation
      // answered — so it is made again until the operation is free.
      appendFileSync(join(home.path, INSTRUCTIONS), "turn-started 1\nturn-ended 1 completed wire answer\n");
      const cancelledByHost = (error: unknown): boolean =>
        typeof error === "object" && error !== null &&
        ((error as { name?: unknown }).name === "AbortError" || (error as { code?: unknown }).code === "AbortError");
      const retryUnder = async (): Promise<unknown> => {
        for (;;) {
          try {
            return await client.call(
              sessionTurnWaitMany, { handles: [handle], until: "all", timeoutMs: 9000 }, { operation: "wire-wait" },
            );
          } catch (error) {
            if (!cancelledByHost(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      };
      const retry = await retryUnder();
      expect(retry).toEqual({
        done: [{ index: 0, handle, result: { status: "completed", value: "wire answer" } }],
        pending: [],
        timedOut: false,
      });

      // The operation settled: an identical call under it answers the same, and the turn with it.
      const again = await retryUnder();
      expect(again).toEqual(retry);
      expect(await client.call(sessionTurnWait, { ...handle, timeoutMs: 3000 })).toEqual({ status: "completed", value: "wire answer" });
    } finally {
      await client.close();
    }
  } finally {
    await host.stop();
    await home.cleanup();
  }
}, 20_000);
