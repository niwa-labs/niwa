import { expect, test } from "bun:test";

import { checklistProgress, shapeOf } from "@niwa-labs/harness";
import type { ToolTable } from "@niwa-labs/harness";

const TABLE: ToolTable = {
  run: { category: "shell", target: ["cmd", "command"] },
  open: { category: "read", target: ["path"] },
};

test("a tool the table names gets its category and the first target its input has", () => {
  expect(shapeOf(TABLE, "run", { command: "make\n  all" })).toEqual({ category: "shell", target: "make all" });
  expect(shapeOf(TABLE, "run", { cmd: ["git", "status"] })).toEqual({ category: "shell", target: "git status" });
  expect(shapeOf(TABLE, "open", { other: 1 })).toEqual({ category: "read" });
});

test("a tool the table does not name is mcp only when the kind says so, else other", () => {
  expect(shapeOf(TABLE, "mcp__srv__x", {})).toEqual({ category: "mcp" });
  expect(shapeOf(TABLE, "mcp__srv__x", {}, () => false)).toEqual({ category: "other" });
  // A name inherited by every object is not a tool of the table.
  expect(shapeOf(TABLE, "toString", {})).toEqual({ category: "other" });
});

test("the progress of a checklist counts the items that are done", () => {
  expect(
    checklistProgress({
      items: [
        { text: "a", state: "done" },
        { text: "b", state: "active" },
        { text: "c", state: "pending" },
      ],
    }),
  ).toEqual({ done: 1, total: 3 });
});
