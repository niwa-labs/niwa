// `use` takes several plugins and installs them in order; it stops at the first one that fails.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin, pluginName } from "@niwa-labs/plugin";
import { record, PluginInstallFailed } from "@niwa-labs/core";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const One = record("many.one", z.object({}));
const Two = record("many.two", z.object({}));
const Three = record("many.three", z.object({}));

test("several plugins in one call are all installed, in order", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(
      plugin("many-one", (a) => a.declare(One)),
      plugin("many-two", (a) => a.declare(Two)),
      plugin("many-three", (a) => a.declare(Three)),
    );
    const d = await niwa.describe();
    expect(d.types.map((t) => t.name)).toEqual([One.name, Two.name, Three.name]);
    expect(niwa.installed(pluginName("many-three"))).toBeDefined();
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a failing plugin stops the call: earlier ones stay, later ones are not tried, the error names it", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    let error: unknown;
    try {
      niwa.use(
        plugin("many-one", (a) => a.declare(One)),
        plugin("many-bad", () => {
          throw new Error("boom");
        }),
        plugin("many-three", (a) => a.declare(Three)),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginInstallFailed);
    const failed = error as PluginInstallFailed;
    expect(failed.plugin).toBe("many-bad");
    expect(failed.installed).toEqual(["many-one"]);
    expect(failed.skipped).toEqual(["many-three"]);
    expect(failed.message).toContain("boom");
    expect(niwa.installed(pluginName("many-one"))).toBeDefined();
    expect(niwa.installed(pluginName("many-bad"))).toBeUndefined();
    expect(niwa.installed(pluginName("many-three"))).toBeUndefined();
    expect((await niwa.describe()).types.map((t) => t.name)).toEqual([One.name]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("no plugins is a no-op", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use();
    expect((await niwa.describe()).types).toEqual([]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a single failing plugin is wrapped too: it keeps the original error as its cause and installs nothing", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    const original = new TypeError("bad setup");
    let error: unknown;
    try {
      niwa.use(
        plugin("many-bad", () => {
          throw original;
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginInstallFailed);
    const failed = error as PluginInstallFailed;
    expect(failed.plugin).toBe("many-bad");
    expect(failed.installed).toEqual([]);
    expect(failed.skipped).toEqual([]);
    expect(failed.cause).toBe(original);
    expect(failed.message).toContain("bad setup");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a failing first plugin leaves the later ones untried and not installed", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    let error: unknown;
    try {
      niwa.use(
        plugin("many-bad", () => {
          throw new Error("first");
        }),
        plugin("many-one", (a) => a.declare(One)),
      );
    } catch (caught) {
      error = caught;
    }
    const failed = error as PluginInstallFailed;
    expect(failed.installed).toEqual([]);
    expect(failed.skipped).toEqual(["many-one"]);
    expect(niwa.installed(pluginName("many-one"))).toBeUndefined();
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a replacement that fails leaves the plugin it was to replace in place, also while serving", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    const original = plugin("many-one", (a) => a.declare(One));
    niwa.use(original);
    await niwa.serve();
    expect(() =>
      niwa.use(
        plugin("many-one", (a) => {
          a.declare(Two);
          throw new Error("late failure");
        }),
      ),
    ).toThrow(PluginInstallFailed);
    expect(niwa.installed(pluginName("many-one"))).toBe(original);
    expect((await niwa.describe()).types.map((t) => t.name)).toEqual([One.name]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
