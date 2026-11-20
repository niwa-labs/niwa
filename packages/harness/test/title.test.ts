// A readable title of a session made from a message: the machine-made tags cut out, whitespace
// collapsed, cut to about 60 characters at a word; and the first message that gives one.

import { expect, test } from "bun:test";

import { TITLE_LENGTH, firstMessageTitle, titleFromText } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";

test("a title is the text without machine tags, collapsed, and cut at a word", () => {
  expect(titleFromText("  fix   the\nbuild ")).toBe("fix the build");
  expect(titleFromText("<system-reminder>\nbe brief\n</system-reminder>\nfix the build")).toBe("fix the build");
  expect(titleFromText("<command-name>/clear</command-name>")).toBeUndefined();
  expect(titleFromText("   ")).toBeUndefined();
  const long = titleFromText("word ".repeat(40));
  expect(long?.endsWith("…")).toBe(true);
  expect((long?.length ?? 0) <= TITLE_LENGTH + 1).toBe(true);
  expect(long).not.toContain("wor…");
});

test("the first message that gives a title is taken, and a skipped one is passed over", async () => {
  const records = async function* (): AsyncIterable<SessionRecord> {
    const base = { incomplete: false };
    yield { kind: "assistant", text: "hi", locator: "l0", ...base } as SessionRecord;
    yield { kind: "user", text: "<environment_context>x</environment_context>", locator: "l1", ...base } as SessionRecord;
    yield { kind: "user", text: "# preamble of the harness", locator: "l2", ...base } as SessionRecord;
    yield { kind: "user", text: "ship it", locator: "l3", ...base } as SessionRecord;
  };
  expect(await firstMessageTitle(records(), (text) => text.startsWith("# preamble"))).toBe("ship it");
  expect(await firstMessageTitle(records())).toBe("# preamble of the harness");
});
