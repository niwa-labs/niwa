// What a handler writes is held to the same rules as a record written over the wire: the plugin
// that owns the type writes it, or a grant lets the writer; the data is read through the owner's
// schema. And a type has one owner.

import { expect, test } from "bun:test";

import { CORE_TYPES, record, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Item = record("sub-test.item", z.object({ n: z.number() }));
const Answer = record("sub-test.answer", z.object({ n: z.number() }));
const Echo = record("sub-test.echo", z.object({ n: z.number() }));

/** The plugin that declares the types and nothing else: what writes the records. */
const producer = (): Plugin => plugin("sub-producer", (api) => api.declare(Item, Answer));

type Host = ReturnType<typeof createNiwa>;

/** Serve a host on a home with these plugins. */
async function serving(home: string, plugins: Plugin[]): Promise<Host> {
  const niwa = createNiwa({ home });
  for (const one of plugins) niwa.use(one);
  await niwa.serve();
  return niwa;
}

const recordsOf = (niwa: Host, type?: string): Promise<StoredRecord[]> =>
  niwa.records.read(seq(0)).then((rows) => (type === undefined ? rows : rows.filter((row) => row.type === type)));

const statesOf = async (niwa: Host): Promise<Array<{ invocation: string; state: string }>> =>
  (await recordsOf(niwa, CORE_TYPES.invocationState)).map((row) => row.data as { invocation: string; state: string });

test("a handler may not write a type another plugin owns without a grant", async () => {
  const home = await tempHome();
  try {
    const niwa = await serving(home.path, [
      producer(),
      plugin("sub-intruder", (api) => {
        api.declare(Echo);
        api.on(Echo, { from: "start" }, async (data, step) => {
          await step.emit(Answer, { n: data.n });
        });
      }),
    ]);
    await niwa.emit(Echo, { n: 1 });
    await eventually(async () => (await statesOf(niwa)).some((one) => one.state === "paused"));
    const paused = (await recordsOf(niwa, CORE_TYPES.invocationState)).find((row) => (row.data as { state: string }).state === "paused");
    expect(String((paused?.data as { reason?: string }).reason)).toContain("sub-producer");
    expect(await recordsOf(niwa, Answer.name)).toEqual([]);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("a handler's record is checked against the schema of the type's owner, not the handler's copy", async () => {
  const home = await tempHome();
  try {
    const Loose = record("sub-test.echo", z.object({ n: z.unknown() }));
    const niwa = await serving(home.path, [
      producer(),
      plugin("sub-consumer", (api) => {
        api.declare(Echo);
        api.on(Item, async (_data, step) => {
          await step.emit(Loose, { n: "not a number" });
        });
      }),
    ]);
    await niwa.emit(Item, { n: 1 });
    await eventually(async () => (await statesOf(niwa)).some((one) => one.state === "paused"));
    expect(await recordsOf(niwa, Echo.name)).toEqual([]);
    await niwa.close();
  } finally {
    await home.cleanup();
  }
});

test("two plugins may not own one type, whether by name or under a family", async () => {
  const exact = createNiwa({ home: (await tempHome()).path });
  exact.use(producer());
  expect(() => exact.use(plugin("sub-twin", (api) => api.declare(Item)))).toThrow(/sub-producer/);
  const family = createNiwa({ home: (await tempHome()).path });
  family.use(producer());
  expect(() => family.use(plugin("sub-family", (api) => api.declare(record("sub-test.*", z.unknown()))))).toThrow(/sub-producer/);
});
