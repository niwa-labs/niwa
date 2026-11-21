// Rendering modules into the frame: a part that throws is contained and reported.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  CockpitProvider,
  createRecordStream,
  createViewer,
  definePlugin,
  EntityLink,
  loadPlugins,
  PageView,
  Slot,
  type CockpitRuntime,
  type PluginFault,
} from "../src/index.ts";
import { scriptedClient } from "./fixtures.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

let explode = true;

function Fine() {
  return <p>fine tile</p>;
}

function Broken(): never | null {
  if (explode) throw new Error("tile exploded");
  return null;
}

async function runtime(): Promise<{ runtime: CockpitRuntime; faults: PluginFault[]; visited: string[] }> {
  const { client } = scriptedClient();
  const services = { viewer: createViewer({ id: "web", owner: true, actions: [] }), host: client, records: createRecordStream(client) };
  const { registry } = await loadPlugins(
    [
      {
        id: "first",
        load: async () => ({
          default: definePlugin({
            id: "first",
            setup: (ctx) => {
              ctx.slots.register("home.tile", { key: "fine", component: Fine });
              ctx.entities.register("run", { label: "Run", prefix: "run", href: (id) => `/runs/${id}` });
            },
          }),
        }),
      },
      { id: "second", load: async () => ({ default: definePlugin({ id: "second", setup: (ctx) => ctx.slots.register("home.tile", { key: "broken", component: Broken }) }) }) },
    ],
    services,
  );
  const faults: PluginFault[] = [];
  const visited: string[] = [];
  return {
    runtime: { ...services, registry, navigator: { navigate: (to) => void visited.push(to) }, reportFault: (f) => void faults.push(f) },
    faults,
    visited,
  };
}

describe("rendering modules", () => {
  test("a throwing part becomes a notice in its place and a fault; the rest renders", async () => {
    explode = true;
    const { runtime: rt, faults } = await runtime();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const original = console.error;
    console.error = () => {};
    try {
      await act(async () =>
        root.render(
          <CockpitProvider runtime={rt}>
            <Slot name="home.tile" />
          </CockpitProvider>,
        ),
      );
    } finally {
      console.error = original;
    }
    expect(host.textContent).toContain("fine tile");
    const notice = host.querySelector('[data-slot="plugin-fault"]');
    expect(notice?.getAttribute("data-plugin")).toBe("second");
    expect(notice?.textContent).toContain("tile exploded");
    expect(faults.map((f) => [f.plugin, f.phase, f.place, f.message])).toEqual([["second", "render", "home.tile", "tile exploded"]]);

    // Retry renders the part again.
    explode = false;
    await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="plugin-fault"] button')!.click());
    expect(host.querySelector('[data-slot="plugin-fault"]')).toBeNull();
    await act(async () => root.unmount());
  });

  test("a page that failed for one address renders afresh for the next", async () => {
    const { runtime: rt } = await runtime();
    const RunPage = ({ params }: { params: Record<string, string> }) => {
      if (params.runId === "run-bad") throw new Error("no such run");
      return <p>run {params.runId}</p>;
    };
    const page = { plugin: "first", path: "/runs/$runId", title: "Run", component: RunPage, nav: undefined };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (runId: string) =>
      act(async () =>
        root.render(
          <CockpitProvider runtime={rt}>
            <PageView page={page} params={{ runId }} search={{}} />
          </CockpitProvider>,
        ),
      );
    const original = console.error;
    console.error = () => {};
    try {
      await show("run-bad");
    } finally {
      console.error = original;
    }
    expect(host.textContent).toContain("no such run");
    await show("run-good");
    expect(host.textContent).toContain("run run-good");
    await act(async () => root.unmount());
  });

  test("an entity link navigates inside the cockpit on a plain click", async () => {
    const { runtime: rt, visited } = await runtime();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <CockpitProvider runtime={rt}>
          <EntityLink entity="run-1f3a9c" />
          <EntityLink entity="task-77aa00" />
        </CockpitProvider>,
      ),
    );
    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("/runs/run-1f3a9c");
    await act(async () => links[0]!.click());
    expect(visited).toEqual(["/runs/run-1f3a9c"]);
    expect(host.textContent).toContain("task-77aa00");
    await act(async () => root.unmount());
  });
});
