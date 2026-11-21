// The web surface serves the cockpit app and the client modules of the plugins.
//
//   1. `/` and every address of the app is the app's page, with the import map first and a policy that names its script
//   2. the app's files are served with their types; nothing outside the folder, and nothing that is not there, is
//   3. the catalogue names the modules the host lists, and a module is served only under the id and hash it is listed by
//   4. a module is built for the browser with the shared modules left as imports the import map resolves
//   5. a changed module is a new address, and the old one is gone
//   6. the address is the hash of the bytes served, so other shared modules mean another address
//   7. without an app the surface serves its pages and no module

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { COCKPIT_MODULE, createNiwa, loginWeb, plugin, tempHome, webFetch } from "@niwa-labs/testing";
import type { WebApp, WebServer } from "../src/index.ts";

import { serveWebPages } from "./fixtures/serve-web.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const IMPORTS = { react: "/assets/react-abc.js", "react/jsx-runtime": "/assets/jsx-abc.js", "@niwa-labs/cockpit-sdk": "/assets/sdk-abc.js" };

type Setup = { web: WebServer; dir: string; app: WebApp };

async function setup(options: { app?: boolean; root?: (dir: string) => Promise<string> } = {}): Promise<Setup> {
  const home = await tempHome();
  const dir = join(home.path, "site");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>niwa</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`);
  await writeFile(join(dir, "assets", "app.js"), `console.log("app");`);
  await writeFile(join(dir, "assets", "app.css"), `body { margin: 0 }`);
  await writeFile(join(home.path, "secret.txt"), "secret");
  const module = join(home.path, "module");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "index.tsx"), `import { definePlugin } from "@niwa-labs/cockpit-sdk";\nimport { helper } from "./helper.ts";\nexport default definePlugin({ id: "demo", setup() { helper(<b>hi</b>); } });\n`);
  await writeFile(join(module, "helper.ts"), `export function helper(value: unknown): unknown { return value; }\n`);
  await writeFile(join(module, "demo.css"), `.demo { color: red }`);
  const host = createNiwa({ home: home.path });
  host.use(plugin("offers", (api) => api.offer(COCKPIT_MODULE, { id: "demo", entry: join(module, "index.tsx"), styles: [join(module, "demo.css")] })));
  await host.serve();
  const app: WebApp = { root: options.root === undefined ? dir : await options.root(dir), imports: IMPORTS };
  const web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner", ...(options.app === false ? {} : { app }) });
  await loginWeb(web);
  cleanups.push(async () => {
    await web.close();
    await host.close();
    await home.cleanup();
  });
  return { web, dir: module, app };
}

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

test("the app's page has the import map before its scripts and a policy that names the map's script", async () => {
  const { web } = await setup();
  for (const path of ["/", "/runs/run-1", "/sessions/s-1/transcript"]) {
    const page = await webFetch(`${web.url}${path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await page.text();
    const map = /<script type="importmap">(.*?)<\/script>/.exec(body);
    expect(map).not.toBeNull();
    expect(JSON.parse(map![1]!)).toEqual({ imports: IMPORTS });
    expect(body.indexOf('type="importmap"')).toBeLessThan(body.indexOf('type="module"'));
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain(`script-src 'self' ${sha(map![1]!)}`);
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self'");
  }
});

test("the app's files are served with their types, and nothing outside the folder is", async () => {
  const { web } = await setup();
  const script = await webFetch(`${web.url}/assets/app.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  expect(script.headers.get("cache-control")).toContain("immutable");
  expect(await script.text()).toBe(`console.log("app");`);
  expect((await webFetch(`${web.url}/assets/app.css`)).headers.get("content-type")).toBe("text/css; charset=utf-8");

  expect((await webFetch(`${web.url}/assets/missing.js`)).status).toBe(404);
  expect((await webFetch(`${web.url}/assets/%2e%2e/index.html`)).status).toBe(404);
  expect((await webFetch(`${web.url}/assets/..%2f..%2fsecret.txt`)).status).toBe(404);
  expect((await webFetch(`${web.url}/assets/%00`)).status).toBe(404);
  // A file that is not there is not a page of the app.
  expect((await webFetch(`${web.url}/favicon.ico`)).status).toBe(404);
  expect((await webFetch(`${web.url}/api/nothing`)).status).toBe(404);
  expect((await webFetch(`${web.url}/runs/run-1`, { method: "POST" })).status).toBe(405);
  // Without the cookie nothing is served.
  expect((await fetch(`${web.url}/assets/app.js`)).status).toBe(401);
});

test("a link inside the folder does not lead out of it, and one that stays inside is a file of the app", async () => {
  const { web, app } = await setup();
  await symlink(join(app.root, "..", "secret.txt"), join(app.root, "assets", "leak.txt"));
  await symlink(join(app.root, "assets", "app.js"), join(app.root, "assets", "alias.js"));
  expect((await webFetch(`${web.url}/assets/leak.txt`)).status).toBe(404);
  expect(await (await webFetch(`${web.url}/assets/alias.js`)).text()).toBe(`console.log("app");`);
});

test("the folder of the app may be named with a trailing slash or through a link", async () => {
  const named = [
    async (site: string) => `${site}/`,
    async (site: string) => {
      await symlink(site, `${site}-link`);
      return `${site}-link`;
    },
  ];
  for (const root of named) {
    const { web } = await setup({ root });
    expect(await (await webFetch(`${web.url}/assets/app.js`)).text()).toBe(`console.log("app");`);
    expect((await webFetch(`${web.url}/assets/../index.html`)).status).toBe(404);
  }
});

type Catalogue = { modules: Array<{ id: string; package: string; version: string; entry: string; hash: string; styles?: string[] }> };

test("the catalogue names the host's modules and a module is served only under the id and hash it is listed by", async () => {
  const { web } = await setup();
  const catalogue = (await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue;
  expect(catalogue.modules).toHaveLength(1);
  const [module] = catalogue.modules;
  expect(module).toMatchObject({ id: "demo", package: "offers" });
  expect(module?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(module?.entry).toBe(`/modules/demo/${module!.hash}/index.js`);
  expect(module?.styles).toHaveLength(1);

  const code = await webFetch(`${web.url}${module!.entry}`);
  expect(code.status).toBe(200);
  expect(code.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const style = await webFetch(`${web.url}${module!.styles![0]}`);
  expect(style.status).toBe(200);
  expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(await style.text()).toBe(".demo { color: red }");

  const other = "0".repeat(64);
  for (const path of [
    `/modules/demo/${other}/index.js`,
    `/modules/other/${module!.hash}/index.js`,
    `/modules/demo/${module!.hash}/helper.ts`,
    `/modules/demo/${module!.hash}/../../index.js`,
    `/modules/demo/${module!.hash}/style-0-000000000000.css`,
    `/modules/demo/${module!.hash}/style-7-${module!.styles![0]!.match(/-([0-9a-f]{12})\.css$/)![1]!}.css`,
    `/modules/demo`,
  ]) {
    expect((await webFetch(`${web.url}${path}`)).status, path).toBe(404);
  }
});

/** The names a module imports that are not relative paths. */
function bareImports(code: string): string[] {
  return [...new Bun.Transpiler({ loader: "js" }).scanImports(code).map((entry) => entry.path)].filter((path) => !path.startsWith(".") && !path.startsWith("/"));
}

test("a module is built for the browser with the shared modules left as imports and its own files inlined", async () => {
  const { web } = await setup();
  const [module] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  const code = await (await webFetch(`${web.url}${module!.entry}`)).text();
  const bare = bareImports(code);
  expect(bare).toContain("@niwa-labs/cockpit-sdk");
  expect(bare).toContain("react/jsx-runtime");
  // Every import the import map has to resolve is one of its names, so the page needs nothing else.
  for (const name of bare) expect(Object.keys(IMPORTS), name).toContain(name);
  // No development runtime, which the production React of the app does not have, and no node module.
  expect(code).not.toContain("jsx-dev-runtime");
  expect(code).not.toMatch(/["'](node|bun):/);
  // The JSX of the entry is compiled to the production runtime, and the file it imports is part of the module.
  expect(code).toContain('"b"');
  expect(code).not.toContain("./helper");
});

test("the address of a module is the hash of the bytes served there, and so is the address of its sheet", async () => {
  const { web } = await setup();
  const [module] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  const code = await (await webFetch(`${web.url}${module!.entry}`)).text();
  expect(module!.hash).toBe(createHash("sha256").update(code).digest("hex"));
  const style = await (await webFetch(`${web.url}${module!.styles![0]}`)).text();
  expect(module!.styles![0]).toBe(`/modules/demo/${module!.hash}/style-0-${createHash("sha256").update(style).digest("hex").slice(0, 12)}.css`);
});

test("the same source built against other shared modules is served at another address", async () => {
  const { web, dir, app } = await setup();
  await mkdir(join(dir, "node_modules", "tinydep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "tinydep", "package.json"), `{ "name": "tinydep", "type": "module", "main": "index.js" }`);
  await writeFile(join(dir, "node_modules", "tinydep", "index.js"), `export const tiny = "${"x".repeat(2_000)}";\n`);
  await writeFile(join(dir, "helper.ts"), `import { tiny } from "tinydep";\nexport function helper(value: unknown): unknown { return [value, tiny]; }\n`);

  // One page shares `tinydep` and leaves it an import; the other carries its own copy of it.
  const sharing = await serveWebPages({ home: join(app.root, ".."), port: 0, speaksFor: "owner", app: { root: app.root, imports: { ...IMPORTS, tinydep: "/assets/tinydep.js" } } });
  cleanups.push(() => sharing.close());
  await loginWeb(sharing);

  const [bundled] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  const [shared] = ((await (await webFetch(`${sharing.url}/api/catalogue`)).json()) as Catalogue).modules;
  const bundledCode = await (await webFetch(`${web.url}${bundled!.entry}`)).text();
  const sharedCode = await (await webFetch(`${sharing.url}${shared!.entry}`)).text();
  expect(bundledCode).not.toBe(sharedCode);
  expect(bundledCode.length).toBeGreaterThan(sharedCode.length);
  // Other bytes, other name: a browser that kept one of them is not served the other under its address.
  expect(bundled!.entry).not.toBe(shared!.entry);
});

test("a changed module is a new address, and the old address is gone", async () => {
  const { web, dir } = await setup();
  const [before] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  expect((await webFetch(`${web.url}${before!.entry}`)).status).toBe(200);

  await writeFile(join(dir, "helper.ts"), `export function helper(value: unknown): unknown { return [value, "changed"]; }\n`);
  const [after] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  expect(after?.hash).not.toBe(before?.hash);
  expect((await webFetch(`${web.url}${before!.entry}`)).status).toBe(404);
  const code = await (await webFetch(`${web.url}${after!.entry}`)).text();
  expect(code).toContain("changed");
});

test("a module that cannot be built is a server error that says why", async () => {
  const { web, dir } = await setup();
  await writeFile(join(dir, "helper.ts"), `export function helper( {\n`);
  const [broken] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  const failed = await webFetch(`${web.url}${broken!.entry}`);
  expect(failed.status).toBe(500);
  expect(await failed.text()).toContain("could not be built");
});

test("without an app the surface serves its pages and no module", async () => {
  const { web } = await setup({ app: false });
  const page = await webFetch(web.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("EventSource");
  const [module] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  expect((await webFetch(`${web.url}${module!.entry}`)).status).toBe(404);
  expect((await webFetch(`${web.url}/assets/app.js`)).status).toBe(404);
});

test("a module that imports a subpath of a shared package the page does not map is refused at its build", async () => {
  const { web, dir } = await setup();
  // The page's map has `react` and `react/jsx-runtime`; `react/compiler-runtime` is not in it.
  await writeFile(join(dir, "helper.ts"), `import { c } from "react/compiler-runtime";\nexport function helper(value: unknown): unknown { return [c, value]; }\n`);
  const [module] = ((await (await webFetch(`${web.url}/api/catalogue`)).json()) as Catalogue).modules;
  const failed = await webFetch(`${web.url}${module!.entry}`);
  expect(failed.status).toBe(500);
  const body = await failed.text();
  expect(body).toContain("react/compiler-runtime is not shared by the cockpit");
  expect(body).toContain("react/jsx-runtime");
});
