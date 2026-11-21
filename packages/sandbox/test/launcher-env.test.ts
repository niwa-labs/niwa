// The environment of the process that starts a box, and the environment of the command inside it.
//
// What it proves, for srt and for nono:
//   1. the wrapper that applies the restrictions runs with an environment the host defines, never
//      with what the spec lists for the command: a variable that makes a program load code, or the
//      PATH its tools are found by, is the caller's to set only for the command
//   2. the command gets the environment the spec lists, and the host's own PATH is not among it
//   3. a program name that `env` would read as a variable is refused before anything starts

import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { SandboxUnsupported, boxSpec, nono, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

/** A wrapper that confines nothing: it writes down its own environment, then runs what follows `--`. */
async function recordingWrapper(dir: string): Promise<{ path: string; seen: string }> {
  const path = join(dir, "wrapper");
  const seen = join(dir, "wrapper-env");
  await writeFile(path, `#!/bin/sh\nenv > '${seen}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  await chmod(path, 0o755);
  return { path, seen };
}

async function wrapped(): Promise<Array<{ sandbox: Sandbox; seen: string; dir: string }>> {
  const made: Array<{ sandbox: Sandbox; seen: string; dir: string }> = [];
  {
    const dir = await tempDir("launcher-env-nono");
    const wrapper = await recordingWrapper(dir);
    made.push({ sandbox: nono({ binary: wrapper.path }), seen: wrapper.seen, dir });
  }
  {
    const dir = await tempDir("launcher-env-srt");
    const wrapper = await recordingWrapper(dir);
    made.push({ sandbox: srt({ command: [wrapper.path] }), seen: wrapper.seen, dir });
  }
  return made;
}

const HOSTILE = { NODE_OPTIONS: "--require /evil.js", BUN_OPTIONS: "--preload /evil.js", DYLD_LIBRARY_PATH: "/evil", LD_PRELOAD: "/evil.so" };

async function ran(sandbox: Sandbox, spec: Parameters<Sandbox["launch"]>[0], argv: string[]) {
  const box = await sandbox.launch(spec, argv);
  box.stdin.end();
  const [stdout, code] = await Promise.all([new Response(box.stdout).text(), box.exited]);
  return { stdout, code };
}

test("the wrapper that applies the restrictions runs with the host's environment, not the command's", async () => {
  for (const { sandbox, seen, dir } of await wrapped()) {
    const spec = boxSpec({ cwd: dir, env: { ...HOSTILE, PATH: "/custom/bin:/usr/bin:/bin", MARKER: "for-the-command" } });
    const result = await ran(sandbox, spec, ["/usr/bin/env"]);
    expect(result.code).toBe(0);

    const wrapperEnv = Object.fromEntries((await readFile(seen, "utf8")).split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    for (const name of [...Object.keys(HOSTILE), "MARKER"]) expect(wrapperEnv[name]).toBeUndefined();
    expect(wrapperEnv["PATH"]).toBe("/usr/bin:/bin");
    expect(Object.keys(wrapperEnv).every((name) => ["PATH", "HOME", "PWD", "SHLVL", "_", "OLDPWD"].includes(name))).toBe(true);

    for (const [name, value] of Object.entries(HOSTILE)) expect(result.stdout).toContain(`${name}=${value}`);
    expect(result.stdout).toContain("MARKER=for-the-command");
    expect(result.stdout).toContain("PATH=/custom/bin:/usr/bin:/bin");
  }
});

test("the command is found by the PATH the spec lists, and gets no variable of the launcher that the spec leaves out", async () => {
  for (const { sandbox, seen, dir } of await wrapped()) {
    const tools = join(dir, "tools");
    await Bun.$`mkdir -p ${tools}`.quiet();
    await writeFile(join(tools, "mytool"), "#!/bin/sh\necho tool-ran\n");
    await chmod(join(tools, "mytool"), 0o755);
    const spec = boxSpec({ cwd: dir, env: { PATH: `${tools}:/usr/bin:/bin` } });
    const found = await ran(sandbox, spec, ["mytool"]);
    expect(found.stdout).toBe("tool-ran\n");

    const bare = await ran(sandbox, boxSpec({ cwd: dir, env: { PATH: "/usr/bin:/bin" } }), ["/usr/bin/env"]);
    expect(bare.stdout).not.toContain(`HOME=${homedir()}`);
    expect(await readFile(seen, "utf8")).toContain("PATH=/usr/bin:/bin");
  }
});

test("a program whose name `env` would read as a variable is refused", async () => {
  for (const { sandbox, dir } of await wrapped()) {
    await expect(sandbox.launch(boxSpec({ cwd: dir }), ["FOO=bar", "x"])).rejects.toBeInstanceOf(SandboxUnsupported);
  }
});
