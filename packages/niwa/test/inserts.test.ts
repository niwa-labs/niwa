// An insert inside a harness reports through the bin of this package, so it works on a machine
// where `niwa` is not on the PATH: what is installed records the absolute path of the bin.

import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { statSync } from "node:fs";

import { seq } from "@niwa-labs/core";
import { harnessId } from "@niwa-labs/harness";
import { claudeCode } from "@niwa-labs/harness-claude";
import { PiInsert, piSession } from "@niwa-labs/harness-pi";
import { createNiwa } from "@niwa-labs/host";
import { insertPlugin } from "@niwa-labs/sessions";
import { tempDir, tempHome } from "@niwa-labs/testing";

import { NIWA_CLI, cliReporter, insertEnv, installInsert } from "../src/inserts.ts";

const pathWas = process.env.PATH;
afterEach(() => {
  if (pathWas === undefined) delete process.env.PATH;
  else process.env.PATH = pathWas;
});

/** A PATH that holds the bun that runs the tests and the system tools, and no `niwa`. */
async function pathWithoutNiwa(): Promise<string> {
  const dir = await tempDir("no-niwa-path");
  await symlink(process.execPath, join(dir, "bun"));
  const path = `${dir}:/usr/bin:/bin`;
  expect(Bun.which("niwa", { PATH: path })).toBeNull();
  return path;
}

test("the program the inserts report through is the bin of this package, by absolute path, and it runs on its own", async () => {
  expect(NIWA_CLI.startsWith("/")).toBe(true);
  expect(NIWA_CLI.endsWith("/bin/niwa.ts")).toBe(true);
  expect(statSync(NIWA_CLI).mode & 0o111).not.toBe(0);

  const run = Bun.spawn([NIWA_CLI, "skill"], {
    cwd: await tempDir("elsewhere"),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: await pathWithoutNiwa(), HOME: await tempDir("home") },
  });
  expect(await run.exited).toBe(0);
  expect(await new Response(run.stdout).text()).toContain("niwa");
});

test("the environment of an insert names the host and the program to report through", () => {
  expect(insertEnv("/tmp/niwa-home")).toEqual({ NIWA_HOME: "/tmp/niwa-home", NIWA_CLI });
});

test("a Claude Code hook installed here reports to the host with no niwa on the PATH", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(insertPlugin());
  await niwa.serve();
  const claudeHome = await tempDir("claude-home");

  try {
    await installInsert(claudeCode({ id: harnessId("claude-code"), home: claudeHome }), home.path);
    const hooks = JSON.parse(await readFile(join(claudeHome, "plugins", "niwa-insert", "hooks", "hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = hooks.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(command).toContain(`NIWA_CLI='${NIWA_CLI}'`);

    // The hook is run the way Claude Code runs it, with a PATH that has no `niwa` and no NIWA_CLI of its own.
    const hook = Bun.spawn(["sh", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: await pathWithoutNiwa(), HOME: await tempDir("hook-home") },
    });
    hook.stdin.write(
      JSON.stringify({
        session_id: "hand-opened-abc",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp/work",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    hook.stdin.end();
    const [code, stderr] = await Promise.all([hook.exited, new Response(hook.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    const written = (await niwa.records.read()).filter((record) => record.type === "insert.opened-by-hand");
    expect(written.map((record) => record.data)).toEqual([
      { session: { harness: "claude-code", native: "hand-opened-abc" }, cwd: "/tmp/work" },
    ]);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("a pi insert given the reporter of this package reports to the host with no niwa on the PATH", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(insertPlugin());
  await niwa.serve();

  try {
    process.env.PATH = await pathWithoutNiwa();
    const insert = new PiInsert({ report: cliReporter(home.path) });
    await insert.onSessionStart({ reason: "startup" }, { id: "sess-1", cwd: "/tmp/work" });

    const written = (await niwa.records.read()).filter((record) => record.type === "insert.opened-by-hand");
    expect(written.map((record) => record.data)).toMatchObject([{ session: piSession("sess-1"), cwd: "/tmp/work" }]);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
