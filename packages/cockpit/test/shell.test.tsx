// The cockpit drawn: what the frame shows of the modules, and what it does when starting fails.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { bootCockpit, CockpitApp, type BootOptions, type Cockpit } from "../src/boot.tsx";
import { fetching, json, module, seen, type Seen } from "./support.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:4000/", settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

const opened: Array<{ cockpit: Cockpit; root: Root; container: Element }> = [];
afterEach(async () => {
  for (const { cockpit, root, container } of opened.splice(0)) {
    await act(async () => root.unmount());
    cockpit.stop();
    container.remove();
  }
});

type Plugins = Record<string, ReturnType<typeof definePlugin>>;

function stubs(plugins: Plugins, saw: Seen, entries: ReturnType<typeof module>[] = Object.keys(plugins).map((id) => module(id))) {
  return {
    fetch: fetching(
      {
        "/api/viewer": json({ id: "web", owner: true, actions: [] }),
        "/api/info": json({ actions: [], seq: 10 }),
        "/api/catalogue": json({ modules: entries }),
      },
      saw,
    ),
    importModule: async (url: string) => {
      const found = plugins[url.split("/")[2] ?? ""];
      if (found === undefined) throw new Error("cannot be imported");
      return { default: found };
    },
  } satisfies BootOptions;
}

/** Start the cockpit and draw it at an address. */
async function open(at: string, options: BootOptions): Promise<{ cockpit: Cockpit; container: Element }> {
  const cockpit = await bootCockpit({ history: createMemoryHistory({ initialEntries: [at] }), ...options });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  opened.push({ cockpit, root, container });
  await act(async () => {
    root.render(<CockpitApp cockpit={cockpit} />);
    await cockpit.router.load();
  });
  return { cockpit, container };
}

function Fine() {
  return <p>a page</p>;
}

test("the icon of a page is drawn beside its label in the navigation, and an icon that throws does not take the navigation down", async () => {
  const saw = seen();
  const plugins: Plugins = {
    alpha: definePlugin({
      id: "alpha",
      setup: (ctx) =>
        ctx.pages.add({ path: "/alpha", title: "Alpha", nav: { order: 1, icon: (props) => <svg data-icon="alpha" className={props.className} /> }, component: Fine }),
    }),
    beta: definePlugin({
      id: "beta",
      setup: (ctx) =>
        ctx.pages.add({
          path: "/beta",
          title: "Beta",
          nav: {
            order: 2,
            icon: () => {
              throw new Error("icon exploded");
            },
          },
          component: Fine,
        }),
    }),
  };
  const { cockpit, container } = await open("/", stubs(plugins, saw));
  const nav = container.querySelector("nav")!;
  const links = [...nav.querySelectorAll("a")].map((link) => link.textContent);
  expect(links).toEqual(["Home", "Alpha", "Beta"]);
  const alpha = nav.querySelector('a[href="/alpha"]')!;
  expect(alpha.querySelector('svg[data-icon="alpha"]')).not.toBeNull();
  // The failed icon is a fault of its module, the label stays a link.
  expect(nav.querySelector('a[href="/beta"]')?.textContent).toBe("Beta");
  expect(cockpit.faults.snapshot().map((fault) => [fault.plugin, fault.phase, fault.place])).toEqual([["beta", "render", "nav.icon"]]);
});

function stylesOf(document: Document): string[] {
  return [...document.querySelectorAll("link[rel=stylesheet]")].map((link) => link.getAttribute("href") ?? "");
}

test("only the modules that were accepted put a stylesheet on the page, in catalogue order", async () => {
  const saw = seen();
  const plugins: Plugins = {
    alpha: definePlugin({ id: "alpha", setup: (ctx) => ctx.pages.add({ path: "/alpha", title: "Alpha", component: Fine }) }),
    broken: definePlugin({
      id: "broken",
      setup: () => {
        throw new Error("setup failed");
      },
    }),
    beta: definePlugin({ id: "beta", setup: (ctx) => ctx.pages.add({ path: "/beta", title: "Beta", component: Fine }) }),
  };
  const entries = [
    module("alpha", undefined, ["/modules/alpha/a/style-0-aaa.css"]),
    module("broken", undefined, ["/modules/broken/a/style-0-bbb.css"]),
    module("beta", undefined, ["/modules/beta/a/style-0-ccc.css", "/modules/beta/a/style-1-ddd.css"]),
  ];
  const page = document.implementation.createHTMLDocument("niwa");
  await open("/", { ...stubs(plugins, saw, entries), document: page });
  expect(stylesOf(page)).toEqual(["/modules/alpha/a/style-0-aaa.css", "/modules/beta/a/style-0-ccc.css", "/modules/beta/a/style-1-ddd.css"]);
});

test("a start that fails after the record feed was opened closes the feed", async () => {
  const saw = seen();
  const plugins: Plugins = {
    alpha: definePlugin({ id: "alpha", setup: (ctx) => ctx.pages.add({ path: "/alpha", title: "Alpha", component: Fine }) }),
  };
  const page = document.implementation.createHTMLDocument("niwa");
  page.head.append = () => {
    throw new Error("the page cannot take a stylesheet");
  };
  await expect(bootCockpit({ ...stubs(plugins, saw, [module("alpha", undefined, ["/modules/alpha/a/style-0-aaa.css"])]), document: page })).rejects.toThrow(
    "the page cannot take a stylesheet",
  );
  expect(saw.feedsOpened).toBe(1);
  // The feed is closed by aborting its request: give the abort a turn to reach the stub.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saw.feedsClosed).toBe(1);
});

test("a module that asks for the home page is reported, and the cockpit still opens with the home page and the other pages", async () => {
  const saw = seen();
  const plugins: Plugins = {
    greedy: definePlugin({ id: "greedy", setup: (ctx) => ctx.pages.add({ path: "/", title: "Mine", component: () => <p>greedy</p> }) }),
    fine: definePlugin({ id: "fine", setup: (ctx) => ctx.pages.add({ path: "/fine", title: "Fine", nav: {}, component: Fine }) }),
  };
  const home = await open("/", stubs(plugins, saw));
  expect(home.container.querySelector('[data-slot="home"]')).not.toBeNull();
  expect([...home.container.querySelectorAll("p")].map((p) => p.textContent)).not.toContain("greedy");
  expect(home.cockpit.faults.snapshot().map((fault) => [fault.plugin, fault.phase, fault.place])).toEqual([["greedy", "register", "/"]]);
  const page = await open("/fine", stubs(plugins, saw));
  expect(page.container.textContent).toContain("a page");
});
