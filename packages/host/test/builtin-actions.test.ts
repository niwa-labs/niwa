// The actions the host registers for itself are there from the moment the host is created: what
// niwa describes does not wait for the first plugin.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { tempHome } from "@niwa-labs/testing";

test("a host with no plugin describes its own actions", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    const names = (await niwa.describe()).actions.map((entry) => entry.name);
    expect(names).toContain("niwa.records.read");
    expect(names).toContain("plugin.install");
    expect(names).toContain("niwa.describe");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
