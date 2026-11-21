// The process sandboxes on a real machine.
//
// Runs the real srt and nono binaries, so it is behind `live`, and each part is skipped on a machine
// where that sandbox is not available.
//
// What it proves, for srt and for nono:
//   1. a process writes inside `write` and fails outside it
//   2. a process reaches a host in `net` and does not reach one that is not listed (GitLab)
//   3. the process gets the listed environment and not the host's
//   4. a relative `write` is read from the cwd, where the wrapper runs
//   5. a path with pattern characters names itself and not its neighbours
//   6. a detached box leads its own process group, and a group signal ends what it started
//
// Only the public API is used: "@niwa-labs/sandbox".

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { boxSpec, nono, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";

import { tempDir, live } from "@niwa-labs/testing";

async function run(sandbox: Sandbox, spec: Parameters<Sandbox["launch"]>[0], script: string) {
  const box = await sandbox.launch(spec, ["/bin/sh", "-c", script]);
  const [stdout, stderr, code] = await Promise.all([new Response(box.stdout).text(), new Response(box.stderr).text(), box.exited]);
  return { stdout, stderr, code };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

    test.skipIf(!present)("a relative `write` is read from the cwd", async () => {
      // Not under tmpdir: nono leaves the temp area writable on its own.
      const cwd = await realpath(await mkdtemp(join(homedir(), ".niwa-box-rel-")));
      try {
        await mkdir(join(cwd, "out"));
        const spec = boxSpec({ cwd, write: ["out"], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        expect((await run(sandbox, spec, "echo x > out/a")).code).toBe(0);
        expect(await readFile(join(cwd, "out", "a"), "utf8")).toBe("x\n");
        expect((await run(sandbox, spec, "echo x > b")).code).not.toBe(0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    test.skipIf(!present)("a path with pattern characters names itself and not its neighbours", async () => {
      const base = await realpath(await mkdtemp(join(homedir(), ".niwa-box-glob-")));
      try {
        const cwd = join(base, "work");
        await mkdir(cwd);
        // `out*` does not exist yet: read as a pattern it would grant `outside` too.
        const spec = boxSpec({ cwd, write: [cwd, join(base, "out*")], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        expect((await run(sandbox, spec, "echo x > here")).code).toBe(0);
        const neighbour = await run(sandbox, spec, `echo x > '${base}/outside'`);
        expect(neighbour.code).not.toBe(0);
        expect(await Bun.file(join(base, "outside")).exists()).toBe(false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    test.skipIf(!present)("a detached box leads its own group, and a group signal ends what it started", async () => {
      const cwd = await realpath(await tempDir("box-group"));
      let grandchild = 0;
      try {
        const spec = boxSpec({ cwd, env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        const box = await sandbox.launch(spec, ["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { detached: true });
        const group = await Bun.$`ps -o pgid= -p ${box.pid}`.text();
        expect(Number(group.trim())).toBe(box.pid);
        const reader = box.stdout.getReader();
        grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim());
        expect(grandchild).toBeGreaterThan(0);
        process.kill(-box.pid, "SIGKILL");
        await box.exited;
        for (let tries = 0; tries < 100 && alive(grandchild); tries++) await sleep(20);
        expect(alive(grandchild)).toBe(false);
      } finally {
        if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, "SIGKILL");
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
}
