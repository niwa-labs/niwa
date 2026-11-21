// What a plugin as a whole needs the host to serve is checked before the host serves.

import { expect, test } from "bun:test";

import { actionName, MissingNeed, record } from "@niwa-labs/core";
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
