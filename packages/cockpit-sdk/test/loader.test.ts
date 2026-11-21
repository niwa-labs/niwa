import { describe, expect, test } from "bun:test";

import { catalogueSources, createRecordStream, createViewer, definePlugin, loadPlugins, parseCatalogue } from "../src/index.ts";
import { scriptedClient } from "./fixtures.ts";

function services() {
  const { client } = scriptedClient();
  return { viewer: createViewer({ id: "web", owner: false, actions: ["task.list"] }), host: client, records: createRecordStream(client) };
}

const Part = () => null;

describe("the catalogue", () => {
  const catalogue = parseCatalogue({
    modules: [
      { id: "sessions", package: "@niwa-labs/sessions", version: "0.1.0", entry: "/cockpit/sessions.js", hash: "abc" },
      { id: "rin", package: "@niwa-labs/rin", version: "0.1.0", entry: "/cockpit/rin.js?v=1", hash: "d e", styles: ["/cockpit/rin.css"] },
    ],
  });

  test("a malformed catalogue is an error", () => {
    expect(() => parseCatalogue({ modules: [{ id: "Bad", package: "x", version: "1", entry: "/x", hash: "h" }] })).toThrow();
    expect(() => parseCatalogue({})).toThrow();
  });

  test("modules are imported by an address that carries their hash", async () => {
    const urls: string[] = [];
    const sources = catalogueSources(catalogue, async (url) => {
      urls.push(url);
      return {};
    });
    expect(sources.map((s) => s.id)).toEqual(["sessions", "rin"]);
    await Promise.all(sources.map((s) => s.load()));
    expect(urls).toEqual(["/cockpit/sessions.js?h=abc", "/cockpit/rin.js?v=1&h=d%20e"]);
  });
});

describe("loading", () => {
  test("each failure is the failing module's own; the rest load", async () => {
    const plugin = (id: string) => definePlugin({ id, setup: (ctx) => ctx.pages.add({ path: `/${id}`, title: id, component: Part }) });
    const { registry, faults } = await loadPlugins(
      [
        { id: "ok", load: async () => ({ default: plugin("ok") }) },
        { id: "missing", load: async () => Promise.reject(new Error("404 Not Found")) },
        { id: "plain", load: async () => ({ default: { id: "plain", setup() {} } }) },
        { id: "renamed", load: async () => ({ default: plugin("other") }) },
        { id: "throws", load: async () => ({ default: definePlugin({ id: "throws", setup: () => { throw new Error("boom"); } }) }) },
        { id: "ok", load: async () => ({ default: plugin("ok") }) },
        { id: "also-ok", load: async () => ({ default: plugin("also-ok") }) },
      ],
      services(),
    );
    expect(faults.map((f) => [f.plugin, f.phase, f.message])).toEqual([
      ["ok", "load", "the module ok is listed twice"],
      ["missing", "load", "404 Not Found"],
      ["plain", "load", "the module plain does not export a plugin made with definePlugin"],
      ["renamed", "load", "the module renamed exports the plugin other"],
      ["throws", "setup", "boom"],
    ]);
    expect(registry.plugins).toEqual(["ok", "also-ok"]);
  });

  test("setup sees the viewer and the host", async () => {
    let seen: { owner: boolean; canList: boolean; canStop: boolean } | undefined;
    await loadPlugins(
      [
        {
          id: "probe",
          load: async () => ({
            default: definePlugin({
              id: "probe",
              setup: (ctx) => {
                seen = { owner: ctx.viewer.owner, canList: ctx.viewer.can("task.list"), canStop: ctx.viewer.can({ name: "run.stop" }) };
              },
            }),
          }),
        },
      ],
      services(),
    );
    expect(seen).toEqual({ owner: false, canList: true, canStop: false });
  });
});
