// The sandbox manifest and the gate.
//
// What it proves:
//   1. a BoxSpec has no default prohibitions: denyRead is empty unless the user sets it, and write,
//      net and sockets are empty lists, not wide-open ones
//   2. the manifest is pure and deterministic, and carries exactly what the spec says
//   3. srt's settings are write/net/denyRead/sockets of the spec and nothing else; srt's PATH need is visible
//   4. nono's flags are the spec's write, net and sockets; an empty net is a blocked net
//   5. nono drops a denyRead it never granted, and refuses one it would have to carve out of a granted place
//   6. a sandbox that is not available stops the session before it starts
//   7. nono's manifest carries the profile it is run with: the default one without the temp areas;
//      a denyRead that a granted socket would open is refused; what each sandbox holds is said
//
// Only the public API is used: "@niwa-labs/sandbox".

import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SandboxUnavailable, SandboxUnsupported, boxSpec, nono, requireSandbox, srt } from "@niwa-labs/sandbox";
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
  expect(bare.denyRead).toEqual([]);
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

test("srt settings are the spec's write, net, denyRead and sockets", () => {
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
  const user = srt().manifest(boxSpec({ cwd: "/work/repo", denyRead: ["~/.ssh"] }));
  expect(user.settings.filesystem.denyRead).toEqual([{ path: "~/.ssh", literal: true }]);
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

test("nono needs no flag for a denyRead it never granted, and refuses one it would have to carve out", () => {
  const closed = nono().manifest(boxSpec({ cwd: "/x", denyRead: ["~/.ssh", "~/.niwa/owner.token"] }));
  expect(closed.flags).toEqual(nono().manifest(boxSpec({ cwd: "/x" })).flags);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", denyRead: ["/x/secret"] }))).toThrow(SandboxUnsupported);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", write: ["/home/.niwa"], denyRead: ["/home/.niwa/host.key"] }))).toThrow(
    SandboxUnsupported,
  );
  expect(() => nono().manifest(boxSpec({ cwd: "/home", denyRead: ["/home/.niwa/host.key"] }))).toThrow(SandboxUnsupported);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", read: ["/home"], denyRead: ["/home/.niwa/host.key"] }))).toThrow(SandboxUnsupported);
});

test.skipIf(process.platform !== "darwin" || !(await nono().available()))(
  "nono refuses a denyRead inside a place it grants without being asked",
  () => {
    // nono's default profile lets the box read /usr/share: a flag cannot close a file there, and
    // leaving the entry out would only make it look closed.
    expect(() => nono().manifest(boxSpec({ cwd: "/x", denyRead: ["/usr/share/niwa-secret"] }))).toThrow(SandboxUnsupported);
  },
);

test("srt on Linux refuses a socket it would silently leave closed", () => {
  const sockets = boxSpec({ cwd: "/x", sockets: ["~/.niwa/host.sock"] });
  expect(() => srt({ platform: "linux" }).manifest(sockets)).toThrow(SandboxUnsupported);
  expect(srt({ platform: "linux" }).manifest(boxSpec({ cwd: "/x" })).settings.network.allowUnixSockets).toEqual([]);
  expect(srt({ platform: "darwin" }).manifest(sockets).settings.network.allowUnixSockets).toEqual(["~/.niwa/host.sock"]);
});

test("a socket nono grants is a place the box may read, so a denyRead on it is refused", () => {
  const socket = "~/.niwa/host.sock";
  expect(() => nono().manifest(boxSpec({ cwd: "/x", sockets: [socket], denyRead: [socket] }))).toThrow(SandboxUnsupported);
  expect(() => nono().manifest(boxSpec({ cwd: "/x", sockets: [socket], denyRead: ["~/.niwa/host.key"] }))).not.toThrow();
});

test("nono is run with the default profile less the temp areas, which each platform names in its own group", () => {
  const mac = nono({ platform: "darwin" }).manifest(boxSpec({ cwd: "/x" })).profile;
  expect(mac.extends).toBe("default");
  expect(mac.groups.exclude).toEqual(["system_write_macos"]);
  expect(mac.filesystem.write).toEqual(["/dev"]);
  const linux = nono({ platform: "linux" }).manifest(boxSpec({ cwd: "/x" })).profile;
  expect(linux.groups.exclude).toEqual(["system_write_linux"]);
  expect(linux.filesystem.write_file).toEqual(expect.arrayContaining(["/dev/null", "/dev/tty"]));
  // No place of the temp areas is granted back.
  for (const profile of [mac, linux]) {
    for (const path of [...profile.filesystem.write, ...profile.filesystem.write_file]) expect(path).not.toMatch(/tmp|var\/folders/);
  }
});

test("what a sandbox holds beyond the lists of its spec is said: nono holds writes and reads, srt neither", () => {
  expect(nono().guarantees).toEqual({ exactWrites: true, closedReads: true });
  expect(srt().guarantees).toEqual({ exactWrites: false, closedReads: false });
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

test("nono sees through a link: a denyRead under a place reached by a link is refused too", async () => {
  const dir = await tempDir("nono-link");
  await mkdir(join(dir, "home"));
  await symlink(join(dir, "home"), join(dir, "alias"));
  // The box may use the alias, and the key lies in the real directory it points to.
  expect(() => nono().manifest(boxSpec({ cwd: join(dir, "alias"), denyRead: [join(dir, "home", "host.key")] }))).toThrow(
    SandboxUnsupported,
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
