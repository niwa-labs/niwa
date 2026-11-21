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
//   7. a sandbox whose policy writes only what `write` lists lets a process write no temp area, only
//      what `write` lists and the devices it needs
//   8. a sandbox whose policy reads from an allow-list lets a process read neither the user's temp
//      area nor a file of the home it was not given, and the system's tools still run
//   9. a place a sandbox's policy adds to the writes is writable: srt's own temp directory
//
// Only the public API is used: "@niwa-labs/sandbox".

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/** Does the sandbox say it writes only what a spec lists, besides the devices? */
function exact(sandbox: Sandbox): boolean {
  const spec = boxSpec({ cwd: "/x", write: ["/x"] });
  return JSON.stringify(sandbox.manifest(spec).policy?.write) === JSON.stringify(["/x"]);
}

/** Does the sandbox say its reads are an allow-list? */
function closed(sandbox: Sandbox): boolean {
  const policy = sandbox.manifest(boxSpec({ cwd: "/x" })).policy;
  return policy !== undefined && "only" in policy.read;
}

const CURL = (url: string) => `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${url}`;

for (const sandbox of [srt(), nono()]) {
  const present = live && (await sandbox.available());
  describe(sandbox.name, () => {
    test.skipIf(!present)("writes only inside `write`", async () => {
      const inside = await realpath(await tempDir("box-in"));
      const outside = await realpath(await mkdtemp(join(tmpdir(), "niwa-box-out-")));
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

    test.skipIf(!present || !exact(sandbox))("writes no temp area, and still has the devices it needs", async () => {
      const cwd = await realpath(await tempDir("box-temp"));
      const name = `niwa-box-temp-${process.pid}-${Date.now()}`;
      const shared = [join("/tmp", name), join(await realpath(tmpdir()), name)];
      try {
        const spec = boxSpec({ cwd, write: [cwd], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        for (const path of shared) {
          expect((await run(sandbox, spec, `echo x > '${path}'`)).code).not.toBe(0);
          expect(await Bun.file(path).exists()).toBe(false);
        }
        const devices = await run(sandbox, spec, "echo x > /dev/null && echo x > /dev/stderr && echo ok");
        expect(devices.code).toBe(0);
        expect(devices.stdout.trim()).toBe("ok");
      } finally {
        for (const path of shared) await rm(path, { force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    });

    test.skipIf(!present || !closed(sandbox))("reads neither the user's temp area nor the home, and still runs the system's tools", async () => {
      const cwd = await realpath(await mkdtemp(join(homedir(), ".niwa-box-read-")));
      const kept = await realpath(await mkdtemp(join(tmpdir(), "niwa-box-kept-")));
      try {
        await Bun.write(join(kept, "note"), "temp-secret\n");
        await Bun.write(join(cwd, "..", `${basename(cwd)}-beside`), "home-secret\n");
        const spec = boxSpec({ cwd, write: [cwd], env: { PATH: "/usr/bin:/bin", HOME: homedir(), TZ: "Europe/Moscow" } });
        const temp = await run(sandbox, spec, `cat '${kept}/note'; ls '${kept}'`);
        expect(temp.code).not.toBe(0);
        expect(temp.stdout).not.toContain("temp-secret");
        expect(temp.stdout).not.toContain("note");
        const home = await run(sandbox, spec, `cat '${cwd}-beside'`);
        expect(home.code).not.toBe(0);
        expect(home.stdout).not.toContain("home-secret");
        const tools = await run(sandbox, spec, "date +%Z && /usr/bin/env sh -c 'echo ok' && ls /usr/share > /dev/null && echo listed");
        expect(tools.stdout.trim().split("\n")).toEqual(["MSK", "ok", "listed"]);
        expect(tools.code).toBe(0);
      } finally {
        await rm(`${cwd}-beside`, { force: true });
        await rm(cwd, { recursive: true, force: true });
        await rm(kept, { recursive: true, force: true });
      }
    });

    test.skipIf(!present || sandbox.name !== "srt")("writes the temp directory its policy adds to the spec's", async () => {
      const cwd = await realpath(await tempDir("box-own-temp"));
      try {
        const spec = boxSpec({ cwd, write: [cwd], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
        const added = sandbox.manifest(spec).policy?.write.filter((path) => path !== cwd) ?? [];
        expect(added).toContain("/tmp/claude");
        const name = `/tmp/claude/niwa-box-own-${process.pid}-${Date.now()}`;
        expect((await run(sandbox, spec, `mkdir -p /tmp/claude && echo x > '${name}'`)).code).toBe(0);
        await rm(name, { force: true });
      } finally {
        await rm(cwd, { recursive: true, force: true });
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
      const cwd = await realpath(await tempDir("box-rel"));
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
