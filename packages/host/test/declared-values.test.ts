// Declared values.
//
// The scenario runs against a real host process (fixtures/declared-values-host.ts):
//
//   1. the declared action is in the description, with its schemas, its description and
//      its recovery contract
//   2. writing a record of a type no plugin declares is refused, and nothing is written
//   3. a record of a type that no plugin declares any more is still returned by
//      records.since, with its raw data, and no handler runs on it
//
// Only the public API is used: the entries of the packages and "@niwa-labs/testing".

import { expect, test } from "bun:test";

import type { StoredRecord } from "@niwa-labs/core";
import { JsonSchemaValue, record, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { counter, eventually, spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

import { Note, unloadExtra } from "./fixtures/declared-values-host.ts";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/declared-values-host.ts", import.meta.url));

/** From the beginning of the journal. */
const FROM_START = seq(0);

/** A type no plugin declares. */
const Undeclared = record("declared-values.undeclared", z.object({ text: z.string() }));

/** The type of the extra plugin: it is declared only while that plugin is installed. */
const Extra = record("declared-values.extra", z.object({ text: z.string() }), { open: true });

/**
 * Read the journal through the public subscription.
 *
 * A subscription never ends by itself, so the read stops itself: it waits for the journal to
 * settle and then closes the subscription.
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

test("declared values: a declared action is described with its schemas, an undeclared type is refused, and a record of an unknown type is still readable", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    client = await connectAsOwner(homePath);

    // 1. The declared action is in the self-description, with its schemas.
    const description = await client.describe();
    const described = description.actions.find((action) => action.name === "declared-values.shout");
    expect(described).toBeDefined();
    expect(described?.description).toBe("Returns its input, upper-cased.");
    expect(described?.recovery).toBe("do-not-repeat");

    // Nothing is listed twice, nothing is missing and nothing is invented: the description is the
    // registered actions (the host's own resolve, move, install, observation and access actions are among them).
    expect(description.actions.map((action) => String(action.name)).sort()).toEqual([
      "access.explain",
      "access.grant.change",
      "access.grant.close",
      "access.mine",
      "access.profile.get",
      "access.profile.set",
      "access.switch",
      "declared-values-handle",
      "declared-values.shout",
      "declared-values.unload-extra",
      "niwa.causes",
      "niwa.cockpit.catalog",
      "niwa.describe",
      "niwa.host.status",
      "niwa.host.stop",
      "niwa.invocation.cancel-steps",
      "niwa.invocation.move",
      "niwa.invocation.resolve",
      "niwa.records.read",
      "niwa.records.search",
      "niwa.trace",
      "plugin.install",
    ]);

    // The input is a JSON Schema with the declared property.
    const input = described?.input as { type?: string; properties?: Record<string, unknown> };
    expect(input.type).toBe("object");
    expect(input.properties?.text).toBeDefined();

    // The output is a JSON Schema too.
    const output = described?.output as { type?: string; properties?: Record<string, unknown> };
    expect(output.type).toBe("object");
    expect(output.properties?.text).toBeDefined();
    expect(described?.input).toEqual(JsonSchemaValue.parse(z.toJSONSchema(z.object({ text: z.string() }), { io: "input" })));

    // The declared record type is in the description as well.
    const describedType = description.types.find((entry) => entry.name === "declared-values.note");
    expect(describedType).toBeDefined();
    expect(describedType?.version).toBe(1);

    // 2. Writing a record of an undeclared type is refused, and nothing is
    //    written: the host does not know that type.
    let refused: unknown;
    try {
      await client.emit(Undeclared, { text: "no" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeDefined();
    expect((refused as { code?: string }).code).toBe("UnknownType");

    const afterRefusal = await readJournal(await connectAsOwner(homePath));
    expect(afterRefusal.some((entry) => entry.type === Undeclared.name)).toBe(false);

    // 3. A record of a type that no plugin declares any more is still returned
    //    by records.since, with its raw data, and no handler runs on it.
    //
    //    The record is written while the plugin still declares the type.
    const extra = await client.emit(Extra, { text: "kept" });
    await eventually(
      () => counter(homePath, "declared-values-handle").count() === 0,
      5_000,
      "no handler of the extra type should have run",
    );

    // The plugin is unloaded: no plugin declares the type any more.
    const unloaded = await client.call(unloadExtra, {});
    expect(unloaded.ok).toBe(true);

    const descriptionAfter = await client.describe();
    expect(descriptionAfter.types.find((entry) => entry.name === Extra.name)).toBeUndefined();

    // The record of the type nobody declares any more is still there, with its
    // raw data.
    const records = await readJournal(await connectAsOwner(homePath));
    const found = records.find((entry) => entry.id === extra.id);
    expect(found).toBeDefined();
    expect(found?.type).toBe(Extra.name);
    expect(found?.data).toEqual({ text: "kept" });

    // And no handler ran on it: the type has no handler, so nothing was called.
    expect(counter(homePath, "declared-values-handle").count()).toBe(0);

    // The handler of the declared type still runs: the record of Note is
    // handled, and the unknown one did not disturb it.
    await client.emit(Note, { text: "hello" });
    await eventually(
      () => counter(homePath, "declared-values-handle").count() === 1,
      10_000,
      "the handler of the declared type should run",
    );
  } finally {
    await client?.close().catch(() => {});
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
