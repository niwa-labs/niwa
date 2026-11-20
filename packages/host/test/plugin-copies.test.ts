// The copies `plugin.install` imports (`.<hash><ext>`, beside the file) do not pile up:
// a plugin installed again with a new hash takes the copy of its
// previous file away, and a host start takes away the copies no installation is made from.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { actionName } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, pluginName } from "@niwa-labs/plugin";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const PLUGIN_ENTRY = new URL("../../plugin/src/index.ts", import.meta.url).pathname;
const INSTALL = actionName("plugin.install");
/** A host with one plugin of its own: the actions of the host are served once a plugin is installed. */
const withBase = (home: string) => {
  const niwa = createNiwa({ home });
  niwa.use(plugin("base", () => {}));
  return niwa;
};
const Installed = z.object({ hash: z.string() });

/** Write a module that exports the plugin `swapped` at this version. */
async function write(path: string, version: string): Promise<void> {
  await Bun.write(path, `import { plugin } from "${PLUGIN_ENTRY}";\nexport default plugin("swapped", () => {}, { version: "${version}" });\n`);
}

test("a plugin installed again with a new hash takes the copy of its previous file away; the same hash keeps it", async () => {
  const home = await tempHome();
  const niwa = withBase(home.path);
  await niwa.serve();
  const owner = await connectAsOwner(home.path);
  try {
    const path = `${home.path}/swapped.ts`;
    await write(path, "v1");
    const first = Installed.parse(await owner.call(INSTALL, { plugin: "swapped", module: path }));
    const copyOf = (hash: string) => `${home.path}/.${hash}.ts`;
    expect(existsSync(copyOf(first.hash))).toBe(true);

    // The same file again: it is the copy the plugin is made from, so it stays.
    await owner.call(INSTALL, { plugin: "swapped", module: path });
    expect(existsSync(copyOf(first.hash))).toBe(true);

    await write(path, "v2");
    const second = Installed.parse(await owner.call(INSTALL, { plugin: "swapped", module: path }));
    expect(second.hash).not.toBe(first.hash);
    expect(existsSync(copyOf(first.hash))).toBe(false);
    expect(existsSync(copyOf(second.hash))).toBe(true);
    expect(String(niwa.installed(pluginName("swapped"))?.version)).toBe("v2");
  } finally {
    await owner.close();
    await niwa.close();
    await home.cleanup();
  }
});

test("a host start takes away the copies the installations are not made from, and nothing else", async () => {
  const home = await tempHome();
  const path = `${home.path}/swapped.ts`;
  const first = withBase(home.path);
  await first.serve();
  const owner = await connectAsOwner(home.path);
  await write(path, "v1");
  const installed = Installed.parse(await owner.call(INSTALL, { plugin: "swapped", module: path }));
  await owner.close();
  await first.close();

  // What a proposal that was never installed, or an install that was cut off, may have left.
  const stale = `${home.path}/.${"a".repeat(64)}.ts`;
  const own = `${home.path}/.${installed.hash}.ts`;
  const others = [`${home.path}/.hidden.ts`, `${home.path}/notes.txt`, `${home.path}/.${"b".repeat(63)}.ts`];
  await Bun.write(stale, "stale");
  for (const other of others) await Bun.write(other, "mine");

  const second = withBase(home.path);
  await second.serve();
  try {
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(own)).toBe(true);
    for (const other of others) expect(existsSync(other)).toBe(true);
  } finally {
    await second.close();
    await home.cleanup();
  }
});
