// The ACP adapter is a dependency of this package alone, so this package finds it and hands the
// result to discovery; the harness package, which runs the discovery, never looks for it.

import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { discover, findBundled } from "@niwa-labs/harness";
import type { BundledProgram } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { CLAUDE_CODE_ADAPTER } from "../../src/code/control.ts";
import { claudeCodeKind } from "../../src/code/index.ts";

const ADAPTER = { package: "@zed-industries/claude-code-acp", entry: "dist/index.js" } as const;

/** A package directory that holds the adapter under its own `node_modules`, or none. */
async function packageWith(root: string, name: string, adapterVersion?: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, type: "module" }));
  if (adapterVersion !== undefined) {
    const installed = join(dir, "node_modules", ADAPTER.package);
    await mkdir(join(installed, "dist"), { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: ADAPTER.package, version: adapterVersion }));
    await writeFile(join(installed, ADAPTER.entry), "");
  }
  return dir;
}

const fileIn = (dir: string): string => pathToFileURL(join(dir, "src", "index.ts")).href;

test("the adapter is found from the package that declares it, with its version", () => {
  const resolved = createRequire(import.meta.url);
  expect(CLAUDE_CODE_ADAPTER.package).toBe(ADAPTER.package);
  expect(CLAUDE_CODE_ADAPTER.path).toBe(resolved.resolve(`${ADAPTER.package}/${ADAPTER.entry}`));
  expect(CLAUDE_CODE_ADAPTER.version).toBe((resolved(`${ADAPTER.package}/package.json`) as { version: string }).version);
});

test("only harness-claude declares the adapter: the harness package does not", async () => {
  const manifest = async (name: string): Promise<{ dependencies?: Record<string, string> }> =>
    (await Bun.file(join(import.meta.dir, "..", "..", "..", name, "package.json")).json()) as { dependencies?: Record<string, string> };
  expect(Object.keys((await manifest("harness-claude")).dependencies ?? {})).toContain(ADAPTER.package);
  expect(Object.keys((await manifest("harness")).dependencies ?? {})).not.toContain(ADAPTER.package);
});

test("a package finds the adapter it holds, and one that does not hold it finds none", async () => {
  const root = realpathSync(await tempDir("adapter"));
  const holder = await packageWith(root, "holder", "9.8.7");
  const bystander = await packageWith(root, "bystander");

  const found = findBundled(fileIn(holder), ADAPTER);
  expect(found.path).toBe(join(holder, "node_modules", ADAPTER.package, ADAPTER.entry));
  expect(found.version).toBe("9.8.7");
  expect(findBundled(fileIn(bystander), ADAPTER)).toEqual({ package: ADAPTER.package });
});

test("discovery proposes the adapter the kind package found, not one the harness package would look for", async () => {
  const root = realpathSync(await tempDir("adapter-discovery"));
  const holder = await packageWith(root, "holder", "9.8.7");
  const home = join(root, "claude-home");
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(home, { recursive: true });
  const kind = claudeCodeKind;
  const env = { HOME: root, PATH: "" };
  const withAdapter = (bundled: BundledProgram) => ({ ...kind, detect: { bundled, home } });

  const found = await discover([withAdapter(findBundled(fileIn(holder), ADAPTER))], env);
  expect(found.proposals[0]?.binary).toEqual({
    path: join(holder, "node_modules", ADAPTER.package, ADAPTER.entry),
    version: "9.8.7",
  });

  const bystander = await packageWith(root, "bystander");
  const missing = await discover([withAdapter(findBundled(fileIn(bystander), ADAPTER))], env);
  expect(missing.proposals).toEqual([]);
  expect(missing.missing[0]?.reason).toContain(ADAPTER.package);

  // The kind as it is built here proposes the adapter this package resolves.
  const own = await discover([kind], env);
  expect(own.proposals[0]?.binary).toEqual({ path: CLAUDE_CODE_ADAPTER.path ?? "", version: CLAUDE_CODE_ADAPTER.version ?? "unknown" });
});
