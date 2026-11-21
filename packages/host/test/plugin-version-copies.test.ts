// The default version of a plugin follows its handlers even when the plugin is made by another
// copy of the plugin package than the one the host loaded.

import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { pluginName } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";

const PLUGIN_SRC = join(import.meta.dir, "../../plugin/src");

/** A plugin whose module imports the copy of the package at `copy` and whose handler has `body`. */
async function fromCopy(copy: string, body: string): Promise<Plugin> {
  const module = join(copy, `made-${Bun.hash(body)}.ts`);
  await Bun.write(
    module,
    `import { record } from "@niwa-labs/core";
import { z } from "zod";
import { plugin } from "./src/index.ts";
const Ping = record("copies.ping", z.object({}));
// Outside the setup, so only the sealed version sees the body.
const handle = async () => { ${body} };
export default plugin("copied", (api) => {
  api.declare(Ping);
  api.on(Ping, handle);
});
`,
  );
  return ((await import(module)) as { default: Plugin }).default;
}

test("a plugin from a second copy of the package takes a new version when a handler body changes", async () => {
  const copy = mkdtempSync(join(import.meta.dir, ".plugin-copy-"));
  cpSync(PLUGIN_SRC, join(copy, "src"), { recursive: true });
  const home = await tempHome();
  try {
    const versions: string[] = [];
    for (const body of ["return 1;", "return 2;"]) {
      const niwa = createNiwa({ home: home.path });
      niwa.use(await fromCopy(copy, body));
      await niwa.serve();
      versions.push(String(niwa.installed(pluginName("copied"))?.version));
      await niwa.close();
    }
    expect(versions[0]).not.toBe(versions[1]);
  } finally {
    rmSync(copy, { recursive: true, force: true });
    await home.cleanup();
  }
});
