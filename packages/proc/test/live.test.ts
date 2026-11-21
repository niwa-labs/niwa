// proc.run in the real sandboxes.
//
// Runs the real srt and nono, so it is behind `live`, and each part is skipped on a machine where
// that sandbox is not available.
//
// What it proves, for srt and for nono:
//   1. a run writes in its cwd and cannot write outside it
//   2. a run reaches no network
//   3. a run cannot read the owner token of the host, though the host's home holds it

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { nono, srt } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { artifactPath, procRun } from "../src/index.ts";
import { dirIn, procHost } from "./support.ts";

for (const sandbox of [srt(), nono()]) {
  const present = live && (await sandbox.available());
  describe(`proc.run in ${sandbox.name}`, () => {
    test.skipIf(!present)("writes in its cwd, not outside it, and reaches no network", async () => {
      const host = await procHost({ sandbox });
      // Not under tmpdir: nono leaves the temp area writable on its own.
      const outside = realpathSync(mkdtempSync(join(homedir(), ".niwa-proc-out-")));
      try {
        const cwd = realpathSync(dirIn(host.home, "work"));
        const inside = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", "echo x > in.txt"], cwd, timeout: 20_000 });
        expect(inside.exit).toBe(0);
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
        expect(readFileSync(artifactPath(host.home, result.output), "utf8")).not.toContain("owner-token-value");
      } finally {
        await host.stop();
      }
    }, 60_000);
  });
}
