/** The hook script of the Claude Code insert: what it reports, and under whose name. */

import { expect, test } from "bun:test";

import { hooksJson } from "../../src/code/insert/install.ts";
import { reportOf } from "../../src/code/insert/hook.ts";
import { INSERT_HARNESS_ENV } from "../../src/code/insert/constants.ts";
import { nativeIdOfSubagent } from "../../src/code/paths.ts";

const SPAWN = { hook_event_name: "SubagentStart", session_id: "parent-1", agent_id: "abc", agent_type: "Explore" };

test("a subagent the hook links is named the way the reading side names its log", () => {
  expect(reportOf(SPAWN, {})).toEqual({
    kind: "nested-spawned",
    parent: { harness: "claude-code", native: "parent-1" },
    child: { harness: "claude-code", native: nativeIdOfSubagent("abc") },
    role: "Explore",
  });
});

test("the sessions a hook reports belong to the instance the plugin was installed for", () => {
  const env = { [INSERT_HARNESS_ENV]: "claude-work" };
  expect(reportOf(SPAWN, env)).toMatchObject({
    parent: { harness: "claude-work" },
    child: { harness: "claude-work", native: "subagent-abc" },
  });
  expect(reportOf({ hook_event_name: "PreCompact", session_id: "s1" }, env)).toEqual({
    kind: "compacted",
    session: { harness: "claude-work", native: "s1" },
  });
});

test("the hooks file names the instance in the command, and leaves it out when none is given", () => {
  expect(hooksJson("bun", "/home", undefined, "claude-work")).toContain(`${INSERT_HARNESS_ENV}='claude-work'`);
  expect(hooksJson("bun", "/home")).not.toContain(INSERT_HARNESS_ENV);
});
