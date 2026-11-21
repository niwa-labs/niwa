// Catching up.
//
// The scenario runs against real host processes (fixtures/catch-up-host.ts), in
// two variants chosen by argv[3]:
//
//   1. spawn the host in the variant "nohandler": the plugin declares the type
//      Item, but no handler is installed
//   2. emit Item { n: 1 } … Item { n: 5 }; they are written and stay unhandled
//   3. stop the host — a clean shutdown
//   4. spawn the host in the variant "handler", whose handler asks for the
//      history: it catches up with what the journal holds, and every item is handled — the action "seen" is called
//      once per item, and the records the core writes for the outcomes carry
//      the number of the item, so the order of the handling is visible
//   5. the five items were handled exactly once each, and in order
//   6. stop the host, spawn it again in the same variant: the counts stay at
//      five — nothing is handled a second time
//
// The count is the count of real calls to the stub, and the order is read from
// the journal through records.since — the public way to read what happened.
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Item } from "./fixtures/catch-up-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/catch-up-host.ts", import.meta.url));

/** The type the core writes when it admits an invocation. */
const ADMITTED_TYPE = "niwa.invocation.admitted";

/** The type the core writes for the outcome of a step. */
const OUTCOME_TYPE = "niwa.step.outcome";

/** The type the core writes for every change of an invocation's state. */
const STATE_TYPE = "niwa.invocation.state";

/** The handler of the items. */
const ITEM_HANDLER = "catch-up/catch-up.item";

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** The data of a CORE.invocationAdmitted record. */
const Admitted = z.object({
  invocation: z.string(),
  handler: z.string(),
  record: z.string(),
});

/** The data of a CORE.stepOutcome record: { invocation, key, outcome }. */
const StepOutcome = z.object({
  invocation: z.string(),
  key: z.string(),
  outcome: z.object({
    status: z.string(),
    value: z.unknown().optional(),
  }),
});

/** The data of a CORE.invocationState record: { invocation, state, reason? }. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
});

/** The number of an item, as the outcome of the "seen" step carries it. */
const Handled = z.object({ n: z.number() });

/** The data of an Item record: { n }. */
const ItemData = z.object({ n: z.number() });

/**
 * The numbers of the items the journal holds, in the order the journal holds
 * them: the items themselves, not their handling.
 */
function itemNumbers(records: StoredRecord[]): number[] {
  const numbers: number[] = [];
  for (const record of records) {
    if (record.type !== Item.name) continue;
    const parsed = ItemData.safeParse(record.data);
    if (parsed.success) numbers.push(parsed.data.n);
  }
  return numbers;
}

/**
 * A host process of one variant.
 *
 * The variant is the third argument of the program, and the helper of
 * `spawnHost` of "@niwa-labs/testing" passes the home only, so the check spawns the process itself.
 */
interface VariantHost {
  readonly pid: number;
  /** Resolves when the host accepts a connection on its socket. */
  ready(): Promise<void>;
  /** Stop the host: SIGTERM, and the host closes the journal itself. */
  stop(): Promise<void>;
  /** What the host printed, for the report of a failure. */
  output(): string;
}

/** Spawn the host program of one variant: `bun <script> <home> <variant>`. */
function spawnVariant(home: string, variant: string): VariantHost {
  const child = Bun.spawn([process.execPath, HOST_SCRIPT, home, variant], {
    cwd: resolve(HOST_SCRIPT, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const chunks: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (stream === null) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }));
      const tail = decoder.decode();
      if (tail) chunks.push(tail);
    } catch {
      // The stream was closed with the process: what was read is what there is.
    }
  };
  void collect(child.stdout);
  void collect(child.stderr);

  let gone = false;
  void child.exited.then(() => {
    gone = true;
  });

  return {
    pid: child.pid,
    async ready(): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const probe = await connectAsOwner(home);
          await probe.close();
          return;
        } catch {
          if (gone) {
            throw new Error(
              `the host process exited before it was ready.\n--- output ---\n${chunks.join("")}`,
            );
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `the host did not accept a connection within 10000 ms.\n--- output ---\n${chunks.join("")}`,
            );
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
    },
    async stop(): Promise<void> {
      if (gone) {
        await child.exited;
        return;
      }
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
      ]);
      if (!exited) child.kill("SIGKILL");
      await child.exited;
    },
    output(): string {
      return chunks.join("");
    },
  };
}

/** The invocations the host admitted, in the order the journal holds them. */
function admittedInvocations(records: StoredRecord[]): string[] {
  const invocations: string[] = [];
  for (const record of records) {
    if (record.type !== ADMITTED_TYPE) continue;
    const parsed = Admitted.safeParse(record.data);
    if (parsed.success && parsed.data.handler === ITEM_HANDLER) invocations.push(parsed.data.invocation);
  }
  return invocations;
}

/**
 * The numbers of the items that were handled, in the order the outcomes were
 * written: that is the order the handler worked in.
 */
function handledNumbers(records: StoredRecord[]): number[] {
  const numbers: number[] = [];
  for (const record of records) {
    if (record.type !== OUTCOME_TYPE) continue;
    const parsed = StepOutcome.safeParse(record.data);
    if (!parsed.success) continue;
    if (parsed.data.outcome.status !== "completed") continue;
    const value = Handled.safeParse(parsed.data.outcome.value);
    if (value.success) numbers.push(value.data.n);
  }
  return numbers;
}

/**
 * The latest state of every invocation the journal holds.
 *
 * A catch-up that went wrong would show here: an invocation that ended as
 * "paused" or is still "running" was not handled.
 */
function latestStates(records: StoredRecord[]): Map<string, string> {
  const states = new Map<string, string>();
  for (const record of records) {
    if (record.type !== STATE_TYPE) continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success) states.set(parsed.data.invocation, parsed.data.state);
  }
  return states;
}

test("catching up: the items are handled exactly once and in order, and a restart handles nothing twice", async () => {
  const home = await tempHome();
  const homePath = home.path;
  const clients: Array<{ close(): Promise<void> }> = [];
  const hosts: VariantHost[] = [];

  try {
    // 1. A host without the handler: it receives the items and does not handle
    //    them.
    const writer = spawnVariant(homePath, "nohandler");
    hosts.push(writer);
    await writer.ready();

    const client = await connectAsOwner(homePath);
    clients.push(client);
    const reader = await connectAsOwner(homePath);
    clients.push(reader);
    const before: StoredRecord[] = [];
    const readBefore = (async () => {
      for await (const record of reader.records.since(FROM_START)) {
        before.push(record);
      }
    })().catch(() => {});

    // 2. Five items, written while nobody handles them.
    for (const n of [1, 2, 3, 4, 5]) {
      await client.emit(Item, { n });
    }
    expect(counter(homePath, "seen").count()).toBe(0);

    // The items are in the journal, and nothing handled them: the host without
    // the handler admitted no invocation at all.
    await eventually(
      () => itemNumbers(before).length === 5,
      15_000,
      "the five items should be in the journal",
    );
    expect(itemNumbers(before)).toEqual([1, 2, 3, 4, 5]);
    expect(admittedInvocations(before).length).toBe(0);
    expect(handledNumbers(before).length).toBe(0);
    expect(counter(homePath, "seen").count()).toBe(0);

    // 3. The host is stopped — a clean shutdown, not a crash.
    await writer.stop();
    await client.close().catch(() => {});
    await reader.close().catch(() => {});
    await readBefore;

    // 4. The host with the handler starts and catches up with the journal.
    const catcher = spawnVariant(homePath, "handler");
    hosts.push(catcher);
    await catcher.ready();

    const observer = await connectAsOwner(homePath);
    clients.push(observer);
    const seen: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of observer.records.since(FROM_START)) {
        seen.push(record);
      }
    })().catch(() => {});

    // 5. Every item is handled, exactly once.
    await eventually(
      () => counter(homePath, "seen").count() === 5,
      15_000,
      "the five items should have been handled by the host with the handler",
    );

    expect(counter(homePath, "seen").count()).toBe(5);

    // The observer reads the journal: it sees the admissions and the outcomes.
    await eventually(
      () => admittedInvocations(seen).length === 5,
      15_000,
      "the observer should have read the five admissions from the journal",
    );

    // One invocation per item: the handler was admitted five times, not more.
    const invocations = admittedInvocations(seen);
    expect(invocations.length).toBe(5);
    expect(new Set(invocations).size).toBe(5);

    // Each item was handled exactly once, and the items were handled in order.
    await eventually(
      () => handledNumbers(seen).length === 5,
      15_000,
      "the observer should have read the five outcomes from the journal",
    );
    const numbers = handledNumbers(seen);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);

    // Every invocation ended as done: none of them paused or hung. The state record follows the
    // outcome, so it is waited for.
    await eventually(
      () => invocations.every((invocation) => latestStates(seen).get(invocation) === "done"),
      15_000,
      "every invocation should have ended as done",
    );

    // 6. A restart handles nothing a second time: the counts stay at five.
    await catcher.stop();
    await observer.close().catch(() => {});
    await watch;

    const restarted = spawnVariant(homePath, "handler");
    hosts.push(restarted);
    await restarted.ready();

    // The restarted host had time to catch up, and it had nothing to do.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));

    expect(counter(homePath, "seen").count()).toBe(5);

    const afterRestart = await connectAsOwner(homePath);
    clients.push(afterRestart);
    const again: StoredRecord[] = [];
    const watchAgain = (async () => {
      for await (const record of afterRestart.records.since(FROM_START)) {
        again.push(record);
      }
    })().catch(() => {});

    // The journal holds the same five admissions and the same five outcomes:
    // the restart handled nothing a second time.
    await eventually(
      () => admittedInvocations(again).length === 5 && handledNumbers(again).length === 5,
      15_000,
      "the reader should have read the journal after the restart",
    );
    expect(admittedInvocations(again).length).toBe(5);
    expect(handledNumbers(again)).toEqual([1, 2, 3, 4, 5]);
    expect(counter(homePath, "seen").count()).toBe(5);

    // The restart added no state of its own: the five invocations kept the
    // state they had, and no sixth one was admitted.
    const afterStates = latestStates(again);
    for (const invocation of admittedInvocations(again)) {
      expect(afterStates.get(invocation)).toBe("done");
    }
    await afterRestart.close().catch(() => {});
    await watchAgain;
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    for (const host of hosts) {
      await host.stop().catch(() => {});
    }
    await home.cleanup();
  }
}, 60_000);
