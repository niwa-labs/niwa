import { expect, test } from "bun:test";
import { constants, cpSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnHost, tempHome } from "@niwa-labs/testing";

const release = process.env.NIWA_TEST_CLIENT_RELEASE;
const installer = new URL("../../../scripts/install-client.ts", import.meta.url).pathname;

test.skipIf(!release)("installed CLI and MCP use the isolated host while its checkout is broken or absent", async () => {
  if (!release) throw new Error("Set NIWA_TEST_CLIENT_RELEASE to a staged release");
  const home = await tempHome();
  const cwd = home.path;
  const checkout = join(cwd, "dev");
  const bin = join(cwd, "bin");
  const cli = join(bin, "niwa");
  const env = { PATH: process.env.PATH, NIWA_HOME: home.path };
  let host: ReturnType<typeof spawnHost> | undefined;
  function run(args: string[]) {
    return Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  }

  async function checkClients() {
    const greeted = run([cli, "--home=" + home.path, "--json", "surface.greet", "--text", "installed"]);
    expect(greeted.stderr.toString()).toBe("");
    expect(greeted.exitCode).toBe(0);
    expect(JSON.parse(greeted.stdout.toString())).toEqual({ ok: true });

    const mcp = new Client({ name: "installed-test", version: "1" });
    try {
      await mcp.connect(new StdioClientTransport({
        command: cli,
        args: ["mcp"],
        cwd,
        env: { NIWA_HOME: home.path, NIWA_VISIBLE: "surface.greet" },
        stderr: "inherit",
      }));
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["surface_greet"]);
      const result = await mcp.callTool({ name: "surface_greet", arguments: { text: "installed" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(JSON.parse(content[0]?.text ?? "")).toEqual({ ok: true });
    } finally {
      await mcp.close();
    }
  }

  try {
    cpSync(release, checkout, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const activated = run([process.execPath, installer, "activate", release, bin]);
    expect(activated.stderr.toString()).toBe("");
    expect(activated.exitCode).toBe(0);
    expect(run([cli, "skill"]).stdout.toString()).toContain("name: niwa");

    const devEntry = join(checkout, "packages/niwa/bin/niwa.ts");
    expect(run([process.execPath, devEntry, "skill"]).exitCode).toBe(0);
    host = spawnHost(join(checkout, "packages/niwa/test/fixtures/surface-host.ts"), home.path);
    await host.ready();

    // Break only a transitive import in the disposable development checkout.
    writeFileSync(join(checkout, "packages/client/src/index.ts"), "export const = ;\n");
    expect(run([process.execPath, devEntry, "skill"]).exitCode).not.toBe(0);
    await checkClients();

    const before = readFileSync(cli);
    const rejected = run([process.execPath, installer, "activate", checkout, bin]);
    expect(rejected.exitCode).not.toBe(0);
    expect(readFileSync(cli)).toEqual(before);

    renameSync(checkout, join(cwd, "removed-dev"));
    await checkClients();
  } finally {
    await host?.kill();
    await home.cleanup();
  }
}, 180_000);
