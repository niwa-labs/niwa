// What a plugin as a whole needs the host to serve is checked before the host serves.

import { expect, test } from "bun:test";

import { action, actionName, MissingNeed, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Beat = record("needs.beat", z.object({ n: z.number() }), { open: true });
const Pulse = record("needs.pulse", z.object({ n: z.number() }), { open: true });

const declares = plugin("needs-types", (api) => api.declare(Beat, Pulse));

test("a plugin that needs an action or a record type nobody serves makes the host refuse to serve", async () => {
  const home = await tempHome();
  try {
    const missingAction = createNiwa({ home: home.path });
    missingAction.use(plugin("needy", (api) => api.needs({ actions: [actionName("ask.nobody")] })));
    const refused = await missingAction.serve().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(MissingNeed);
    expect(refused).toMatchObject({ plugin: "needy", kind: "action", needed: "ask.nobody" });
    await missingAction.close();

    const missingType = createNiwa({ home: home.path });
    missingType.use(plugin("needy", (api) => api.needs({ types: ["nobody.writes"] })));
    await expect(missingType.serve()).rejects.toMatchObject({ code: "MissingNeed", kind: "type", needed: "nobody.writes" });
    await missingType.close();

    const met = createNiwa({ home: home.path });
    met.use(
      declares,
      plugin("needy", (api) => api.needs({ actions: ["niwa.host.status"], types: [Beat, "needs.pulse"] })),
    );
    await met.serve();
    await met.close();
  } finally {
    await home.cleanup();
  }
});

test("an action persisted in a plugin catalog satisfies a need before services start", async () => {
  const home = await tempHome();
  const dynamic = action("needs.persisted", {
    description: "An action provided by a journal record", input: z.object({}), output: z.number(),
    recovery: "repeat", effect: "read", run: () => 1,
  });
  const provider = plugin("catalog-provider", api => {
    api.declare(Beat);
    api.catalog(() => api.journal?.()?.find({type: Beat.name}).length ? [dynamic] : []);
  });
  let started = 0;
  const consumer = plugin("catalog-consumer", api => {
    api.needs({actions: [dynamic.name]});
    api.service(() => { started++; return () => {}; });
  });
  let host = createNiwa({home: home.path});
  try {
    host.use(provider, consumer);
    await expect(host.serve()).rejects.toMatchObject({code: "MissingNeed", needed: dynamic.name});
    expect(started).toBe(0);
    await host.close();

    host = createNiwa({home: home.path});
    host.use(provider);
    await host.serve();
    await host.emit(Beat, {n: 1});
    await host.close();

    host = createNiwa({home: home.path});
    host.use(provider, consumer);
    await host.serve();
    expect(started).toBe(1);
    expect(await host.call(dynamic, {})).toBe(1);
  } finally { await host.close(); await home.cleanup(); }
});
