// The package entry: the authoring functions, the offer points, and the caller binding.

import { expect, test } from "bun:test";

import { BUILTIN_WORKFLOW, TIMER_OFFER, bindingOf, offerKey, plugin, pluginName, pluginVersion, withoutHandler } from "../src/index.ts";

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

test("removing handlers one after another never meets removing one handler of a longer name", () => {
  const source = plugin("two-steps", () => undefined, { version: "1" });
  const stepwise = withoutHandler(withoutHandler(source, "a"), "b");
  const single = withoutHandler(source, "a-without-b");
  expect(stepwise.version).not.toBe(single.version);
  expect(withoutHandler(withoutHandler(source, "b"), "a").version).not.toBe(stepwise.version);
  expect(withoutHandler(source, "a").version).not.toBe(source.version);
});

test("the version of a plugin without handlers does not grow with the removals", () => {
  const source = plugin("many-steps", () => undefined, { version: "1" });
  let stepwise = source;
  for (let index = 0; index < 18; index += 1) stepwise = withoutHandler(stepwise, `h${String(index)}`);
  expect(stepwise.version.length).toBeLessThan(64);
  expect(stepwise.version).not.toBe(withoutHandler(source, "h0").version);
});
