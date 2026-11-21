// A point a plugin read when it was installed is not changed under it by a replacement of the plugin that offers there.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { offerKey, plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";

const POINT = offerKey<string[]>("contract.point", "contract-reader");

/** A provider that offers `values` at the point, and a reader that collects them in its setup. */
function provider(values: string[], version: string): Plugin {
  return plugin("contract-provider", (api) => api.offer(POINT, values), { version });
}
const reader = (collected: string[][]): Plugin =>
  plugin("contract-reader", (api) => void collected.push(api.offers(POINT).flatMap((one) => one.value)), { version: "1" });

test("replacing a provider with other offers at a point an installed plugin read is refused and names the reader", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const collected: string[][] = [];
  try {
    niwa.use(provider(["old"], "1"), reader(collected));
    expect(collected).toEqual([["old"]]);
    const refused = provider(["new"], "2");
    expect(() => niwa.use(refused)).toThrow(/contract-provider".*"contract.point".*"contract-reader" read when it was installed/);
    expect(niwa.installed(refused.name)).not.toBe(refused);
    // What it offered before is still what is offered, and an identical offer is a replacement as before.
    const same = provider(["old"], "3");
    niwa.use(same);
    expect(niwa.installed(same.name)).toBe(same);
    // So is a provider that withdraws its offer.
    expect(() => niwa.use(plugin("contract-provider", () => undefined, { version: "4" }))).toThrow(/"contract-reader"/);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
