// Replacing a plugin.
//
// The scenario runs against a real host process (fixtures/plugin-replace-host.ts):
//
//   1. spawn the host, connect a client, emit Start { n: 1 }
//   2. the handler of plugin "p" waits for Answer { n: 1 }; the invocation is waiting
//   3. call "fixture.upgrade" — plugin "p" is replaced by its changed version
//   4. emit Answer { n: 1 } — the waiting invocation finishes on the OLD code:
//      "v1-finish" was called once, "v2-run" and "v2-finish" were not called at all
//   5. emit Start { n: 2 } — the new record is handled by the NEW code: "v2-run"
//   6. call "fixture.unload" — plugin "p" is unloaded
//   7. emit Start { n: 3 } — no handler of "p" runs any more, so "v2-run" stays at 1
//   8. every record plugin "p" wrote is still returned by records.since(0)
//
// Only the public API is used: the entries of the packages (types, connect, seq) and "@niwa-labs/testing".

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { StoredRecord } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Answer, Start, unload, upgrade } from "./fixtures/plugin-replace-host.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/plugin-replace-host.ts", import.meta.url));

/** The data of a CORE.invocationState record: { invocation, state, reason? }. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
});

/** The data of a Start record: { n }. */
const StartData = z.object({ n: z.number() });

/** The data of a record as a plain object, or undefined when it is not one. */
function asObject(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/**
 * The state of the invocation that a record woke, as a state record says it.
 *
 * An invocation is identified by the handler and the record that woke it
 *, so the id of that record is what tells the
 * two invocations of this check apart.
 */
function stateOf(record: StoredRecord, wokenBy: string): string | undefined {
  if (record.type !== "niwa.invocation.state") return undefined;
  const parsed = InvocationState.safeParse(record.data);
  if (!parsed.success) return undefined;
  if (!parsed.data.invocation.includes(wokenBy)) return undefined;
  return parsed.data.state;
}

/**
 * True for a record written for plugin "p".
 *
 * The runtime writes the records of a handler on its behalf, with the handler's
 * id as the actor, and it admits an invocation with the handler's id in the
 * data. A handler id is the plugin's name and the handler's own name
 *.
 */
function isWrittenByP(record: StoredRecord): boolean {
  if (record.actor.kind === "handler") return record.actor.handler.startsWith("p/");
  const handler = asObject(record.data)?.["handler"];
  return typeof handler === "string" && handler.startsWith("p/");
}

/** True for a Start record with the given number. */
function isStart(record: StoredRecord, n: number): boolean {
  if (record.type !== Start.name) return false;
  const parsed = StartData.safeParse(record.data);
  return parsed.success && parsed.data.n === n;
}

test("replacing a plugin: the waiting invocation finishes on the old code, a new record is handled by the new code, and after the unload the records stay readable", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let observer: Awaited<ReturnType<typeof connect>> | undefined;
  let subscription: Promise<void> | undefined;

  try {
    // 1. The host, with plugin "p" in its first version, and a client.
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();

    client = await connectAsOwner(homePath);

    // The observer reads the journal through the public subscription.
    observer = await connectAsOwner(homePath);
    const seen: StoredRecord[] = [];
    subscription = (async () => {
      for await (const record of observer.records.since(seq(0))) {
        seen.push(record);
      }
    })().catch(() => {});

    // 2. The invocation of plugin "p" waits for its answer. Nothing has run
    //    yet: the handler of v1 waits first.
    const start1 = await client.emit(Start, { n: 1 });

    await eventually(
      () => seen.some((record) => stateOf(record, start1.id) === "waiting"),
      10_000,
      "the invocation of plugin p should be waiting for its answer",
    );
    expect(counter(homePath, "v1-finish").count()).toBe(0);
    expect(counter(homePath, "v2-run").count()).toBe(0);

    // 3. The plugin is replaced by a changed version of the same plugin.
    const upgraded = await client.call(upgrade, {});
    expect(upgraded.ok).toBe(true);

    // 4. The answer wakes the waiting invocation, and it finishes on the OLD
    //    code: the new code runs "v2-run" before the wait, so a "v2-run" here
    //    would mean the invocation had moved onto the new version.
    await client.emit(Answer, { n: 1 });
    await eventually(
      () => counter(homePath, "v1-finish").count() === 1,
      10_000,
      "the old code should have finished the waiting invocation",
    );
    await eventually(
      () => seen.some((record) => stateOf(record, start1.id) === "done"),
      10_000,
      "the invocation should have ended as done",
    );
    expect(counter(homePath, "v1-finish").count()).toBe(1);
    expect(counter(homePath, "v2-finish").count()).toBe(0);
    expect(counter(homePath, "v2-run").count()).toBe(0);

    // 5. A new record is handled by the NEW code.
    const start2 = await client.emit(Start, { n: 2 });

    await eventually(
      () => counter(homePath, "v2-run").count() === 1,
      10_000,
      "the new code should have handled the new record",
    );
    // The new code runs, then waits. Waiting is where it stops until the
    // answer, and by then every record of this invocation is committed.
    await eventually(
      () => seen.some((record) => stateOf(record, start2.id) === "waiting"),
      10_000,
      "the invocation of the new code should be waiting for its answer",
    );
    expect(counter(homePath, "v1-finish").count()).toBe(1);

    // 6. The plugin is unloaded. Its handlers, actions and declarations go;
    //    the records it wrote stay.
    const unloaded = await client.call(unload, {});
    expect(unloaded.ok).toBe(true);

    // 7. After the unload its handlers do not run any more. The record is
    //    still written — the control plugin declares the type — but no
    //    handler of plugin "p" picks it up.
    let start3: StoredRecord;
    try {
      start3 = await client.emit(Start, { n: 3 });
    } catch (error) {
      throw new Error(
        "the record after the unload could not be written: the type of plugin p must stay " +
          "declared by a plugin that is still installed",
        { cause: error },
      );
    }
    await eventually(
      () => seen.some((record) => isStart(record, 3)),
      10_000,
      "the start record after the unload should be in the journal",
    );
    await Bun.sleep(500);
    const admittedFor3 = seen.filter(
      (record) =>
        record.type === "niwa.invocation.admitted" &&
        asObject(record.data)?.["record"] === start3.id,
    );
    expect(admittedFor3).toEqual([]);
    // The same filter does find the invocations that did run: the check is not vacuous.
    expect(seen.some((record) => record.type === "niwa.invocation.admitted" && asObject(record.data)?.["record"] === start2.id)).toBe(true);
    expect(counter(homePath, "v2-run").count()).toBe(1);
    expect(counter(homePath, "v2-finish").count()).toBe(0);
    expect(counter(homePath, "v1-finish").count()).toBe(1);

    // 8. Every record plugin "p" wrote is still returned by records.since(0):
    //    a fresh read of the journal from the beginning finds all of them.
    const writtenByP = seen.filter(isWrittenByP);
    expect(writtenByP.length).toBeGreaterThan(0);
    const expectedIds = new Set(writtenByP.map((record) => record.id));

    const reread = await connectAsOwner(homePath);
    const all: StoredRecord[] = [];
    const reader = (async () => {
      for await (const record of reread.records.since(seq(0))) {
        all.push(record);
      }
    })().catch(() => {});

    await eventually(
      () => {
        const found = new Set(all.map((record) => record.id));
        return [...expectedIds].every((id) => found.has(id));
      },
      10_000,
      "every record written by plugin p should still be readable",
    );

    await reread.close();
    await reader;
  } finally {
    await client?.close().catch(() => {});
    await observer?.close().catch(() => {});
    if (subscription !== undefined) await subscription;
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
