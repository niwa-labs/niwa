// The process sandboxes on a real machine.
//
// Runs the real srt and nono binaries, so it is behind `live`, and each part is skipped on a machine
// where that sandbox is not available.
//
// What it proves, for srt and for nono:
//   1. a process writes inside `write` and fails outside it
//   2. a process reaches a host in `net` and does not reach one that is not listed (GitLab)
//   3. the process gets the listed environment and not the host's
//
// Only the public API is used: "@niwa-labs/sandbox".

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { boxSpec, nono, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";

import { tempDir, live } from "@niwa-labs/testing";

async function run(sandbox: Sandbox, spec: Parameters<Sandbox["launch"]>[0], script: string) {
  const box = await sandbox.launch(spec, ["/bin/sh", "-c", script]);
  const [stdout, stderr, code] = await Promise.all([new Response(box.stdout).text(), new Response(box.stderr).text(), box.exited]);
  return { stdout, stderr, code };
}

const CURL = (url: string) => `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${url}`;

for (const sandbox of [srt(), nono()]) {
  const present = live && (await sandbox.available());
  describe(sandbox.name, () => {
    test.skipIf(!present)("writes only inside `write`", async () => {
      const inside = await realpath(await tempDir("box-in"));
      // Not under tmpdir: nono leaves the temp area writable on its own.
      const outside = await realpath(await mkdtemp(join(homedir(), ".niwa-box-out-")));
      try {
        const spec = boxSpec({ cwd: inside, write: [inside], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        const ok = await run(sandbox, spec, `echo x > ${inside}/a`);
        expect(ok.code).toBe(0);
        expect(await readFile(join(inside, "a"), "utf8")).toBe("x\n");
        const denied = await run(sandbox, spec, `echo x > ${outside}/b`);
        expect(denied.code).not.toBe(0);
        expect(await Bun.file(join(outside, "b")).exists()).toBe(false);
      } finally {
        await rm(inside, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    test.skipIf(!present)("reaches only the hosts in `net`", async () => {
      const cwd = await realpath(await tempDir("box-net"));
      try {
        const env = { PATH: "/usr/bin:/bin", HOME: homedir() };
        const open = boxSpec({ cwd, net: ["example.com"], env });
        expect((await run(sandbox, open, CURL("https://example.com"))).stdout).toBe("200");
        const gitlab = await run(sandbox, open, CURL("https://gitlab.com"));
        expect(gitlab.stdout).not.toBe("200");
        expect(gitlab.code).not.toBe(0);
        const none = boxSpec({ cwd, env });
        expect((await run(sandbox, none, CURL("https://example.com"))).code).not.toBe(0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    test.skipIf(!present)("the process gets the listed environment and not the host's", async () => {
      const cwd = await realpath(await tempDir("box-env"));
      process.env.NIWA_HOST_ONLY = "leak";
      try {
        const spec = boxSpec({ cwd, env: { PATH: "/usr/bin:/bin", HOME: homedir(), NIWA_TOKEN: "k3f9" } });
        const out = await run(sandbox, spec, 'echo "$NIWA_TOKEN:${NIWA_HOST_ONLY:-none}"');
        expect(out.stdout.trim()).toBe("k3f9:none");
      } finally {
        delete process.env.NIWA_HOST_ONLY;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
}
