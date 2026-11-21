// proc.run in the real sandboxes.
//
// Runs the real srt and nono, so it is behind `live`, and each part is skipped on a machine where
// that sandbox is not available.
//
// What it proves, for nono:
//   1. a run writes in its cwd and cannot write outside it
//   2. a run reaches no network
//   3. a run cannot read the owner token of the host, though the host's home holds it
//   4. a run cannot write a shared temp area, and the temp files of a command that follows TMPDIR still work
//   5. the box a run names carries nono's policy: its cwd to write, and neither a temp area nor the home to read
//   6. a run's HOME is the user's own, which it cannot write, and a program on the PATH under the user's
//      home runs from the toolchains, and not when the call replaces them
// and for srt, whose reads are open: a run cannot read the places of an installation it did not take.

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { nono, sandbox as sandboxHost, srt } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { procRun } from "../src/index.ts";
import { dirIn, outputOf, procHost } from "./support.ts";

for (const sandbox of [nono()]) {
  const present = live && (await sandbox.available());
  describe(`proc.run in ${sandbox.name}`, () => {
    test.skipIf(!present)("writes in its cwd, not outside it, and reaches no network", async () => {
      // A home under the user's home, as the host's is.
      const host = await procHost({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "niwa-proc-out-")));
      try {
        const cwd = realpathSync(dirIn(host.home, "work"));
        const inside = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", "echo x > in.txt"], cwd, timeout: 20_000 });
        expect(inside.exit).toBe(0);
        // The box it names carries the policy nono applies: its own directory to write, and no temp area or home to read.
        expect(inside.box.policy.write).toContain(cwd);
        const read = "only" in inside.box.policy.read ? inside.box.policy.read.only : [];
        expect(read).toContain(cwd);
        for (const place of [realpathSync(tmpdir()), homedir(), realpathSync(host.home)]) {
          expect(read.some((path) => place === path || place.startsWith(`${path}/`))).toBe(false);
        }
        expect(readFileSync(join(cwd, "in.txt"), "utf8")).toBe("x\n");

        const denied = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", `echo x > ${outside}/out.txt`], cwd, timeout: 20_000 });
        expect(denied.exit).not.toBe(0);
        expect(existsSync(join(outside, "out.txt"))).toBe(false);

        const online = await host.niwa.call(procRun, {
          cmd: ["/bin/sh", "-c", "curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com"],
          cwd,
          timeout: 30_000,
        });
        expect(online.exit).not.toBe(0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        await host.stop();
      }
    }, 90_000);

    test.skipIf(!present)("has no shared temp area, and a command's temp files go inside its cwd", async () => {
      const host = await procHost({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
      const shared = join(realpathSync(tmpdir()), `niwa-proc-shared-${process.pid}-${Date.now()}`);
      try {
        const cwd = realpathSync(dirIn(host.home, "work"));
        const refused = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", `echo x > '${shared}'`], cwd, timeout: 20_000 });
        expect(refused.exit).not.toBe(0);
        expect(existsSync(shared)).toBe(false);
        const made = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", 'mktemp "$TMPDIR/file.XXXXXX"'], cwd, timeout: 20_000 });
        expect(made.exit).toBe(0);
        expect(outputOf(host, made.output).trim().startsWith(`${cwd}/`)).toBe(true);
        expect(readdirSync(cwd)).toEqual([]);
      } finally {
        rmSync(shared, { force: true });
        await host.stop();
      }
    }, 60_000);

    test.skipIf(!present)("has the user's home, which it cannot write, and runs a program on the PATH from the toolchains", async () => {
      const tools = realpathSync(mkdtempSync(join(homedir(), ".niwa-proc-tools-")));
      writeFileSync(join(tools, "niwa-hello"), "#!/bin/sh\necho hello from the toolchain\n", { mode: 0o755 });
      const saved = process.env["PATH"];
      process.env["PATH"] = `${tools}:/usr/bin:/bin`;
      const host = await procHost({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
      try {
        const cwd = realpathSync(dirIn(host.home, "work"));
        const env = { PATH: `${tools}:/usr/bin:/bin` };
        const own = await host.niwa.call(procRun, {
          cmd: ["/bin/sh", "-c", 'echo "$HOME"; touch "$HOME/.niwa-proc-probe" 2>/dev/null && echo wrote || echo kept; niwa-hello'],
          cwd,
          timeout: 20_000,
          env,
        });
        const [home, wrote, hello] = outputOf(host, own.output).trim().split("\n");
        expect(own.exit).toBe(0);
        expect(home).toBe(homedir());
        expect([wrote, hello]).toEqual(["kept", "hello from the toolchain"]);
        expect(own.box.paths).toContainEqual({ path: tools, mode: "read", from: "toolchains" });

        // With the toolchains replaced, the same program is closed to it.
        const closed = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", "niwa-hello"], cwd, timeout: 20_000, env, box: { only: [] } });
        expect(closed.exit).not.toBe(0);
        expect(outputOf(host, closed.output)).not.toContain("hello from the toolchain");
      } finally {
        process.env["PATH"] = saved;
        await host.stop();
        rmSync(tools, { recursive: true, force: true });
        rmSync(join(homedir(), ".niwa-proc-probe"), { force: true });
      }
    }, 60_000);

    test.skipIf(!present)("commits in a git worktree, whose git directory lies in the main repository", async () => {
      const host = await procHost({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
      try {
        const main = realpathSync(dirIn(host.home, "repo"));
        const git = (cwd: string, ...args: string[]) => {
          const done = Bun.spawnSync(["git", "-c", "user.name=niwa", "-c", "user.email=niwa@example.com", ...args], { cwd, stderr: "pipe" });
          if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
        };
        git(main, "init", "-q", "-b", "main");
        git(main, "commit", "-q", "--allow-empty", "-m", "first");
        const tree = join(host.home, "worktrees", "wt-1");
        git(main, "worktree", "add", "-q", "-b", "lane", tree);
        const cwd = realpathSync(tree);
        const committed = await host.niwa.call(procRun, {
          cmd: ["/bin/sh", "-c", "echo x > made.txt && git add made.txt && git -c user.name=niwa -c user.email=niwa@example.com commit -q -m made && git rev-parse --abbrev-ref HEAD && git log --format=%s -1"],
          cwd,
          timeout: 30_000,
        });
        expect(outputOf(host, committed.output).trim().split("\n").slice(-2)).toEqual(["lane", "made"]);
        expect(committed.exit).toBe(0);
        expect(committed.box.paths).toContainEqual({ path: join(main, ".git", "worktrees", "wt-1"), mode: "write", from: "repository" });
        // The main checkout itself stays closed to it.
        const peek = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", `ls ${main}`], cwd, timeout: 20_000 });
        expect(peek.exit).not.toBe(0);
      } finally {
        await host.stop();
      }
    }, 90_000);

    test.skipIf(!present)("cannot read the owner token of its host", async () => {
      // A home under the user's home, as the host's is.
      const host = await procHost({ sandbox }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
      try {
        writeFileSync(join(host.home, "owner.token"), "owner-token-value\n", { mode: 0o600 });
        const cwd = realpathSync(dirIn(host.home, "work"));
        const result = await host.niwa.call(procRun, {
          cmd: ["/bin/sh", "-c", `cat ${join(realpathSync(host.home), "owner.token")}`],
          cwd,
          timeout: 20_000,
        });
        expect(result.exit).not.toBe(0);
        expect(outputOf(host, result.output)).not.toContain("owner-token-value");
      } finally {
        await host.stop();
      }
    }, 60_000);
  });
}

const srtPresent = live && (await srt().available());

test.skipIf(!srtPresent)("in srt, whose reads are open, a run cannot read the places of an installation it did not take", async () => {
  const codexHome = realpathSync(mkdtempSync(join(homedir(), ".niwa-proc-codex-")));
  writeFileSync(join(codexHome, "auth.json"), "codex-sign-in\n", { mode: 0o600 });
  const boxes = sandboxHost();
  boxes.install("codex-luna", { write: [codexHome] });
  const host = await procHost({ sandbox: srt(), boxes }, mkdtempSync(join(homedir(), ".niwa-proc-home-")));
  try {
    const cwd = realpathSync(dirIn(host.home, "work"));
    const result = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", `cat ${join(codexHome, "auth.json")}`], cwd, timeout: 20_000 });
    expect(result.exit).not.toBe(0);
    expect(outputOf(host, result.output)).not.toContain("codex-sign-in");
    expect(result.box.closed).toContainEqual({ path: codexHome, from: "harness:codex-luna" });
  } finally {
    await host.stop();
    rmSync(codexHome, { recursive: true, force: true });
  }
}, 60_000);
