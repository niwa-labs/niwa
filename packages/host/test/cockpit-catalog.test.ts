// The host lists the cockpit modules its plugins offer, with a hash of each module's code. It reads the point
// itself, so a plugin may offer a module with no reader installed.
//
//   1. a host whose plugin offers a module serves, and the catalogue lists it with the plugin's version
//   2. the hash covers the entry and the local files it imports, and nothing else
//   3. an offer that names no file, or a bad id, is refused when the catalogue is read
//   4. an offer to a reader that is not installed is still refused at start

import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CATALOG_ACTION, CatalogOutput } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { COCKPIT_MODULE, offerKey, plugin } from "@niwa-labs/plugin";
import type { CockpitModuleOffer } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";

async function withHost(
  offers: (dir: string) => CockpitModuleOffer[],
  run: (catalog: () => Promise<ReturnType<typeof CatalogOutput.parse>>, dir: string) => Promise<void>,
): Promise<void> {
  const home = await tempHome();
  const dir = join(home.path, "module");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.tsx"), `import { page } from "./page.tsx";\nexport default page;\n`);
  await writeFile(join(dir, "page.tsx"), `export const page = 1;\n`);
  await writeFile(join(dir, "unrelated.ts"), `export const unrelated = 1;\n`);
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("offers", (api) => {
      for (const offer of offers(dir)) api.offer(COCKPIT_MODULE, offer);
    }),
  );
  await niwa.serve();
  try {
    await run(async () => CatalogOutput.parse(await niwa.call(CATALOG_ACTION, {})), dir);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}

test("a host whose plugin offers a cockpit module serves and lists it", () =>
  withHost(
    (dir) => [{ id: "demo", entry: join(dir, "index.tsx") }],
    async (catalog) => {
      const { modules } = await catalog();
      expect(modules).toHaveLength(1);
      expect(modules[0]).toMatchObject({ id: "demo", plugin: "offers", styles: [] });
      expect(modules[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(modules[0]?.version).not.toBe("");
    },
  ));

test("the hash of a module follows the files it imports and no others", () =>
  withHost(
    (dir) => [{ id: "demo", entry: join(dir, "index.tsx"), styles: [join(dir, "unrelated.ts")] }],
    async (catalog, dir) => {
      const before = (await catalog()).modules[0]!;
      expect((await catalog()).modules[0]?.hash).toBe(before.hash);

      await writeFile(join(dir, "unrelated.ts"), `export const unrelated = 2;\n`);
      const afterUnrelated = (await catalog()).modules[0]!;
      expect(afterUnrelated.hash).toBe(before.hash);
      // A stylesheet is hashed on its own: the page that links it needs the new address.
      expect(afterUnrelated.styles[0]?.hash).not.toBe(before.styles[0]?.hash);

      await writeFile(join(dir, "page.tsx"), `export const page = 2;\n`);
      expect((await catalog()).modules[0]?.hash).not.toBe(before.hash);
    },
  ));

test("a module with a file that does not parse is still listed, so the others are", () =>
  withHost(
    (dir) => [{ id: "demo", entry: join(dir, "index.tsx") }],
    async (catalog, dir) => {
      const before = (await catalog()).modules[0]!;
      await writeFile(join(dir, "page.tsx"), `export const page = (;\n`);
      const after = (await catalog()).modules[0]!;
      expect(after.id).toBe("demo");
      expect(after.hash).not.toBe(before.hash);
    },
  ));

test("an offer that names no file or a bad id is refused when the catalogue is read", async () => {
  await withHost(
    (dir) => [{ id: "demo", entry: join(dir, "missing.tsx") }],
    async (catalog) => {
      await expect(catalog()).rejects.toThrow(/is not a file/);
    },
  );
  await withHost(
    (dir) => [{ id: "Not A Plugin", entry: join(dir, "index.tsx") }],
    async (catalog) => {
      await expect(catalog()).rejects.toThrow(/lowercase words/);
    },
  );
  await withHost(
    () => [{ id: "demo", entry: "relative/index.tsx" }],
    async (catalog) => {
      await expect(catalog()).rejects.toThrow(/not an absolute path/);
    },
  );
});

test("an offer to a reader that is not installed is refused at start", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const orphan = offerKey<string>("orphan.point", "nobody");
  niwa.use(plugin("offers", (api) => api.offer(orphan, "lost")));
  try {
    await expect(niwa.serve()).rejects.toThrow(/nobody/);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
