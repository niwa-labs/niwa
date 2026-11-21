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
//   5. the box a run names is nono's policy: its cwd to write, and neither a temp area nor the home to read

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { nono } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { procRun } from "../src/index.ts";
import { dirIn, outputOf, procHost } from "./support.ts";

// srt is not among them: it cannot keep what a run promises (its own temp directory is writable and
// every read is open unless named), so proc.run refuses it.
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
        // The box it names is the one nono applies: its own directory to write, and no temp area or home to read.
        expect(inside.box.write).toEqual([cwd]);
        expect(inside.box.read).toContain(cwd);
        for (const place of [realpathSync(tmpdir()), homedir(), realpathSync(host.home)]) {
          expect(inside.box.read.some((path) => place === path || place.startsWith(`${path}/`))).toBe(false);
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

    test.skipIf(!present)("cannot read the owner token of its host", async () => {
      // A home under the user's home, as the host's is: nono reads the temp area on its own.
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
