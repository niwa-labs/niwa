// The filter of a trigger and the filter of the handler that subscribes to it are one condition.

import { expect, test } from "bun:test";

import { record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, trigger } from "@niwa-labs/plugin";
import { eventually, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Fired = record("filter.fired", z.object({ timer: z.string(), n: z.number() }), { open: true });

const declares = plugin("filter-types", (api) => api.declare(Fired));
const timerA = trigger(Fired, { name: "fired:a", filter: { timer: "a" } });

test("a handler of a trigger is woken by the records the trigger and its own filter both hold", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const seen: number[] = [];
  try {
    niwa.use(declares, plugin("both", (api) => api.on(timerA, { filter: { n: 2 } }, (data) => void seen.push(data.n))));
    await niwa.serve();
    await niwa.emit(Fired, { timer: "a", n: 1 });
    await niwa.emit(Fired, { timer: "b", n: 2 });
    await niwa.emit(Fired, { timer: "a", n: 2 });
    await eventually(() => seen.length >= 1);
    await Bun.sleep(100);
    expect(seen).toEqual([2]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a handler whose filter gives a path another value than its trigger is refused and names the path", () => {
  const host = createNiwa({ home: "/nonexistent" });
  expect(() => host.use(declares, plugin("conflict", (api) => api.on(timerA, { filter: { timer: "b" } }, () => undefined)))).toThrow(
    /handler "fired:a".*timer = "b".*"fired:a" holds timer = "a"/,
  );
  // The same value is no conflict.
  expect(() => host.use(plugin("agree", (api) => api.on(timerA, { filter: { timer: "a" } }, () => undefined)))).not.toThrow();
});
