// The cockpit app without a browser: the build's import map, when a build is stale, the routes' query as strings, and the
// start order: who is looking, the catalogue, the modules loaded and set up, and only then the router.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { definePlugin, HostCallError } from "@niwa-labs/cockpit-sdk";
import { createMemoryHistory } from "@tanstack/react-router";

import { bootCockpit, DEFAULT_BACKLOG, startFailure } from "../src/boot.tsx";
import { BUILD_SOURCES, importsOf, isStale, SHARED_MODULES } from "../src/index.ts";
import { parseSearch, stringifySearch } from "../src/router.tsx";
import { entryName } from "../src/shared-modules.ts";

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

test("a build older than its sources is stale", () => {
  const root = folder();
  const source = folder();
  writeFileSync(join(source, "page.tsx"), "export {}");
  manifestOf(root, {});
  const built = join(root, ".vite", "manifest.json");
  utimesSync(join(source, "page.tsx"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(source, new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(built, new Date(2026, 0, 2), new Date(2026, 0, 2));
  expect(isStale(root, [source])).toBe(false);
  utimesSync(join(source, "page.tsx"), new Date(2026, 0, 3), new Date(2026, 0, 3));
  expect(isStale(root, [source])).toBe(true);
  expect(isStale(join(root, "missing"), [source])).toBe(true);
});

test("a login that is missing is said in words, any other failure with its reason", () => {
  expect(startFailure(new HostCallError(401, "no cookie"))).toContain("You are not logged in");
  expect(startFailure(new HostCallError(502, "the host is down"))).toBe("The cockpit could not start: the host is down");
  expect(startFailure("plain")).toBe("The cockpit could not start: plain");
});

type Served = Record<string, () => Response>;

function fetching(served: Served, seen: string[]): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const path = url.split("?")[0] ?? "";
    if (path.endsWith("/api/events")) {
      // The feed stays open until the app closes it.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close());
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    const make = served[path.replace(/^https?:\/\/[^/]+/, "")];
    return make === undefined ? new Response("no such address", { status: 404 }) : make();
  }) as typeof fetch;
}

const json = (value: unknown): (() => Response) => () => Response.json(value);

function module(id: string, entry = `/modules/${id}/${"a".repeat(64)}/index.js`) {
  return { id, package: `@niwa-labs/${id}`, version: "0.0.0", entry, hash: "a".repeat(64) };
}

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
