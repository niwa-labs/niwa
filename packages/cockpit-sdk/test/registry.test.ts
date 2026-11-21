import { describe, expect, test } from "bun:test";

import {
  CORE_SLOTS,
  createRecordStream,
  createViewer,
  definePlugin,
  isCockpitPlugin,
  loadPlugins,
  RegistrationError,
  type PluginContext,
  type PluginSource,
  type SlotSpec,
} from "../src/index.ts";
import { scriptedClient } from "./fixtures.ts";

declare module "../src/index.ts" {
  interface SlotMap {
    "rin.panel": SlotSpec<"list", { agent: string }>;
    "frame.header": SlotSpec<"single", Record<never, never>>;
  }
}

const Part = () => null;

function services() {
  const { client } = scriptedClient();
  return { viewer: createViewer({ id: "web", owner: true, actions: [] }), host: client, records: createRecordStream(client) };
}

function source(id: string, setup: (ctx: PluginContext) => void | Promise<void>): PluginSource {
  return { id, load: async () => ({ default: definePlugin({ id, setup }) }) };
}

async function load(...sources: PluginSource[]) {
  return loadPlugins(sources, services(), { slots: [...CORE_SLOTS, { name: "frame.header", kind: "single" }] });
}

describe("definePlugin", () => {
  test("marks the plugin and checks its id and setup", () => {
    const plugin = definePlugin({ id: "rin", setup: () => {} });
    expect(isCockpitPlugin(plugin)).toBe(true);
    expect(isCockpitPlugin({ id: "rin", setup: () => {} })).toBe(false);
    expect(() => definePlugin({ id: "Rin", setup: () => {} })).toThrow("lowercase");
    expect(() => definePlugin({ id: "rin", setup: undefined as never })).toThrow("setup");
  });
});

describe("registration in a module's own setup", () => {
  test("an invalid page, slot or entity fails the setup where it is made", async () => {
    const { faults, registry } = await load(
      source("bad-path", (ctx) => ctx.pages.add({ path: "runs", title: "Runs", component: Part })),
      source("bad-key", (ctx) => ctx.slots.register("home.tile", { key: "", component: Part })),
      source("bad-kind", (ctx) => ctx.entities.register("Run", { label: "Run", href: (id) => `/runs/${id}` })),
      source("bad-prefix", (ctx) => ctx.entities.register("pr", { label: "PR", prefix: "pull-request", href: () => "/" })),
      source("bad-nav", (ctx) => ctx.pages.add({ path: "/runs/$runId", title: "Run", component: Part, nav: {} })),
      source("good", (ctx) => ctx.pages.add({ path: "/good", title: "Good", component: Part })),
    );
    expect(faults.map((f) => [f.plugin, f.phase])).toEqual([
      ["bad-path", "setup"],
      ["bad-key", "setup"],
      ["bad-kind", "setup"],
      ["bad-prefix", "setup"],
      ["bad-nav", "setup"],
    ]);
    expect(registry.plugins).toEqual(["good"]);
  });

  test("registering after setup ended throws", async () => {
    let saved: PluginContext | undefined;
    await load(source("late", (ctx) => void (saved = ctx)));
    expect(() => saved!.pages.add({ path: "/late", title: "Late", component: Part })).toThrow(RegistrationError);
  });

  test("an async setup is awaited", async () => {
    const { registry } = await load(
      source("slow", async (ctx) => {
        await Bun.sleep(1);
        ctx.pages.add({ path: "/slow", title: "Slow", component: Part });
      }),
    );
    expect(registry.pages.map((p) => p.path)).toEqual(["/slow"]);
  });
});

describe("slots", () => {
  test("a contribution to a slot nobody declares leaves the module out", async () => {
    const { faults, registry } = await load(
      source("lost", (ctx) => {
        ctx.pages.add({ path: "/lost", title: "Lost", component: Part });
        ctx.slots.register("rin.panel", { key: "x", component: Part });
      }),
    );
    expect(faults).toEqual([{ plugin: "lost", phase: "register", place: "rin.panel", message: "no module declares the slot rin.panel" }]);
    // Left out whole: its page is gone too.
    expect(registry.pages).toEqual([]);
  });

  test("a module may fill a slot declared by a module loaded after it", async () => {
    const { faults, registry } = await load(
      source("digest", (ctx) => ctx.slots.register("rin.panel", { key: "digest", component: Part })),
      source("rin", (ctx) => ctx.slots.declare("rin.panel", "list")),
    );
    expect(faults).toEqual([]);
    expect(registry.slot("rin.panel").map((c) => [c.plugin, c.key])).toEqual([["digest", "digest"]]);
  });

  test("conflicts are decided in load order: the cockpit, then earlier modules, keep what they took", async () => {
    const { faults, registry } = await load(
      source("digest", (ctx) => ctx.slots.register("rin.panel", { key: "digest", component: Part })),
      source("rin", (ctx) => {
        ctx.slots.declare("rin.panel", "list");
        ctx.slots.register("record.view", { key: "run.started", component: Part });
      }),
      source("rival", (ctx) => ctx.slots.register("record.view", { key: "run.started", component: Part })),
      source("dup", (ctx) => ctx.slots.declare("home.tile", "list")),
    );
    expect(faults.map((f) => [f.plugin, f.message])).toEqual([
      ["rival", "the key run.started in record.view is already used by rin"],
      ["dup", "the slot home.tile is already declared by cockpit"],
    ]);
    expect(registry.plugins).toEqual(["digest", "rin"]);
  });

  test("list keys only need to be unique within a module", async () => {
    const { faults, registry } = await load(
      source("a", (ctx) => ctx.slots.register("home.tile", { key: "overview", component: Part })),
      source("b", (ctx) => ctx.slots.register("home.tile", { key: "overview", component: Part })),
      source("c", (ctx) => {
        ctx.slots.register("home.tile", { key: "twice", component: Part });
        ctx.slots.register("home.tile", { key: "twice", component: Part });
      }),
    );
    expect(faults.map((f) => f.plugin)).toEqual(["c"]);
    expect(registry.slot("home.tile").map((c) => `${c.plugin}:${c.key}`)).toEqual(["a:overview", "b:overview"]);
    expect(registry.slot("shell.status")).toBe(registry.slot("shell.status"));
  });

  test("a module that clashes only with a module that is left out anyway stays", async () => {
    const { faults, registry } = await load(
      source("a", (ctx) => {
        ctx.pages.add({ path: "/x", title: "A", component: Part });
        ctx.slots.register("rin.panel", { key: "p", component: Part });
      }),
      source("b", (ctx) => ctx.pages.add({ path: "/x", title: "B", component: Part })),
    );
    expect(faults.map((f) => [f.plugin, f.place])).toEqual([["a", "rin.panel"]]);
    expect(registry.plugins).toEqual(["b"]);
    expect(registry.pages.map((p) => p.title)).toEqual(["B"]);
  });

  test("a module whose holder goes for a reason of its own is judged again", async () => {
    const { faults, registry } = await load(
      source("z", (ctx) => ctx.pages.add({ path: "/c", title: "Z", component: Part })),
      source("a", (ctx) => {
        ctx.pages.add({ path: "/x", title: "A", component: Part });
        ctx.slots.register("c.panel" as "rin.panel", { key: "p", component: Part });
      }),
      source("b", (ctx) => ctx.pages.add({ path: "/x", title: "B", component: Part })),
      source("c", (ctx) => {
        ctx.slots.declare("c.panel" as "rin.panel", "list");
        ctx.pages.add({ path: "/c", title: "C", component: Part });
      }),
    );
    expect(faults.map((f) => f.plugin)).toEqual(["c", "a"]);
    expect(registry.plugins).toEqual(["z", "b"]);
  });

  test("a single slot takes one contribution; the later module is left out", async () => {
    const { faults, registry } = await load(
      source("a", (ctx) => ctx.slots.register("frame.header", { key: "a", component: Part })),
      source("b", (ctx) => ctx.slots.register("frame.header", { key: "b", component: Part })),
    );
    expect(faults).toEqual([
      { plugin: "b", phase: "register", place: "frame.header", message: "the single slot frame.header is already filled by a" },
    ]);
    expect(registry.slot("frame.header").map((c) => c.key)).toEqual(["a"]);
  });

  test("a list is ordered by `order`, then by load order; a keyed slot is looked up by key", async () => {
    const { registry } = await load(
      source("one", (ctx) => {
        ctx.slots.register("home.tile", { key: "late", component: Part, order: 10 });
        ctx.slots.register("home.tile", { key: "first", component: Part });
        ctx.slots.register("record.view", { key: "run.started", component: Part });
      }),
      source("two", (ctx) => ctx.slots.register("home.tile", { key: "early", component: Part, order: -1 })),
    );
    expect(registry.slot("home.tile").map((c) => c.key)).toEqual(["early", "first", "late"]);
    expect(registry.slotKind("record.view")).toBe("keyed");
    expect(registry.slot("record.view").find((c) => c.key === "run.started")?.plugin).toBe("one");
  });

  test("a module that lost only to modules left out later is let back in", async () => {
    const page = (ctx: PluginContext, path: string) => ctx.pages.add({ path, title: path, component: Part });
    const { faults, registry } = await load(
      source("a", (ctx) => {
        page(ctx, "/p");
        page(ctx, "/q");
        ctx.slots.register("b.s" as "rin.panel", { key: "k", component: Part });
      }),
      source("b", (ctx) => {
        ctx.slots.declare("b.s" as "rin.panel", "list");
        page(ctx, "/q");
      }),
      source("m", (ctx) => {
        page(ctx, "/p");
        page(ctx, "/h");
      }),
      source("h", (ctx) => {
        page(ctx, "/h");
        page(ctx, "/z");
      }),
      source("z", (ctx) => page(ctx, "/z")),
    );
    expect(registry.plugins).toEqual(["b", "m", "z"]);
    expect(faults.map((f) => f.plugin).sort()).toEqual(["a", "h"]);
  });

  test("a module that comes back may be what another one needed, whatever the order they are offered in", async () => {
    const page = (ctx: PluginContext, path: string) => ctx.pages.add({ path, title: path, component: Part });
    const { faults, registry } = await load(
      // Fills a slot of `z`, which is left out when `e` is first judged and let back in after it.
      source("e", (ctx) => ctx.slots.register("z.s" as "rin.panel", { key: "k", component: Part })),
      source("a", (ctx) => {
        page(ctx, "/p");
        page(ctx, "/q");
        ctx.slots.register("b.s" as "rin.panel", { key: "k", component: Part });
      }),
      source("b", (ctx) => {
        ctx.slots.declare("b.s" as "rin.panel", "list");
        page(ctx, "/q");
      }),
      source("m", (ctx) => {
        page(ctx, "/p");
        page(ctx, "/h");
      }),
      source("h", (ctx) => {
        page(ctx, "/h");
        page(ctx, "/z");
      }),
      source("z", (ctx) => {
        ctx.slots.declare("z.s" as "rin.panel", "list");
        page(ctx, "/z");
      }),
    );
    expect(registry.plugins).toEqual(["e", "b", "m", "z"]);
    expect(faults.map((f) => f.plugin).sort()).toEqual(["a", "h"]);
    // The reasons are the ones against the modules that stayed.
    expect(faults.map((f) => [f.plugin, f.message]).sort()).toEqual([
      ["a", "the path /p is already taken by m"],
      ["h", "the path /h is already taken by m"],
    ]);
  });

  test("dropping a module that owns a slot drops what others put into it", async () => {
    const { faults, registry } = await load(
      source("pages", (ctx) => ctx.pages.add({ path: "/rin", title: "Taken", component: Part })),
      source("digest", (ctx) => ctx.slots.register("rin.panel", { key: "digest", component: Part })),
      source("rin", (ctx) => {
        ctx.slots.declare("rin.panel", "list");
        ctx.pages.add({ path: "/rin", title: "Rin", component: Part });
      }),
    );
    expect(faults.map((f) => [f.plugin, f.place])).toEqual([
      ["rin", "/rin"],
      ["digest", "rin.panel"],
    ]);
    expect(registry.plugins).toEqual(["pages"]);
  });
});

describe("pages and entities", () => {
  test("a path whose shape is taken leaves the later module out; nav is ordered", async () => {
    const { faults, registry } = await load(
      source("runs", (ctx) => {
        ctx.pages.add({ path: "/runs", title: "Runs", component: Part, nav: { order: 20 } });
        ctx.pages.add({ path: "/runs/$runId", title: "Run", component: Part });
      }),
      source("other", (ctx) => ctx.pages.add({ path: "/runs/$id", title: "Also a run", component: Part })),
      source("home", (ctx) => ctx.pages.add({ path: "/", title: "Home", component: Part, nav: { label: "Start", order: 0 } })),
    );
    expect(faults.map((f) => [f.plugin, f.place])).toEqual([["other", "/runs/$id"]]);
    expect(registry.nav.map((n) => [n.label, n.path])).toEqual([
      ["Start", "/"],
      ["Runs", "/runs"],
    ]);
  });

  test("ids resolve to kinds by prefix; references link without one", async () => {
    const { registry, faults } = await load(
      source("runs", (ctx) => ctx.entities.register("run", { label: "Run", prefix: "run", href: (id) => `/runs/${id}` })),
      source("forge", (ctx) =>
        ctx.entities.register("pr", { label: "Pull request", href: (id) => `/prs/${encodeURIComponent(id)}` }),
      ),
      source("clash", (ctx) => ctx.entities.register("runner", { label: "Runner", prefix: "run", href: () => "/" })),
    );
    expect(faults.map((f) => [f.plugin, f.message])).toEqual([["clash", "the id prefix run already belongs to the entity kind run"]]);
    expect(registry.entities.resolve("run-1f3a9c")).toEqual({ kind: "run", id: "run-1f3a9c" });
    expect(registry.entities.resolve("task-1")).toBeUndefined();
    expect(registry.entities.href("run-1f3a9c")).toBe("/runs/run-1f3a9c");
    expect(registry.entities.href({ kind: "pr", id: "owner/repo#12" })).toBe("/prs/owner%2Frepo%2312");
    // Each kind declares the slot of tabs on its pages.
    expect(registry.slotKind("entity.run.tab")).toBe("list");
  });
});
