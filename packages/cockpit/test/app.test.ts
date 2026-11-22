// The cockpit app without a browser: the build's import map, when a build is stale, the routes' query as strings, and the
// start order: who is looking, the catalogue, the modules loaded and set up, and only then the router.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { definePlugin, HostCallError } from "@niwa-labs/cockpit-sdk";
import { createMemoryHistory } from "@tanstack/react-router";

import { bootCockpit, DEFAULT_BACKLOG, startFailure } from "../src/boot.tsx";
import { NOTICE_ASSET } from "../scripts/third-party-notices.ts";
import { ARTIFACT, BUILD_SOURCES, buildCockpit, cockpitApp, fingerprint, importsOf, PACKAGE_ROOT, SHARED_MODULES } from "../src/index.ts";
import { parseSearch, stringifySearch } from "../src/router.tsx";
import { entryName } from "../src/shared-modules.ts";
import { fetching, json, module } from "./support.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "niwa-cockpit-"));
  folders.push(made);
  return made;
}

function manifestOf(root: string, entries: Record<string, { file: string; name: string; isEntry: boolean }>): void {
  mkdirSync(join(root, ".vite"), { recursive: true });
  writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify(entries));
}

test("the query of a page is read as strings and written back", () => {
  expect(parseSearch("?n=1&tab=plan")).toEqual({ n: "1", tab: "plan" });
  expect(stringifySearch({ n: 1, tab: "plan", gone: undefined })).toBe("?n=1&tab=plan");
  expect(stringifySearch({})).toBe("");
});

test("the import map names each shared module by the entry that serves it", () => {
  const root = folder();
  expect(importsOf(root)).toBeUndefined();
  const manifest = Object.fromEntries(SHARED_MODULES.map((one) => [one.name, { file: `assets/${entryName(one.name)}-abc.js`, name: entryName(one.name), isEntry: true }]));
  manifestOf(root, manifest);
  const imports = importsOf(root);
  expect(Object.keys(imports ?? {}).sort()).toEqual(SHARED_MODULES.map((one) => one.name).sort());
  expect(imports?.react).toBe("/assets/shared-react-abc.js");

  // A build that lacks one of the shared modules is no app: a module would fail to import it.
  const { zod: _left, ...fewer } = manifest as Record<string, never>;
  manifestOf(root, fewer);
  expect(importsOf(root)).toBeUndefined();
});

/** A builder that makes the smallest app that names every shared module, and counts its builds. */
function fakeBuilder(): { builder: (outDir: string) => Promise<void>; built: string[] } {
  const built: string[] = [];
  return {
    built,
    builder: async (outDir) => {
      built.push(outDir);
      mkdirSync(join(outDir, "assets"), { recursive: true });
      writeFileSync(join(outDir, "index.html"), `<html>${String(built.length)}</html>`);
      writeFileSync(join(outDir, "assets", "app.js"), `// build ${String(built.length)}`);
      manifestOf(
        outDir,
        Object.fromEntries(SHARED_MODULES.map((one) => [one.name, { file: `assets/${entryName(one.name)}-${String(built.length)}.js`, name: entryName(one.name), isEntry: true }])),
      );
    },
  };
}

test("the name of a state of the sources follows their content, not when they were written", () => {
  const source = folder();
  writeFileSync(join(source, "page.tsx"), "export {}");
  const before = fingerprint([source]);
  utimesSync(join(source, "page.tsx"), new Date(2030, 0, 1), new Date(2030, 0, 1));
  expect(fingerprint([source])).toBe(before);
  writeFileSync(join(source, "page.tsx"), "export const a = 1");
  expect(fingerprint([source])).not.toBe(before);
  writeFileSync(join(source, "other.tsx"), "");
  expect(fingerprint([source])).not.toBe(fingerprint([folder()]));
});

test("the app is also built from every folder its stylesheet scans for the classes of the plugins' pages", () => {
  const packages = join(PACKAGE_ROOT, "..");
  const scanned = readdirSync(packages)
    .map((name) => join(packages, name, "src", "cockpit"))
    .filter((path) => existsSync(path));
  expect(scanned.length).toBeGreaterThan(0);
  const named = BUILD_SOURCES.map((source) => source.replace(/\/+$/, ""));
  for (const path of scanned) expect(named, path).toContain(path);
});

test("a checkout builds the app once for a state of its sources, and a change of the sources is a build of its own that leaves the old one alone", async () => {
  const sources = folder();
  const builds = folder();
  writeFileSync(join(sources, "page.tsx"), "export {}");
  const made = fakeBuilder();
  const options = { builds, sources: [sources], builder: made.builder };

  const first = await cockpitApp(options);
  expect(made.built).toHaveLength(1);
  expect(first.root.startsWith(builds)).toBe(true);
  expect((await cockpitApp(options)).root).toBe(first.root);
  expect(made.built).toHaveLength(1);

  // A server that started with the first build keeps its files while the sources change and another server starts.
  writeFileSync(join(sources, "page.tsx"), "export const changed = true");
  const second = await cockpitApp(options);
  expect(made.built).toHaveLength(2);
  expect(second.root).not.toBe(first.root);
  expect(second.imports.react).not.toBe(first.imports.react);
  expect(readFileSync(join(first.root, "assets", "app.js"), "utf8")).toBe("// build 1");
  expect(importsOf(first.root)).toEqual(first.imports);

  // Nothing is left beside the builds that were made, and a build that is asked for again is a folder of its own.
  const forced = await cockpitApp({ ...options, rebuild: true });
  expect(forced.root).not.toBe(second.root);
  expect(readdirSync(builds)).toHaveLength(3);
});

test("a build is moved into place only when it is complete", async () => {
  const sources = folder();
  const builds = folder();
  writeFileSync(join(sources, "page.tsx"), "export {}");
  const incomplete = async (outDir: string) => {
    manifestOf(outDir, {});
  };
  await expect(cockpitApp({ builds, sources: [sources], builder: incomplete })).rejects.toThrow("without every shared module");
  expect(readdirSync(builds)).toEqual([]);
  const failing = async () => {
    throw new Error("the build failed");
  };
  await expect(cockpitApp({ builds, sources: [sources], builder: failing })).rejects.toThrow("the build failed");
  expect(readdirSync(builds)).toEqual([]);
});

test("an installed package serves the app it was packed with, and builds nothing", async () => {
  const installed = folder();
  const artifact = join(installed, "dist", "app");
  await fakeBuilder().builder(artifact);
  expect(existsSync(join(installed, "vite.config.ts"))).toBe(false);
  const never = async () => {
    throw new Error("an installed package has nothing to build from");
  };
  const app = await cockpitApp({ packageRoot: installed, builder: never });
  expect(app.root).toBe(artifact);
  expect(Object.keys(app.imports).sort()).toEqual(SHARED_MODULES.map((one) => one.name).sort());

  // A package packed without the app says so.
  await expect(cockpitApp({ packageRoot: folder(), builder: never })).rejects.toThrow("was not built");
});

test("packing builds the app and ships it, with the entry that serves it and nothing that builds it", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
  expect(manifest.scripts.prepack).toBe(manifest.scripts.build);
  expect(manifest.files).toContain("dist/app");
  expect(manifest.files).toContain("src/index.ts");
  expect(manifest.files).not.toContain("vite.config.ts");
  // The app is built where the package ships it from.
  expect(readFileSync(join(PACKAGE_ROOT, "scripts", "build.ts"), "utf8")).toContain("outDir: ARTIFACT");
  expect(ARTIFACT).toBe(join(PACKAGE_ROOT, "dist", "app"));
});

test("the production app carries permission and attribution for its bundled code and assets", async () => {
  const output = await buildCockpit({ outDir: folder() });
  const report = readFileSync(join(output, NOTICE_ASSET), "utf8");
  expect(report).toContain("## react - ");
  expect(report).toContain("Copyright (c) Meta Platforms, Inc. and affiliates.");
  expect(report).toMatch(/## tailwindcss - .+ \(MIT\)/);
  expect(report).toContain("Copyright (c) Tailwind Labs, Inc.");
  expect(report).toMatch(/## @pierre\/highlights - .+ \(NOTICE\.md\)/);
  expect(report).toMatch(/## @pierre\/theme - .+ \(NOTICE\.md\)/);

  for (const file of [
    "textmate-source-revisions.txt",
    "tm-grammars-1.32.22.NOTICE",
    "tm-themes-1.12.12.NOTICE",
    "vscode-oniguruma-1.7.0.LICENSE.txt",
    "vscode-oniguruma-1.7.0.NOTICES.txt",
  ]) {
    expect(report).toContain(readFileSync(join(PACKAGE_ROOT, "notices", file), "utf8"));
  }
}, 30_000);

test("a login that is missing is said in words, any other failure with its reason", () => {
  expect(startFailure(new HostCallError(401, "no cookie"))).toContain("You are not logged in");
  expect(startFailure(new HostCallError(502, "the host is down"))).toBe("The cockpit could not start: the host is down");
  expect(startFailure("plain")).toBe("The cockpit could not start: plain");
});

test("the cockpit loads the listed modules before it makes the router, and a broken module leaves only itself out", async () => {
  const seen: string[] = [];
  const imported: string[] = [];
  const fetchStub = fetching(
    {
      "/api/viewer": json({ id: "web", owner: true, actions: ["workflow.runs"] }),
      "/api/info": json({ actions: [], seq: 5_000 }),
      "/api/catalogue": json({ modules: [module("alpha"), module("broken"), module("beta")] }),
    },
    seen,
  );
  const modules: Record<string, unknown> = {
    alpha: { default: definePlugin({ id: "alpha", setup: (ctx) => ctx.pages.add({ path: "/alpha", title: "Alpha", nav: { order: 1 }, component: () => null }) }) },
    beta: { default: definePlugin({ id: "beta", setup: (ctx) => ctx.pages.add({ path: "/beta/$id", title: "Beta", component: () => null }) }) },
  };
  const cockpit = await bootCockpit({
    fetch: fetchStub,
    history: createMemoryHistory({ initialEntries: ["/beta/7"] }),
    importModule: async (url) => {
      imported.push(url);
      const found = modules[url.split("/")[2] ?? ""];
      if (found === undefined) throw new Error("cannot be imported");
      return found;
    },
  });
  try {
    expect(imported.sort()).toEqual([`/modules/alpha/${"a".repeat(64)}/index.js`, `/modules/beta/${"a".repeat(64)}/index.js`, `/modules/broken/${"a".repeat(64)}/index.js`].sort());
    expect(cockpit.runtime.registry.pages.map((page) => page.path)).toEqual(["/alpha", "/beta/$id"]);
    expect(cockpit.faults.snapshot().map((fault) => [fault.plugin, fault.phase])).toEqual([["broken", "load"]]);
    expect(cockpit.runtime.viewer).toMatchObject({ id: "web", owner: true });
    // The routes know every page the modules added, with their parameters.
    await cockpit.router.load();
    expect(cockpit.router.state.matches.map((match) => match.routeId)).toContain("/beta/$id");
    expect(cockpit.router.state.matches.at(-1)?.params).toEqual({ id: "7" });
    // The feed starts a backlog before the end of the journal, not at its beginning.
    expect(seen.find((url) => url.includes("/api/events"))).toContain(`after=${String(5_000 - DEFAULT_BACKLOG)}`);
  } finally {
    cockpit.stop();
  }
});

test("a module offered under a base path is imported from that path", async () => {
  const seen: string[] = [];
  const imported: string[] = [];
  const cockpit = await bootCockpit({
    base: "http://127.0.0.1:1/niwa/",
    fetch: fetching(
      {
        "/niwa/api/viewer": json({ id: "web", owner: false, actions: [] }),
        "/niwa/api/info": json({ actions: [], seq: 3 }),
        "/niwa/api/catalogue": json({ modules: [module("alpha")] }),
      },
      seen,
    ),
    importModule: async (url) => {
      imported.push(url);
      return { default: definePlugin({ id: "alpha", setup: () => {} }) };
    },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    expect(imported).toEqual([`http://127.0.0.1:1/niwa/modules/alpha/${"a".repeat(64)}/index.js`]);
    // A journal shorter than the backlog is read from its start.
    expect(seen.find((url) => url.includes("/api/events"))).toContain("after=0");
  } finally {
    cockpit.stop();
  }
});

test("a server that does not say who is looking stops the start", async () => {
  const fetchStub = fetching({ "/api/viewer": json({ nobody: true }), "/api/info": json({ actions: [] }), "/api/catalogue": json({ modules: [] }) }, []);
  await expect(bootCockpit({ fetch: fetchStub })).rejects.toThrow("the server did not say who is looking");
});

test("the app is built from the kit and the SDK too, so a change in either makes it stale", () => {
  const named = BUILD_SOURCES.map((source) => source.replace(/\/+$/, ""));
  expect(named.some((source) => source.endsWith("/cockpit-sdk/src"))).toBe(true);
  expect(named.some((source) => source.endsWith("/ui-kit/src"))).toBe(true);
  expect(named.every((source) => existsSync(source))).toBe(true);
});

test("a module that registers the shell's own path is left out, and the router still builds", async () => {
  const seen: string[] = [];
  const modules: Record<string, unknown> = {
    greedy: { default: definePlugin({ id: "greedy", setup: (ctx) => ctx.pages.add({ path: "/", title: "Mine", component: () => null }) }) },
    beta: { default: definePlugin({ id: "beta", setup: (ctx) => ctx.pages.add({ path: "/beta", title: "Beta", component: () => null }) }) },
  };
  const cockpit = await bootCockpit({
    fetch: fetching(
      {
        "/api/viewer": json({ id: "web", owner: true, actions: [] }),
        "/api/info": json({ actions: [], seq: 0 }),
        "/api/catalogue": json({ modules: [module("greedy"), module("beta")] }),
      },
      seen,
    ),
    history: createMemoryHistory({ initialEntries: ["/beta"] }),
    importModule: async (url) => modules[url.split("/")[2] ?? ""],
  });
  try {
    expect(cockpit.faults.snapshot().map((fault) => [fault.plugin, fault.phase, fault.place])).toEqual([["greedy", "register", "/"]]);
    expect(cockpit.runtime.registry.pages.map((page) => page.path)).toEqual(["/beta"]);
    await cockpit.router.load();
    expect(cockpit.router.state.matches.map((match) => match.routeId)).toContain("/beta");
  } finally {
    cockpit.stop();
  }
});
