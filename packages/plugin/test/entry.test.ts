// The package entry: the authoring functions, the offer points, and the caller binding.

import { expect, test } from "bun:test";

import { BUILTIN_WORKFLOW, TIMER_OFFER, bindingOf, offerKey, pluginName, pluginVersion } from "../src/index.ts";

test("plugin names are lowercase words joined by dashes and grouped by a slash", () => {
  expect(pluginName("night-digest")).toBe("night-digest");
  expect(pluginName("rin/memory")).toBe("rin/memory");
  expect(() => pluginName("Night")).toThrow();
  expect(() => pluginName("a//b")).toThrow();
});

test("a plugin version is a non-empty string", () => {
  expect(pluginVersion("r3")).toBe("r3");
  expect(() => pluginVersion("")).toThrow();
});

test("an offer key names its point and the plugin that reads it", () => {
  expect(offerKey("x.y", "reader")).toEqual({ kind: "offer", name: "x.y", reader: "reader" });
  expect(() => offerKey("", "reader")).toThrow();
  expect(BUILTIN_WORKFLOW.reader).toBe("workflow");
  expect(TIMER_OFFER.reader).toBe("timers");
});

test("the default binding makes a client speak as itself and the owner as the owner", () => {
  const bind = bindingOf();
  expect(bind({ kind: "host" } as never)).toBeUndefined();
  expect(bind({ kind: "client", id: "c1" } as never)).toEqual({ kind: "client", id: "c1" });
  expect(bind({ kind: "client", id: "c1", principal: { kind: "owner" } } as never)).toEqual({ kind: "owner" });
  const custom = () => undefined;
  expect(bindingOf({ bind: custom })).toBe(custom);
});
