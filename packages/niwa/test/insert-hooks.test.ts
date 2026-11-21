// Insert.
// "A nested session spawned by the harness is linked to its parent. A session the owner opens by
// hand is registered at once with its exact id."
//
// The hook scripts are run directly, with the JSON Claude Code would send them on stdin, against a
// real host that has the insert's plugin installed:
//
//   1. the hook script of a session that was opened by hand is run: the session is registered at
//      once, with its exact id
//   2. the hook script of a subagent is run: the child is linked to the session it was spawned in
//   3. the hook script of a compaction is run: the compaction is recorded
//   4. the hook script of a permission question is run: the question is recorded
//   5. a session niwa started is not reported as opened by hand: niwa knows that one
//
// The script is the one the plugin's hooks file runs (installClaudeCodeInsert writes the file, the
// script stays where it is): it is run exactly as Claude Code runs it. It reports by running
// `niwa insert report`, so the tests give it a `niwa` that runs bin/niwa.ts (NIWA_CLI).

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { hookPath, hooksJson, installClaudeCodeInsert } from "@niwa-labs/harness-claude";
import { niwaCli } from "./fixtures/niwa-cli.ts";

const HOST_SCRIPT = new URL("./fixtures/insert-host.ts", import.meta.url).pathname;

/** Run one hook script with the event on stdin, the way Claude Code runs it. */
async function runHook(
  script: string,
  event: unknown,
  home: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NIWA_HOME: home, ...env },
  });
  child.stdin.write(JSON.stringify(event));
  child.stdin.end();
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test("insert: a nested session is linked to its parent, and a session opened by hand is registered with its exact id", async () => {
  const home = await tempHome();
  const host = spawnHost(HOST_SCRIPT, home.path);

  try {
    await host.ready();

    // The plugin is installed into a directory of its own, and the hooks file it carries runs the
    // hook script.
    const cli = await niwaCli(home.path);
    const pluginDir = await installClaudeCodeInsert(home.path, { home: home.path, cli });
    expect(await readFile(join(pluginDir, "hooks", "hooks.json"), "utf8")).toContain(hookPath());
    const hookScript = hookPath();
    expect(await Bun.file(hookScript).exists()).toBe(true);
    const run = (script: string, event: unknown, at: string, env: Record<string, string> = {}) =>
      runHook(script, event, at, { NIWA_CLI: cli, ...env });

    // The records the insert writes, as the journal holds them.
    const observer = await connectAsOwner(home.path);
    const seen: StoredRecord[] = [];
    const watching = (async () => {
      for await (const record of observer.records.since(seq(0))) seen.push(record);
    })().catch(() => {});

    // The owner opened a session by hand: it is registered at once, with its exact id.
    const opened = await run(
      hookScript,
      {
        session_id: "hand-opened-abc",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp/work",
        hook_event_name: "SessionStart",
        source: "startup",
      },
      home.path,
    );
    expect(opened.code).toBe(0);

    await waitFor(
      () => seen.some((record) => record.type === "insert.opened-by-hand"),
      "the session opened by hand is registered",
    );
    const started = seen.find((record) => record.type === "insert.opened-by-hand");
    expect(started?.data).toEqual({
      session: { harness: "claude-code", native: "hand-opened-abc" },
      cwd: "/tmp/work",
    });

    // A subagent is spawned: the child is linked to the session it was spawned in.
    const spawned = await run(
      hookScript,
      {
        session_id: "hand-opened-abc",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp/work",
        hook_event_name: "SubagentStart",
        agent_id: "child-agent-xyz",
        agent_type: "Explore",
      },
      home.path,
    );
    expect(spawned.code).toBe(0);

    await waitFor(
      () => seen.some((record) => record.type === "insert.nested-spawned"),
      "the nested session is linked",
    );
    const nested = seen.find((record) => record.type === "insert.nested-spawned");
    expect(nested?.data).toEqual({
      parent: { harness: "claude-code", native: "hand-opened-abc" },
      child: { harness: "claude-code", native: "child-agent-xyz" },
      role: "Explore",
    });

    // The harness compacted the context.
    const compacted = await run(
      hookScript,
      {
        session_id: "hand-opened-abc",
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: null,
      },
      home.path,
    );
    expect(compacted.code).toBe(0);
    await waitFor(
      () => seen.some((record) => record.type === "insert.compacted"),
      "the compaction is recorded",
    );

    // A tool asks for permission.
    const permission = await run(
      hookScript,
      {
        session_id: "hand-opened-abc",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "rm -rf build" },
      },
      home.path,
    );
    expect(permission.code).toBe(0);
    await waitFor(
      () => seen.some((record) => record.type === "insert.permission-asked"),
      "the permission question is recorded",
    );
    const asked = seen.find((record) => record.type === "insert.permission-asked");
    expect(asked?.data).toEqual({
      session: { harness: "claude-code", native: "hand-opened-abc" },
      requestId: "tool-1",
      tool: "Bash",
      detail: "rm -rf build",
    });

    // A resumed session is continued, not opened by hand; a payload without a session id is no
    // report. Neither writes anything.
    const quiet = seen.length;
    for (const event of [
      { session_id: "resumed-1", hook_event_name: "SessionStart", source: "resume" },
      { hook_event_name: "SessionStart", source: "startup" },
    ]) {
      expect((await run(hookScript, event, home.path)).code).toBe(0);
    }

    // A session niwa started carries the marker: it is not opened by hand, and nothing is
    // reported for it.
    const before = seen.length;
    expect(before).toBe(quiet);
    const own = await run(
      hookScript,
      {
        session_id: "niwa-started-session",
        cwd: "/tmp/work",
        hook_event_name: "SessionStart",
        source: "startup",
      },
      home.path,
      { NIWA_SESSION: "1" },
    );
    expect(own.code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.length).toBe(before);

    await observer.close();
    await watching.catch(() => {});
  } finally {
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

/** Wait until a condition holds; the message says what was waited for. */
async function waitFor(fn: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("insert: a hook never fails the harness, whatever is wrong", async () => {
  const home = await tempHome();
  try {
    const cli = await niwaCli(home.path);
    const hookScript = hookPath();
    const event = { session_id: "s1", hook_event_name: "SessionStart", source: "startup" };

    // No host is running at this home: the command fails, the hook does not.
    const down = await runHook(hookScript, event, home.path, { NIWA_CLI: cli });
    expect(down.code).toBe(0);
    expect(down.stderr).toContain("could not report opened-by-hand");
    // The input is not JSON.
    expect((await runHook(hookScript, "not json{", home.path, { NIWA_CLI: cli })).code).toBe(0);
    // The home is not set.
    expect((await runHook(hookScript, event, "", { NIWA_CLI: cli })).code).toBe(0);
    // There is no niwa to run.
    const missing = await runHook(hookScript, event, home.path, { NIWA_CLI: join(home.path, "no-such-niwa") });
    expect(missing.code).toBe(0);
    expect(missing.stderr).toContain("could not run");
  } finally {
    await home.cleanup();
  }
}, 30_000);

test("insert: the plugin runs the hook where it is, and the hook is no client of the host", async () => {
  const home = await tempHome();
  try {
    const pluginDir = await installClaudeCodeInsert(home.path, { home: home.path, cli: "/opt/niwa/bin/niwa" });
    expect(await readFile(join(pluginDir, "hooks", "hooks.json"), "utf8")).toBe(
      hooksJson("bun", home.path, "/opt/niwa/bin/niwa"),
    );
    // Nothing is copied into the plugin, so nothing is rewritten and nothing follows a path in a copy.
    expect(await Bun.file(join(pluginDir, "hooks", "hook.ts")).exists()).toBe(false);
    expect(await readFile(hookPath(), "utf8")).not.toMatch(/core\/(client|index)/);
  } finally {
    await home.cleanup();
  }
});
