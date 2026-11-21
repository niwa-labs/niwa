// Tabs in a document: orientation reaches the primitive, and a className function is honoured.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { cnWith, Tabs, TabsContent, TabsList, TabsTrigger } from "../src/index.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root };
}

describe("tabs", () => {
  test("a vertical set is vertical for the list and the tabs", async () => {
    const { host, root } = await mount(
      <Tabs orientation="vertical" defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">first</TabsContent>
        <TabsContent value="b">second</TabsContent>
      </Tabs>,
    );
    expect(host.querySelector('[data-slot="tabs"]')?.getAttribute("data-orientation")).toBe("vertical");
    const list = host.querySelector<HTMLElement>('[data-slot="tabs-list"]')!;
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(list.getAttribute("data-orientation")).toBe("vertical");
    // The tabs follow the root: arrow keys move along the vertical axis, and the styles bind to it.
    for (const tab of host.querySelectorAll('[data-slot="tabs-trigger"]')) {
      expect(tab.getAttribute("data-orientation")).toBe("vertical");
    }
    await act(async () => root.unmount());
  });

  test("a className function receives the state and is merged with the base classes", async () => {
    const seen: (string | undefined)[] = [];
    const { host, root } = await mount(
      <Tabs
        defaultValue="a"
        className={(state) => {
          seen.push(state.orientation);
          return "extra";
        }}
      >
        <TabsList className={() => "list-extra"}>
          <TabsTrigger value="a" className={(state) => (state.active ? "tab-active" : "tab-idle")}>
            A
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(seen).toContain("horizontal");
    const rootClass = host.querySelector('[data-slot="tabs"]')?.className ?? "";
    expect(rootClass).toContain("extra");
    expect(rootClass).toContain("group/tabs");
    expect(host.querySelector('[data-slot="tabs-list"]')?.className).toContain("list-extra");
    expect(host.querySelector('[data-slot="tabs-trigger"]')?.className).toContain("tab-active");
    await act(async () => root.unmount());
  });
});

describe("cnWith", () => {
  test("a string merges at once, a function when it gets its state", () => {
    expect(cnWith("p-2", "p-4")).toBe("p-4");
    const merged = cnWith<{ n: number }>("p-2", (state) => `p-${String(state.n)}`);
    expect(typeof merged).toBe("function");
    expect(typeof merged === "function" ? merged({ n: 6 }) : "").toBe("p-6");
    expect(cnWith("p-2", undefined)).toBe("p-2");
  });
});
