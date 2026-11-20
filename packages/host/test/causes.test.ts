// Causes.
//
// The scenario runs against a real host process (fixtures/causes-host.ts):
//
//   1. spawn the host, connect a client, emit Seed { n: 1 }
//   2. the handler writes two reports and one merged result with step.emit
//   3. the reports and the merged result have the seed as their cause and the
//      seed's root as their root; the actor is the handler
//   4. the trace down from the root lists everything that grew from it: the
//      two reports and the merged result, each record once, with its depth
//   5. the merged result depends on three inputs: the seed, the first report
//      and the second report. It is reachable from each of the three — up
//      through `causes` and down through `trace`.
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";

import { Done, Merged, Report, Seed } from "./fixtures/causes-host.ts";

const HOST_SCRIPT = new URL("./fixtures/causes-host.ts", import.meta.url).pathname;

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** The type of every record the handler wrote. */
function recordsOfType(records: StoredRecord[], type: string): StoredRecord[] {
  return records.filter((record) => record.type === type);
}

test("causes: a record written in a handler has the waking record as its cause, the trace from the root lists what grew from it, and a merged result is reachable from each of its three inputs", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    // 1. The host and a client.
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);

    // The observer reads the journal from the beginning.
    const watcher = await connectAsOwner(homePath);
    const seen: StoredRecord[] = [];
    const watch = (async () => {
      for await (const record of watcher.records.since(FROM_START)) {
        seen.push(record);
      }
    })().catch(() => {});

    // 2. The original input. It is the root of its own chain.
    const seed = await client.emit(Seed, { n: 1 });
    expect(seed.root).toBe(seed.id);
    expect(seed.cause).toBeNull();

    // The handler runs and writes its records.
    await eventually(
      () => recordsOfType(seen, Done.name).length === 1,
      10_000,
      "the handlers should write the merged result and the record after it",
    );

    const reports = recordsOfType(seen, Report.name);
    const merged = recordsOfType(seen, Merged.name)[0];
    expect(reports.length).toBe(2);
    expect(merged).toBeDefined();

    // 3. Every record written in the handler has the waking record as its
    //    cause, the root of the waking record as its root, and the handler as
    //    its actor.
    for (const record of [...reports, merged!]) {
      expect(record.cause).toBe(seed.id);
      expect(record.root).toBe(seed.id);
      expect(record.actor.kind).toBe("handler");
    }

    // The record written by the handler of the merged result: the cause is the record that
    // woke it, the root is still the original input — cause and root differ here.
    const done = recordsOfType(seen, Done.name)[0];
    expect(done?.cause).toBe(merged!.id);
    expect(done?.root).toBe(seed.id);
    expect(done?.actor.kind).toBe("handler");

    // 4. The trace down from the root lists everything that grew from it.
    const traced = await client.trace(seed.id);
    const tracedTypes = traced.map((record) => record.type);

    expect(tracedTypes).toContain(Report.name);
    expect(tracedTypes).toContain(Merged.name);
    expect(traced.filter((record) => record.type === Report.name).length).toBe(2);
    expect(traced.filter((record) => record.type === Merged.name).length).toBe(1);
    expect(traced.filter((record) => record.type === Done.name).length).toBe(1);

    // Each record is listed once, and the depth says how far down it is.
    expect(new Set(traced.map((record) => record.id)).size).toBe(traced.length);
    expect(traced[0]?.id).toBe(seed.id);
    expect(traced[0]?.depth).toBe(0);
    for (const record of traced) {
      if (record.id === seed.id) continue;
      expect(record.depth).toBeGreaterThanOrEqual(record.id === done!.id ? 2 : 1);
    }

    // The trace from the root reaches the merged result.
    expect(traced.some((record) => record.id === merged!.id)).toBe(true);

    // 5. The merged result depends on three inputs: the seed, the first report
    //    and the second report. It is reachable from each of them.
    //
    //    "Reachable from" is answered by the two directions of the chain: the
    //    trace walks down from an input to what grew from it, and the causes of
    //    the merged result walk up to what it depends on.
    const inputs = [seed.id, reports[0]!.id, reports[1]!.id];
    for (const input of inputs) {
      // Down from the input: the trace reaches the merged result.
      const trace = await client.trace(input);
      expect(trace.map((record) => record.id)).toContain(merged!.id);
    }

    // Up from the merged result: all three inputs are among its causes.
    const causesOfMerged = await client.causes(merged!.id);
    for (const input of inputs) {
      expect(causesOfMerged.map((record) => record.id)).toContain(input);
    }

    await client.close().catch(() => {});
    await watcher.close().catch(() => {});
    await watch;
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
