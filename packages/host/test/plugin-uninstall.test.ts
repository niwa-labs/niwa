import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { connect } from "@niwa-labs/client";
import { CORE_TYPES, actionName, grant, principalOf } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, pluginName } from "@niwa-labs/plugin";
import { connectAsOwner, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const INSTALL = actionName("plugin.install");
const UNINSTALL = actionName("plugin.uninstall");
const Installed = z.object({ hash: z.string() });
const pluginEntry = fileURLToPath(new URL("../../plugin/src/index.ts", import.meta.url));

test("Restore pinned modules and remove only the selected installation", async () => {
  const home = await tempHome();
  const module = `${home.path}/edit.ts`;
  const makeHost = async () => {
    const host = createNiwa({ home: home.path });
    host.use(plugin("configured", () => {}));
    await host.serve();
    return host;
  };
  const write = (version: string) => Bun.write(module, [
    `import { plugin } from "${pluginEntry}";`,
    `export default plugin("rin/edit", () => {}, { version: "${version}" });`,
  ].join("\n"));
  let host = await makeHost();
  let owner = await connectAsOwner(home.path);
  try {
    await write("first");
    await expect(owner.call(INSTALL, { plugin: "configured", module })).rejects.toThrow("configured");
    const first = Installed.parse(await owner.call(INSTALL, { plugin: "rin/edit", module }));
    await write("second");
    await owner.close();
    await host.close();

    host = await makeHost();
    owner = await connectAsOwner(home.path);
    expect(host.installed(pluginName("rin/edit"))?.version).toBe("first");
    const second = Installed.parse(await owner.call(INSTALL, { plugin: "rin/edit", module }));
    await expect(owner.call(UNINSTALL, { plugin: "rin/edit", hash: first.hash })).rejects.toThrow("selected hash");
    const token = host.issueToken(principalOf("session", "non-owner"), { grant: grant(["plugin.uninstall@rin/*"]) });
    const session = await connect({ home: home.path, id: "non-owner", token });
    try {
      await expect(session.call(UNINSTALL, { plugin: "rin/edit", hash: second.hash })).rejects.toThrow("only the owner");
    } finally {
      await session.close();
    }
    await expect(owner.call(UNINSTALL, { plugin: "configured", hash: second.hash })).rejects.toThrow("not installed from a module");
    await owner.call(UNINSTALL, { plugin: "rin/edit", hash: second.hash });
    expect(host.installed(pluginName("rin/edit"))).toBeUndefined();
    expect(existsSync(`${home.path}/.${second.hash}.ts`)).toBe(false);
    expect(existsSync(module)).toBe(true);
    expect(await host.records.read({ types: [CORE_TYPES.pluginUninstalled] })).toHaveLength(1);
    await owner.close();
    await host.close();

    host = await makeHost();
    owner = await connectAsOwner(home.path);
    expect(host.installed(pluginName("rin/edit"))).toBeUndefined();
    expect(host.installed(pluginName("configured"))).toBeDefined();
  } finally {
    await owner.close();
    await host.close();
    await home.cleanup();
  }
});
