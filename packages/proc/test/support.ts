// What the proc tests share: a sandbox that confines nothing and writes down what it was asked,
// and a host with the module installed.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { SandboxUnavailable } from "@niwa-labs/sandbox";
import type { BoxSpec, Sandbox } from "@niwa-labs/sandbox";
import { createNiwa, tempHome } from "@niwa-labs/testing";

import { proc } from "../src/index.ts";
import type { ProcOptions } from "../src/index.ts";

/** A sandbox that runs the command as it is. Every spec it is given is kept. */
export function recordingSandbox(): Sandbox & { readonly specs: BoxSpec[] } {
  const specs: BoxSpec[] = [];
  return {
    specs,
    name: "nono",
    class: "process",
    available: async () => true,
    manifest: (spec) => ({ sandbox: "nono", cwd: spec.cwd, env: spec.env }),
    async launch(spec, argv, options) {
      specs.push(spec);
      const child = Bun.spawn([...argv], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: options?.detached ?? false,
      });
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited: child.exited,
        kill: (signal) => child.kill(signal),
      };
    },
  };
}

/** A sandbox that cannot run on this machine. */
export const absentSandbox: Sandbox = {
  name: "nono",
  class: "process",
  available: async () => false,
  manifest: (spec) => ({ sandbox: "nono", cwd: spec.cwd, env: spec.env }),
  async launch() {
    throw new SandboxUnavailable("nono", "not here");
  },
};

/** A host with the proc module over a fresh home. */
export async function procHost(options: ProcOptions = {}, at?: string) {
  const home =
    at === undefined
      ? await tempHome()
      : { path: at, cleanup: async () => rmSync(at, { recursive: true, force: true }) };
  const niwa = createNiwa({ home: home.path });
  niwa.use(proc(options));
  await niwa.serve();
  return {
    niwa,
    home: home.path,
    async stop() {
      await niwa.close();
      await home.cleanup();
    },
  };
}

/** A directory made inside a parent. */
export function dirIn(parent: string, ...parts: string[]): string {
  const path = join(parent, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Every regular file under a directory, with its bytes. */
export function filesUnder(dir: string): Array<{ path: string; bytes: Buffer }> {
  const found: Array<{ path: string; bytes: Buffer }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...filesUnder(path));
    else if (stat.isFile()) found.push({ path, bytes: readFileSync(path) });
  }
  return found;
}

/** Is a process alive? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
