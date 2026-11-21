import { describe, expect, test } from "bun:test";

import { formatDuration, formatPayload, idPrefix, isPlainClick, isSettled, shortId } from "../src/index.ts";

describe("ids", () => {
  test("the prefix is the lowercase word before the first dash", () => {
    expect(idPrefix("run-1f3a9c")).toBe("run");
    expect(idPrefix("s-0a1b2c")).toBe("s");
    expect(idPrefix("owner/repo#12")).toBeUndefined();
    expect(idPrefix("-abc")).toBeUndefined();
  });

  test("a short id keeps the prefix and the tail", () => {
    expect(shortId("run-1f3a9c")).toBe("run-1f3a9c");
    expect(shortId("task-0123456789abcdef")).toBe("task-…89abcdef");
    expect(shortId("0123456789abcdefgh", 4)).toBe("…efgh");
  });

  test("only a plain left click is the app's to handle", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(isPlainClick(base)).toBe(true);
    expect(isPlainClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainClick({ ...base, defaultPrevented: true })).toBe(false);
  });
});

describe("formatting", () => {
  test("payloads: strings as they are, values as JSON, nothing for undefined", () => {
    expect(formatPayload("ls -la")).toBe("ls -la");
    expect(formatPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatPayload(undefined)).toBe("");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatPayload(cyclic)).toBe("[object Object]");
  });

  test("durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
    expect(formatDuration(-1)).toBe("");
  });

  test("settled states", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("reused")).toBe(true);
    expect(isSettled("running")).toBe(false);
    expect(isSettled("waiting")).toBe(false);
  });
});
