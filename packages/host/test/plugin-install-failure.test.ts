// A plugin that fails to install changes nothing: not the plugin it would have replaced, and not
// what the host shares between plugins (the profiles and the state of the plugin).

import { expect, test } from "bun:test";

import { actionName, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, pluginName } from "@niwa-labs/plugin";
import type { PluginApi, StateHandle } from "@niwa-labs/plugin";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const PROFILE_GET = actionName("access.profile.get");
const Ping = record("failing.ping", z.object({ n: z.number() }), { open: true });

/** A served host with one plugin `p` installed from `first`, and an owner connected. */
async function hosted(first: (api: PluginApi) => void) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("p", first, { version: "v1" }));
  await niwa.serve();
  const owner = await connectAsOwner(home.path);
  return {
    niwa,
    owner,
    close: async () => {
      await owner.close().catch(() => {});
      await niwa.close();
      await home.cleanup();
    },
  };
}

const profileRules = async (owner: Awaited<ReturnType<typeof connectAsOwner>>): Promise<unknown> =>
  ((await owner.call(PROFILE_GET, { name: "mine" })) as { rules: unknown }).rules;

test("a replacement whose setup throws leaves the profile and the state of the installed plugin as they were", async () => {
  let count: StateHandle<number> | undefined;
  const h = await hosted((api) => {
    api.declare(Ping);
    api.profile("mine", () => ["task.*"]);
    count = api.state("count", z.number(), 0);
  });
  try {
    const installed = h.niwa.installed(pluginName("p"));
    expect(await profileRules(h.owner)).toEqual(["call:task.*"]);

    const failing = plugin(
      "p",
      (api) => {
        api.profile("mine", () => ["*"]);
        api.state("count", z.string(), "text");
        throw new Error("the second version does not start");
      },
      { version: "v2" },
    );
    expect(() => h.niwa.use(failing)).toThrow("the second version does not start");

    expect(h.niwa.installed(pluginName("p"))).toBe(installed);
    expect(await profileRules(h.owner)).toEqual(["call:task.*"]);
    // The state still holds what the installed plugin declared: a number.
    expect(count?.set(5)).toBe(5);
    expect(count?.get()).toBe(5);
  } finally {
    await h.close();
  }
});
