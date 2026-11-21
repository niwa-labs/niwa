// The sandbox manifest and the gate.
//
// What it proves:
//   1. a BoxSpec has no default prohibitions: closed is empty unless the user sets it, and write,
//      net and sockets are empty lists, not wide-open ones
//   2. the manifest is pure and deterministic, and carries exactly what the spec says
//   3. srt's settings are write/net/closed/sockets of the spec and nothing else; srt's PATH need is visible
//   4. nono's flags are the spec's write, net and sockets; an empty net is a blocked net
//   5. nono drops a closed place it never granted, and refuses one it would have to carve out of a granted place
//   6. a sandbox that is not available stops the session before it starts
//   7. nono's manifest carries the profile it is run with: the default one without the groups that
//      grant the temp areas and the user's tools, and a nono that resolves it to more is not available;
//      closing a socket the box is granted would open is refused
//   8. each manifest says the policy the sandbox applies: nono's is the spec's places and the
//      system's, srt's adds its own writes and leaves reads open
//
// Only the public API is used: "@niwa-labs/sandbox".

import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxUnavailable, BoxRefused, boxSpec, nono, requireSandbox, srt } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";
import { tempDir } from "@niwa-labs/testing";

const spec = boxSpec({
  cwd: "/work/repo",
  write: ["/work/repo", "/tmp", "~/.claude"],
  net: ["api.anthropic.com", "registry.npmjs.org"],
  env: { NIWA_TOKEN: "k3f9" },
  sockets: ["~/.niwa/host.sock"],
});

test("a spec has no default prohibitions and no default reach", () => {
  const bare = boxSpec({ cwd: "/work/repo" });
  expect(bare.closed).toEqual([]);
  expect(bare.write).toEqual([]);
  expect(bare.net).toEqual([]);
  expect(bare.sockets).toEqual([]);
  expect(bare.env).toEqual({});
});

test("a malformed spec is refused", () => {
  expect(() => boxSpec({ cwd: "" })).toThrow();
  expect(() => boxSpec({ cwd: "/x", net: ["two words"] })).toThrow();
  expect(() => boxSpec({ cwd: "/x", env: { "BAD NAME": "1" } })).toThrow();
});

test("the manifest is pure and says what the spec says", () => {
  const both: Sandbox[] = [srt(), nono()];
  for (const sandbox of both) {
    expect(JSON.stringify(sandbox.manifest(spec))).toBe(JSON.stringify(sandbox.manifest(spec)));
    expect(sandbox.manifest(spec).cwd).toBe("/work/repo");
    expect(sandbox.manifest(spec).sandbox).toBe(sandbox.name);
  }
});

test("srt settings are the spec's write, net, closed places and sockets", () => {
  const manifest = srt().manifest(spec);
  expect(manifest.settings).toEqual({
    network: { allowedDomains: ["api.anthropic.com", "registry.npmjs.org"], deniedDomains: [], allowUnixSockets: ["~/.niwa/host.sock"] },
    filesystem: {
      denyRead: [],
      allowWrite: [
        { path: "/work/repo", literal: true },
        { path: "/tmp", literal: true },
        { path: "~/.claude", literal: true },
      ],
      denyWrite: [],
    },
  });
  const user = srt().manifest(boxSpec({ cwd: "/work/repo", closed: ["~/.ssh"] }));
  expect(user.settings.filesystem.denyRead).toEqual([{ path: "~/.ssh", literal: true }]);
  expect(user.settings.filesystem.denyWrite).toEqual([{ path: "~/.ssh", literal: true }]);
  expect(user.settings.network.allowedDomains).toEqual([]);
});

test("srt gets a PATH to find its shell, visible in the manifest; a listed PATH wins", () => {
  expect(srt().manifest(spec).env).toEqual({ PATH: "/usr/bin:/bin", NIWA_TOKEN: "k3f9" });
  expect(srt().manifest(boxSpec({ cwd: "/x", env: { PATH: "/opt/bin" } })).env).toEqual({ PATH: "/opt/bin" });
});

test("nono flags are the spec's write, net and sockets; no net is a blocked net", () => {
  expect(nono().manifest(spec).flags).toEqual([
    "--silent",
    "--read", "/work/repo",
    "--allow", "/work/repo", "--allow", "/tmp", "--allow", "~/.claude",
    "--allow-unix-socket", "~/.niwa/host.sock",
    "--allow-domain", "api.anthropic.com", "--allow-domain", "registry.npmjs.org",
  ]);
  expect(nono().manifest(boxSpec({ cwd: "/x" })).flags).toContain("--block-net");
  expect(nono().manifest(spec).env).toEqual({ NIWA_TOKEN: "k3f9" });
});

test("nono needs no flag for a closed place it never granted, and refuses one it would have to carve out", () => {
  const closed = nono().manifest(boxSpec({ cwd: "/x", closed: ["~/.ssh", "~/.niwa/owner.token"] }));
  expect(closed.flags).toEqual(nono().manifest(boxSpec({ cwd: "/x" })).flags);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", closed: ["/x/secret"] }))).toThrow(BoxRefused);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", write: ["/home/.niwa"], closed: ["/home/.niwa/host.key"] }))).toThrow(
    BoxRefused,
  );
  expect(() => nono().manifest(boxSpec({ cwd: "/home", closed: ["/home/.niwa/host.key"] }))).toThrow(BoxRefused);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", read: ["/home"], closed: ["/home/.niwa/host.key"] }))).toThrow(BoxRefused);
});

test("nono refuses a closed place inside a place its profile grants without being asked", () => {
  // The profile lets the box read /usr/share: a flag cannot close a file there, and leaving the
  // entry out would only make it look closed.
  for (const platform of ["darwin", "linux"] as const) {
    expect(() => nono({ platform }).manifest(boxSpec({ cwd: "/x", closed: ["/usr/share/niwa-secret"] }))).toThrow(BoxRefused);
  }
});

test("srt on Linux refuses a socket it would silently leave closed", () => {
  const sockets = boxSpec({ cwd: "/x", sockets: ["~/.niwa/host.sock"] });
  expect(() => srt({ platform: "linux" }).manifest(sockets)).toThrow(BoxRefused);
  expect(srt({ platform: "linux" }).manifest(boxSpec({ cwd: "/x" })).settings.network.allowUnixSockets).toEqual([]);
  expect(srt({ platform: "darwin" }).manifest(sockets).settings.network.allowUnixSockets).toEqual(["~/.niwa/host.sock"]);
});

test("a socket nono grants is a place the box may read, so closing it is refused", () => {
  const socket = "~/.niwa/host.sock";
  expect(() => nono().manifest(boxSpec({ cwd: "/x", sockets: [socket], closed: [socket] }))).toThrow(BoxRefused);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", sockets: [socket], closed: ["~/.niwa/host.key"] }))).not.toThrow();
});

test("nono is run with the default profile less the groups that grant places of their own, the system places named instead", () => {
  const mac = nono({ platform: "darwin" }).manifest(boxSpec({ cwd: "/x" })).profile;
  expect(mac.extends).toBe("default");
  expect(mac.groups.exclude).toEqual(["system_read_macos", "system_write_macos", "user_tools", "homebrew_macos"]);
  expect(mac.filesystem.write).toEqual(["/dev"]);
  expect(mac.filesystem.read).toEqual(expect.arrayContaining(["/usr/lib", "/private/etc", "/etc", "/private/var/db/dyld"]));
  const linux = nono({ platform: "linux" }).manifest(boxSpec({ cwd: "/x" })).profile;
  expect(linux.groups.exclude).toEqual(["system_write_linux", "user_tools", "homebrew_linux"]);
  expect(linux.filesystem.write_file).toEqual(expect.arrayContaining(["/dev/null", "/dev/tty"]));
  // No temp area is granted back, for reading or writing, and no place above one.
  const temp = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", realpathSync(tmpdir())];
  for (const profile of [mac, linux]) {
    for (const path of [...profile.filesystem.read, ...profile.filesystem.write, ...profile.filesystem.write_file]) {
      for (const place of temp) expect(place === path || place.startsWith(`${path}/`)).toBe(false);
    }
  }
});

test("a nono that resolves the profile to more than is named is not available", async () => {
  const dir = await tempDir("nono-resolves");
  const answering = async (name: string, grants: unknown) => {
    const path = join(dir, name);
    await writeFile(
      path,
      `#!/bin/sh\nif [ "$1" = profile ]; then echo '${JSON.stringify({ filesystem: { grants } })}'; exit 0; fi\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    );
    await chmod(path, 0o755);
    return nono({ binary: path });
  };
  expect(await (await answering("named", [{ access: "read", path: "/usr/share/locale" }, { access: "readwrite", path: "/dev" }])).available()).toBe(
    process.platform === "darwin",
  );
  expect(await (await answering("temp", [{ access: "read", path: "/private" }])).available()).toBe(false);
  expect(await (await answering("writes", [{ access: "readwrite", path: "/private/tmp" }])).available()).toBe(false);
  expect(await (await answering("silent", "none")).available()).toBe(false);
});

test("nono's policy is the spec's places and the system's, with reads an allow-list", () => {
  const home = homedir();
  for (const platform of ["darwin", "linux"] as const) {
    const sandbox = nono({ platform });
    const { policy, profile } = sandbox.manifest(spec);
    expect(policy.write).toEqual(["/work/repo", "/tmp", join(home, ".claude")]);
    expect(policy.devices).toEqual([...profile.filesystem.write, ...profile.filesystem.write_file]);
    expect(policy.net).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
    if (!("only" in policy.read)) throw new Error("nono's reads are an allow-list");
    expect(policy.read.only.slice(0, 4)).toEqual(["/work/repo", "/tmp", join(home, ".claude"), join(home, ".niwa/host.sock")]);
    expect(policy.read.only).toEqual(expect.arrayContaining([...profile.filesystem.read, "/usr/share"]));
    expect(policy.read.only).not.toContain(home);
  }
});

test("srt's policy adds its own temp directory and home places to the writes, and its reads are open", async () => {
  const { getDefaultWritePaths } = await import("@anthropic-ai/sandbox-runtime");
  const home = homedir();
  const devices = (paths: string[]) => paths.filter((path) => path.startsWith("/dev/"));
  const places = (paths: string[]) => paths.filter((path) => !path.startsWith("/dev/"));
  const { policy } = srt().manifest(spec);
  expect(policy.write).toEqual(["/work/repo", "/tmp", join(home, ".claude"), ...places(getDefaultWritePaths())]);
  expect(policy.devices).toEqual(devices(getDefaultWritePaths()));
  expect(policy.read).toEqual({ except: [] });
  const denied = srt().manifest(boxSpec({ cwd: "/x", closed: ["~/.npm"] })).policy;
  expect(denied.write).toEqual(places(getDefaultWritePaths({ denyRead: ["~/.npm"], allowRead: [] })));
  expect(denied.read).toEqual({ except: [join(home, ".npm")] });
});

test("a working directory under the home directory is expanded once, and the paths read from it follow", () => {
  const home = homedir();
  for (const sandbox of [srt(), nono()]) {
    const manifest = sandbox.manifest(boxSpec({ cwd: "~/project", write: ["out"] }));
    expect(manifest.cwd).toBe(join(home, "project"));
  }
  expect(srt().manifest(boxSpec({ cwd: "~/project", write: ["out"] })).settings.filesystem.allowWrite).toEqual([
    { path: join(home, "project", "out"), literal: true },
  ]);
  expect(nono().manifest(boxSpec({ cwd: "~/project", write: ["out"] })).flags).toContain(join(home, "project", "out"));
});

test("nono sees through a link: a closed place under a place reached by a link is refused too", async () => {
  const dir = await tempDir("nono-link");
  await mkdir(join(dir, "home"));
  await symlink(join(dir, "home"), join(dir, "alias"));
  // The box may use the alias, and the key lies in the real directory it points to.
  expect(() => nono().manifest(boxSpec({ cwd: join(dir, "alias"), closed: [join(dir, "home", "host.key")] }))).toThrow(
    BoxRefused,
  );
});

test("nono reads the cwd and the places the spec adds to `read`; srt, whose reads are open, takes no flag for them", () => {
  const spec = boxSpec({ cwd: "/work", read: ["/pkg", "/pkg/node_modules"] });
  expect(nono().manifest(spec).flags).toEqual(["--silent", "--read", "/work", "--read", "/pkg", "--read", "/pkg/node_modules", "--block-net"]);
  expect(srt().manifest(spec)).toEqual(srt().manifest(boxSpec({ cwd: "/work" })));
});

test("a sandbox that is not available stops the session before it starts", async () => {
  const missing: Sandbox[] = [srt({ command: ["/nonexistent/srt"] }), nono({ binary: "/nonexistent/nono" })];
  for (const sandbox of missing) {
    expect(await sandbox.available()).toBe(false);
    await expect(requireSandbox(sandbox)).rejects.toBeInstanceOf(SandboxUnavailable);
    await expect(sandbox.launch(spec, ["true"])).rejects.toBeInstanceOf(SandboxUnavailable);
  }
});
