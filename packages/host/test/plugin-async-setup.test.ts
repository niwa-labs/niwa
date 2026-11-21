// A plugin made without one of its handlers is held to the same setup as the plugin it is made from.

import { expect, test } from "bun:test";

import { record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, withoutHandler } from "@niwa-labs/plugin";
import type { PluginApi } from "@niwa-labs/plugin";
import { z } from "zod";

const Beat = record("async-setup.beat", z.object({ n: z.number() }), { open: true });

test("a setup that returns a promise is refused whole and without a handler", () => {
  const asynchronous = plugin("async-setup", ((api: PluginApi) => {
    api.on(Beat, { id: "x" }, () => undefined);
    api.on(Beat, { id: "y" }, () => undefined);
    return Promise.resolve();
  }) as never);
  const host = createNiwa({ home: "/nonexistent" });
  expect(() => host.use(asynchronous)).toThrow(/asynchronous setup/);
  expect(() => host.use(withoutHandler(asynchronous, "x"))).toThrow(/asynchronous setup/);
});
