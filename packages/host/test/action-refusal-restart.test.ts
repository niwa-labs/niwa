import {expect, test} from "bun:test";
import {fileURLToPath} from "node:url";
import {CORE_TYPES} from "@niwa-labs/core";
import {connectAsOwner, counter, eventually, spawnHost, tempHome} from "@niwa-labs/testing";
import {Start, Wake, Caught, Done} from "./fixtures/record-refusal-crash.ts";

const script = fileURLToPath(new URL("./fixtures/record-refusal-crash.ts", import.meta.url));

for (const mode of ["escaped", "claim", "handled"] as const) {
  test(`restart after a guarded action refusal: ${mode}`, async () => {
    const home = await tempHome();
    let host = spawnHost(script, home.path);
    let client;
    try {
      await host.ready();
      client = await connectAsOwner(home.path);
      await client.emit(Start, {mode});
      const before = client;
      await eventually(async () => (await before.records.read({types: [
        mode === "escaped" ? Caught : CORE_TYPES.recordRefused,
      ]})).length === 1);
      if (mode === "escaped") await eventually(async () => (await before.records.read({types: [CORE_TYPES.invocationState]}))
        .some(row => (row.data as {state: string}).state === "waiting"));
      const [audit] = await client.records.read({types: [CORE_TYPES.recordRefused]});
      if (mode !== "escaped") expect(await client.records.read({types: [CORE_TYPES.stepOutcome]})).toHaveLength(0);
      await client.close();
      await host.kill();
      host = spawnHost(script, home.path);
      await host.ready();
      client = await connectAsOwner(home.path);
      const after = client;
      if (mode === "handled") {
        await eventually(async () => (await after.records.read({types: [CORE_TYPES.invocationState]}))
          .some(row => (row.data as {state: string}).state === "paused"));
        expect(await client.records.read({types: [Caught]})).toHaveLength(0);
      } else {
        await client.emit(Wake, {});
        await eventually(async () => (await after.records.read({types: [Done]})).length === 1);
        expect((await client.records.read({types: [Caught]})).map(row => row.data)).toEqual([{audit: audit!.id}]);
        expect((await client.records.read({types: [CORE_TYPES.stepOutcome]})).map(row => row.data))
          .toContainEqual(expect.objectContaining({key: "call", outcome: {status: "refused", audit: audit!.id}}));
      }
      expect(counter(home.path, "calls").count()).toBe(1);
    } finally { await client?.close(); await host.kill(); await home.cleanup(); }
  }, 20_000);
}
