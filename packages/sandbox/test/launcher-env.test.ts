// The environment of the process that starts a box, and the environment of the command inside it.
//
// What it proves, for srt and for nono:
//   1. the wrapper that applies the restrictions runs with an environment the host defines, never
//      with what the spec lists for the command: a variable that makes a program load code, or the
//      PATH its tools are found by, is the caller's to set only for the command
//   2. the command gets the environment the spec lists, and the host's own PATH is not among it
//   3. a program name that `env` would read as a variable is refused before anything starts
//   4. the wrapper starts from a directory of the host's, not the command's, and the command still
//      starts in its own
//   5. the values of the command's environment are in no command line while the box runs

import { chmod, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { BoxRefused, boxSpec, nono, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

/** A wrapper that confines nothing: it writes down its own environment, then runs what follows `--`. */
async function recordingWrapper(dir: string): Promise<{ path: string; seen: string }> {
  const path = join(dir, "wrapper");
  const seen = join(dir, "wrapper-env");
  await writeFile(path, `#!/bin/sh\nenv > '${seen}'\npwd -P > '${seen}-cwd'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
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
    // Besides the host's own names, only the command's values, under the names they travel by.
    expect(Object.keys(wrapperEnv).every((name) => ["PATH", "HOME", "PWD", "SHLVL", "_", "OLDPWD"].includes(name) || name.startsWith("NIWA_BOX__"))).toBe(true);

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
    await expect(sandbox.launch(boxSpec({ cwd: dir }), ["FOO=bar", "x"])).rejects.toBeInstanceOf(BoxRefused);
  }
});

test("the wrapper starts from a directory of the host's, and the command starts in its own", async () => {
  for (const { sandbox, seen, dir } of await wrapped()) {
    const cwd = join(dir, "work");
    await Bun.$`mkdir -p ${cwd}`.quiet();
    const result = await ran(sandbox, boxSpec({ cwd, env: { PATH: "/usr/bin:/bin" } }), ["/bin/pwd", "-P"]);
    expect(result.stdout.trim()).toBe(await realpath(cwd));
    const wrapperCwd = (await readFile(`${seen}-cwd`, "utf8")).trim();
    expect(wrapperCwd.startsWith(await realpath(dir))).toBe(false);
  }
});

test("the values of the command's environment are in no command line while the box runs", async () => {
  // A wrapper that stays alive around the command, as srt and nono do, so its command line can be read.
  const dir = await tempDir("launcher-env-argv");
  const path = join(dir, "waiting");
  await writeFile(path, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@"\nexit $?\n');
  await chmod(path, 0o755);
  // Built here, so that no command line of this run spells it out before the box does.
  const secret = ["x9q7", "secret", "value"].join("-");
  for (const sandbox of [nono({ binary: path }), srt({ command: [path] })]) {
    const box = await sandbox.launch(boxSpec({ cwd: dir, env: { PATH: "/usr/bin:/bin", NIWA_SECRET: secret } }), ["/bin/sh", "-c", 'echo "$NIWA_SECRET"; sleep 1']);
    const reader = box.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe(secret);
    const processes = await Bun.$`ps -axww -o args=`.text();
    expect(processes).not.toContain(secret);
    expect(processes).toContain("niwa-box");
    await box.exited;
  }
});

test("nono is given its profile as a file only the host can read, and the file is gone once the box has ended", async () => {
  const dir = await tempDir("nono-profile-file");
  const path = join(dir, "wrapper");
  const seen = join(dir, "profile-path");
  // Writes down the file named after `--profile` and what it holds, then runs what follows `--`.
  await writeFile(
    path,
    `#!/bin/sh\nwhile [ "$1" != "--profile" ]; do shift; done\nprintf %s "$2" > '${seen}'\ncat "$2" > '${seen}-content'\n(stat -c %a "$2" || stat -f %Lp "$2") > '${seen}-mode' 2>/dev/null\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
  );
  await chmod(path, 0o755);
  const sandbox = nono({ binary: path });
  const spec = boxSpec({ cwd: dir, env: { PATH: "/usr/bin:/bin" } });
  const result = await ran(sandbox, spec, ["/usr/bin/true"]);
  expect(result.code).toBe(0);
  const profile = await readFile(seen, "utf8");
  expect(JSON.parse(await readFile(`${seen}-content`, "utf8"))).toEqual(JSON.parse(JSON.stringify(sandbox.manifest(spec).profile)));
  expect((await readFile(`${seen}-mode`, "utf8")).trim()).toBe("600");
  expect(await Bun.file(profile).exists()).toBe(false);
});
