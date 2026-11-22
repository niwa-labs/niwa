import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { boxSpec, realPlace, sandboxOf } from "@niwa-labs/sandbox";
import type { BoxRequest, LoopbackListen } from "@niwa-labs/sandbox";

export function xdgRootsOf(env: Readonly<Record<string, string | undefined>>, home: string, cwd: string) {
  const user = env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || home;
  return {
    XDG_DATA_HOME: resolve(cwd, env["XDG_DATA_HOME"] || join(user, ".local", "share")),
    XDG_CONFIG_HOME: resolve(cwd, env["XDG_CONFIG_HOME"] || join(user, ".config")),
    XDG_STATE_HOME: resolve(cwd, env["XDG_STATE_HOME"] || join(user, ".local", "state")),
    XDG_CACHE_HOME: resolve(cwd, env["XDG_CACHE_HOME"] || join(user, ".cache")),
  };
}

/** Pin OpenCode's paths in the confined environment and check them against the existing write list. */
export function boxedEnvironment(box: BoxRequest, launchEnv: Readonly<Record<string, string>>, cwd: string) {
  const requested = { ...box.spec.env, ...launchEnv };
  const roots = xdgRootsOf({ ...process.env, ...requested }, homedir(), cwd);
  const temp = resolve(cwd, requested["TMPDIR"] || requested["TMP"] || requested["TEMP"] || tmpdir());
  const config = requested["OPENCODE_CONFIG_DIR"];
  const directories = Object.values(roots).map((root) => join(root, "opencode"));
  const dirs = [...directories, join(temp, "opencode"), ...(config ? [resolve(cwd, config)] : [])];
  const writes = (box.spec.write ?? []).map((path) => realPlace(path.startsWith("~/") ? path : resolve(cwd, path)));
  const missing = [...new Set(dirs)].filter((dir) => {
    const place = realPlace(dir);
    return !writes.some((path) => covers(path, place));
  });
  return {
    env: { ...roots, TMPDIR: temp },
    home: join(roots.XDG_DATA_HOME, "opencode"),
    directories,
    missing,
  };
}

function covers(root: string, path: string): boolean {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
}

export function matchesListener(url: string, listener: LoopbackListen): boolean {
  const { hostname, port } = new URL(url);
  const host = listener.host === "::1" ? "[::1]" : listener.host;
  return hostname === host && (listener.port === 0 || Number(port || "80") === listener.port);
}

/** A writable grant may name the runtime tree, an ancestor, or something inside it. */
export function writesRuntime(box: BoxRequest, runtime: string, cwd: string): boolean {
  const spec = boxSpec({ ...box.spec, cwd });
  const policy = sandboxOf(box.sandbox).manifest(spec).policy;
  return [...spec.write, ...policy?.write ?? []].some((path) => {
    const place = realPlace(path.startsWith("~/") ? path : resolve(cwd, path));
    return covers(place, runtime) || covers(runtime, place);
  });
}
