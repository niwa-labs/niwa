// `plugin.install` names the hash the file is expected to have, and a file that is not that file is
// refused before any of its code runs: nothing of it is imported, and no copy of it is left.

import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { actionName } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, pluginName } from "@niwa-labs/plugin";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const PLUGIN_ENTRY = fileURLToPath(new URL("../../plugin/src/index.ts", import.meta.url));
const INSTALL = actionName("plugin.install");
const Installed = z.object({ hash: z.string() });

/** A module that leaves a mark when it is imported, and exports the plugin `marked`. */
function moduleOf(mark: string, version: string): string {
  return [
    `import { writeFileSync } from "node:fs";`,
    `import { plugin } from "${PLUGIN_ENTRY}";`,
    `writeFileSync(${JSON.stringify(mark)}, "imported");`,
    `export default plugin("marked", () => {}, { version: ${JSON.stringify(version)} });`,
    "",
  ].join("\n");
}

test("a file that is not the approved one is refused before it is imported, and leaves no copy", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(plugin("base", () => {}));
  await niwa.serve();
  const owner = await connectAsOwner(home.path);
  try {
    const path = `${home.path}/marked.ts`;
    const mark = `${home.path}/imported.mark`;

    await Bun.write(path, moduleOf(mark, "v1"));
    const approved = Installed.parse(await owner.call(INSTALL, { plugin: "marked", module: path })).hash;
    expect(existsSync(mark)).toBe(true);
    await Bun.$`rm -f ${mark}`;

    // The file changes after the hash was approved.
    await Bun.write(path, moduleOf(mark, "v2"));
    const before = readdirSync(home.path).sort();
    await expect(owner.call(INSTALL, { plugin: "marked", module: path, hash: approved })).rejects.toThrow("is not the file that was approved");

    expect(existsSync(mark)).toBe(false);
    expect(readdirSync(home.path).sort()).toEqual(before);
    expect(String(niwa.installed(pluginName("marked"))?.version)).toBe("v1");
  } finally {
    await owner.close();
    await niwa.close();
    await home.cleanup();
  }
});
