// How a box gets its access: profiles, requests, and the plan they resolve to.
//
// What it proves:
//   1. a profile is paths, or a function of the machine; `bin` finds a program, its real path and its package
//   2. the catalog has git, node, bun, npm, cargo and uv; a host adds or replaces profiles by name
//   3. a box gets the paths of the profiles it takes; every other profile's paths are closed to it,
//      programs excepted, and a profile two installations share stays open to both
//   4. a path asked for never opens a place another profile keeps: it is refused, naming the profile
//   5. the closed list (keys, niwa's own) is closed unless a place in it is asked for by name
//   6. `allow` adds to the host's default and `only` replaces it; what goes beyond the default needs a rule
//   7. a box that reaches no network refuses a host asked of it and leaves out the hosts of its profiles
//   8. `admit` refuses with every reason at once: unknown names, missing rules, and what the sandbox cannot hold
//   9. nono grants a file as a file; srt refuses a place it is to open inside a closed one
//  10. the manifest records the request, the paths with their origins, the rules and the policy; env by name only

import { afterAll, beforeAll, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { BoxManifestSchema, BoxRefused, LoopbackListenSchema, admit, boxManifest, boxSpec, itemOf, nono, planSpec, resolveProfile, sandbox, srt } from "@niwa-labs/sandbox";
import type { BoxRefusal, LoopbackListen, Sandbox } from "@niwa-labs/sandbox";
import { catalog } from "@niwa-labs/sandbox/profiles";

let root = "";
let savedPath: string | undefined;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "niwa-access-")));
  savedPath = process.env["PATH"];
  // A PATH of one directory with one program in a package, so `bin` and `toolchains` are known.
  const pkg = join(root, "lib", "node_modules", "@acme", "tool");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "bin", "tool.js"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, "bin"));
  symlinkSync(join(pkg, "bin", "tool.js"), join(root, "bin", "tool"));
  process.env["PATH"] = join(root, "bin");
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "codex"));
  writeFileSync(join(root, "codex", "auth.json"), "{}");
  mkdirSync(join(root, "pi"));
});

afterAll(() => {
  process.env["PATH"] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

const at = (...parts: string[]) => join(root, ...parts);
const allows = (plan: { paths: readonly { path: string; mode: string }[] }, path: string, mode?: string) =>
  plan.paths.some((need) => need.path === path && (mode === undefined || need.mode === mode));
const closes = (plan: { closed: readonly { path: string }[] }, path: string) => plan.closed.some((one) => one.path === path);
const codes = (reasons: readonly BoxRefusal[]) => reasons.map((reason) => reason.code);

/** A host with a tool and two harness installations whose homes are under the test's root. */
function host() {
  const made = sandbox({ profiles: { tool: ({ bin }) => ({ read: [...bin("tool"), at("tool.conf")], write: [at("tool-cache")] }) } });
  made.install("codex-luna", { read: [], write: [at("codex")], net: ["api.openai.com"] });
  made.install("codex-sol", { write: [at("codex")], net: ["api.openai.com"] });
  made.install("pi", { write: [at("pi")] });
  return made;
}

const LOOPBACK = { host: "127.0.0.1", port: 0 } as const;

test("Keychain reads come only from the owning installation and survive the manifest", () => {
  const services = ["login-one", "login-two"] as const;
  const host = sandbox({ profiles: { helper: { keychainRead: ["helper-login"] } } });
  host.install("claude", { keychainRead: services });
  host.install("empty", { keychainRead: [] });
  const input = { cwd: at("work"), defaults: { allow: ["helper", "toolchains"] }, network: false } as const;
  const adapter = nono({ platform: "darwin" });
  const plan = host.plan({ ...input, owner: "claude" });
  const admitted = admit(plan, adapter, () => undefined);
  expect(admitted.spec.keychainRead).toEqual(services);
  expect(BoxManifestSchema.parse(boxManifest(plan, admitted.rules, admitted.manifest))).toMatchObject({
    keychainRead: services,
    policy: { keychainRead: services },
  });
  for (const owner of [undefined, "empty", "other"]) {
    const unprivileged = admit(host.plan({ ...input, owner }), adapter, () => undefined);
    expect(unprivileged.spec.keychainRead).toBeUndefined();
    expect(adapter.manifest(unprivileged.spec).profile.command_policies).toBeUndefined();
  }
  expect(() => admit(plan, srt(), () => undefined)).toThrow(/Keychain/);
  expect(() => admit(plan, nono({ platform: "linux" }), () => undefined)).toThrow(/requires macOS/);
  const overgranting = {
    ...adapter,
    manifest(spec: typeof admitted.spec) {
      const manifest = adapter.manifest(spec);
      return { ...manifest, policy: { ...manifest.policy, keychainRead: [...services, "helper-login"] } };
    },
  };
  expect(() => admit(plan, overgranting, () => undefined)).toThrow(/exact requested Keychain services/);
});

test("socket bind comes from selected profiles and resolves only to named directories", () => {
  const temp = at("socket-temp");
  const explicit = at("socket-explicit");
  const alias = at("socket-alias");
  mkdirSync(temp);
  mkdirSync(explicit);
  symlinkSync(explicit, alias);
  const made = sandbox({ profiles: { broker: {
    write: [explicit],
    unixSocketBind: ["sessionTemp", { dir: alias }, { dir: explicit }, { dir: temp }],
  } } });
  const input = { cwd: at("work"), defaults: { allow: [] }, network: false } as const;
  expect(planSpec(made.plan(input)).unixSocketBind).toEqual([]);
  const request = { allow: ["broker"] };
  const missingTemp = made.plan({ ...input, request });
  expect(missingTemp.refusals).toEqual([{ code: "adapter", message: expect.stringContaining("no private session temp") }]);
  const plan = made.plan({ ...input, request, sessionTemp: temp, writes: [{ path: temp, from: "temp" }] });
  const adapter = nono({ platform: "darwin" });
  expect(() => admit(plan, adapter, () => undefined)).toThrow(/box.use@broker/);
  const socket = at("host.sock");
  const admitted = admit(plan, adapter, (rule) => rule, { sockets: [socket] });
  const expected = [temp, explicit].map((dir) => ({ dir, from: "profile:broker" }));
  expect(BoxManifestSchema.parse(boxManifest(plan, admitted.rules, admitted.manifest))).toMatchObject({
    unixSocketBind: expected,
    policy: { unixSocketBind: [temp, explicit], net: [] },
  });
  expect(planSpec(plan).listen).toBeUndefined();
  expect(adapter.manifest(admitted.spec).flags).toEqual(expect.arrayContaining([
    "--allow-unix-socket", socket, "--allow-unix-socket-dir-bind", temp, explicit, "--block-net",
  ]));
  expect(adapter.manifest(admitted.spec).flags.filter((flag) => flag === "--allow-unix-socket-dir-bind")).toHaveLength(2);
  expect(() => admit(plan, srt({ platform: "darwin" }), (rule) => rule)).toThrow(/srt cannot restrict Unix socket bind/);
  expect(() => admit(plan, nono({ platform: "linux" }), (rule) => rule)).toThrow(/cannot guarantee direct-child/);
});

test("socket bind cannot add ordinary write access or overlap closed paths", () => {
  const work = at("work");
  const adapter = nono({ platform: "darwin" });
  expect(() => adapter.manifest(boxSpec({ cwd: work, unixSocketBind: [work] }))).toThrow(/separate filesystem write grant/);
  const spec = { cwd: work, write: [work], unixSocketBind: [work] };
  expect(() => adapter.manifest(boxSpec({ ...spec, closed: [at("work", "closed")] }))).toThrow(/closed/);
  expect(() => adapter.manifest(boxSpec({ ...spec, closed: [root] }))).toThrow(/closed/);
  expect(() => adapter.manifest(boxSpec({ ...spec, unixSocketBind: [at("codex", "auth.json")] }))).toThrow(/existing directory/);
  expect(adapter.manifest(boxSpec({ ...spec, unixSocketBind: [] })).flags).not.toContain("--allow-unix-socket-dir-bind");
});

test("nono refuses socket bind before invoking a wrapper without the scoped flag", async () => {
  const dir = at("work");
  const adapter = nono({ platform: "darwin", binary: "/usr/bin/true" });
  await expect(adapter.launch(boxSpec({ cwd: dir, write: [dir], unixSocketBind: [dir] }), ["/bin/sh"])).rejects.toThrow(
    /installed nono does not support --allow-unix-socket-dir-bind/,
  );
});

test("a TCP listener comes only from a selected profile and retains its origin", () => {
  const made = sandbox({ profiles: { service: { listen: LOOPBACK } } });
  made.install("server", { listen: LOOPBACK, net: ["registry.example"] });
  const input = { cwd: at("work"), defaults: { allow: [{ net: "127.0.0.1" }] }, network: true } as const;
  const outbound = made.plan(input);
  expect(outbound.net).toEqual([{ host: "127.0.0.1", from: "host" }]);
  expect(outbound.listen).toBeUndefined();
  expect(planSpec(outbound).listen).toBeUndefined();

  const named = made.plan({ ...input, request: { allow: ["service"] } });
  expect(named.listen).toEqual({ ...LOOPBACK, from: "profile:service" });
  expect(named.rules).toEqual(["box.use@service"]);

  const owned = made.plan({ ...input, owner: "server", request: { only: [] } });
  expect(owned.listen).toEqual({ ...LOOPBACK, from: "harness:server" });
  expect(owned.net).toEqual([{ host: "registry.example", from: "harness:server" }]);
  expect(owned.rules).toEqual([]);

  const disabled = made.plan({ ...input, owner: "server", request: { only: [] }, network: false });
  expect(disabled.listen).toBeUndefined();
  expect(disabled.net).toEqual([]);
  expect(disabled.refusals).toMatchObject([{ code: "no-network", message: expect.stringContaining("harness:server") }]);
});

test("TCP listener declarations allow exact loopback addresses and bounded ports", () => {
  const valid = { host: "::1", port: 65535 } as const;
  expect(LoopbackListenSchema.parse(valid)).toEqual(valid);
  for (const listen of [
    { host: "localhost", port: 80 },
    { host: "0.0.0.0", port: 80 },
    { host: "::", port: 80 },
    { host: "127.0.0.1", port: -1 },
    { host: "127.0.0.1", port: 65536 },
    { host: "127.0.0.1", port: 1.5 },
    { ...LOOPBACK, protocol: "udp" },
  ]) {
    expect(LoopbackListenSchema.safeParse(listen).success).toBe(false);
  }
  expect(() => resolveProfile({ listen: { ...LOOPBACK, port: -1 } }, "invalid", { home: "/home", env: {} }))
    .toThrow("profile invalid: invalid TCP loopback listener");
});

test("a box with conflicting TCP listener requirements refuses the combined plan", () => {
  const made = sandbox({ profiles: { service: { listen: { host: "::1", port: 8000 } } } });
  made.install("server", { listen: LOOPBACK });
  const plan = made.plan({ cwd: at("work"), defaults: { allow: ["service"] }, owner: "server", network: true });
  expect(plan.refusals[0]?.message).toContain("TCP [::1]:8000");
  expect(plan.refusals[0]?.message).toContain("harness:server");
});

test("admission requires an exact applied listener and records its provenance", () => {
  const made = sandbox();
  made.install("server", { listen: LOOPBACK });
  const input = { cwd: at("work"), defaults: { allow: [] }, network: true } as const;
  const plan = made.plan({ ...input, owner: "server" });
  const backend = (listen?: LoopbackListen): Sandbox => ({
    name: "gondolin",
    class: "vm",
    available: async () => true,
    manifest: (spec) => ({
      sandbox: "gondolin",
      cwd: spec.cwd,
      env: spec.env,
      policy: { read: { only: [] }, write: [], devices: [], net: [], ...(listen === undefined ? {} : { listen }) },
    }),
    launch: async () => { throw new Error("admission must never spawn"); },
  });
  expect(() => admit(plan, backend(), () => undefined)).toThrow(BoxRefused);
  expect(() => admit(plan, backend({ ...LOOPBACK, port: 8090 }), () => undefined)).toThrow(BoxRefused);
  const admitted = admit(plan, backend(LOOPBACK), () => undefined);
  expect(admitted.spec.listen).toEqual({ ...LOOPBACK, from: "harness:server" });
  const manifest = BoxManifestSchema.parse(boxManifest(plan, admitted.rules, admitted.manifest));
  expect(manifest.listen).toEqual(admitted.spec.listen);
  expect(manifest.policy.listen).toEqual(LOOPBACK);
  const bare = made.plan(input);
  expect(() => admit(bare, backend(LOOPBACK), () => undefined)).toThrow(BoxRefused);
  const legacy = admit(bare, backend(), () => undefined);
  expect(BoxManifestSchema.parse(boxManifest(bare, legacy.rules, legacy.manifest)).listen).toBeUndefined();
});

test("a profile is paths or a function of the machine, and bin finds a program, its real path and its package", () => {
  const plain = resolveProfile({ read: ["~/.gitconfig"], write: ["/x/cache"] }, "plain", { home: "/home/u", env: {} });
  expect(plain).toEqual({ read: ["/home/u/.gitconfig"], write: ["/x/cache"], net: [], programs: [] });
  const found = resolveProfile(({ bin }) => ({ read: bin("tool") }), "found", { home: "/home/u", env: { PATH: at("bin") } });
  const pkg = at("lib", "node_modules", "@acme", "tool");
  expect(found.read).toEqual([at("bin", "tool"), join(pkg, "bin", "tool.js"), pkg]);
  expect(found.programs).toEqual(found.read);
  expect(resolveProfile(({ bin }) => ({ read: bin("absent") }), "absent", { home: "/h", env: { PATH: at("bin") } }).read).toEqual([]);
  expect(() => resolveProfile({ read: ["relative/place"] }, "bad", { home: "/h", env: {} })).toThrow(/neither absolute nor under ~/);
});

test("a program reached through a directory link keeps both paths without granting the parent", () => {
  const parent = at("programs");
  symlinkSync(at("bin"), parent);
  const named = join(parent, "tool");
  const made = sandbox();
  made.install("runner", ({ bin }) => ({ read: bin(named) }));
  const plan = made.plan({ cwd: at("work"), defaults: { allow: [] }, owner: "runner", network: false });
  expect(allows(plan, named, "read")).toBe(true);
  expect(allows(plan, at("bin", "tool"), "read")).toBe(true);
  expect(allows(plan, parent)).toBe(false);
  expect(allows(plan, at("bin"))).toBe(false);
});

test("the catalog holds git, node, bun, npm, cargo and uv; a host adds and replaces profiles, with names it can check", () => {
  expect(Object.keys(catalog).sort()).toEqual(["bun", "cargo", "git", "node", "npm", "uv"]);
  expect(sandbox().names()).toEqual(["git", "node", "bun", "npm", "cargo", "uv"]);
  const own = sandbox({ profiles: { pnpm: { write: ["~/Library/pnpm/store"] }, git: { read: ["/etc/gitconfig"] } } });
  expect(own.names()).toContain("pnpm");
  const plan = own.plan({ cwd: at("work"), defaults: { allow: ["git", "pnpm"] }, network: false });
  expect(allows(plan, join(homedir(), "Library", "pnpm", "store"), "write")).toBe(true);
  expect(allows(plan, "/private/etc/gitconfig") || allows(plan, "/etc/gitconfig")).toBe(true);
  expect(() => sandbox({ profiles: { "Bad Name": {} } })).toThrow(/profile name/);
});

test("a box gets the paths of what it takes, and every other profile's paths but programs are closed to it", () => {
  const made = host();
  const plan = made.plan({ cwd: at("work"), defaults: { allow: ["project", "tool"] }, owner: "pi", network: true });
  expect(allows(plan, at("work"), "write")).toBe(true);
  expect(plan.paths.find((need) => need.path === at("tool-cache"))).toEqual({ path: at("tool-cache"), mode: "write", from: "profile:tool" });
  expect(plan.paths.find((need) => need.path === at("pi"))).toEqual({ path: at("pi"), mode: "write", from: "harness:pi" });
  // The codex installations are not this box's: their home is closed, under the name of each.
  expect(plan.closed).toContainEqual({ path: at("codex"), from: "harness:codex-luna" });
  expect(plan.closed).toContainEqual({ path: at("codex"), from: "harness:codex-sol" });
  expect(plan.net).toEqual([]);

  const other = made.plan({ cwd: at("work"), defaults: { allow: ["project"] }, owner: "codex-luna", network: true });
  // A box that does not take the tool finds its places closed, but not its program.
  expect(closes(other, at("tool-cache"))).toBe(true);
  expect(closes(other, at("tool.conf"))).toBe(true);
  expect(closes(other, at("bin", "tool"))).toBe(false);
  // Two installations share a home: what one takes, the other's profile does not close.
  expect(closes(other, at("codex"))).toBe(false);
  expect(closes(other, at("pi"))).toBe(true);
  expect(other.net).toEqual([{ host: "api.openai.com", from: "harness:codex-luna" }]);
});

test("a path asked for never opens a place another profile keeps: the box is refused, naming whose place it is", () => {
  const made = host();
  const plan = made.plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: [{ read: at("codex", "auth.json") }, { write: at("tool-cache", "x") }] }, owner: "pi", network: false });
  expect(codes(plan.refusals)).toEqual(["closed", "closed"]);
  expect(plan.refusals[0]?.message).toContain("harness:codex-luna");
  expect(plan.refusals[1]?.message).toContain("take the profile tool");
  // A tree that holds a closed place is no refusal of the plan: it is the sandbox's to hold or refuse.
  const wide = made.plan({ cwd: at("work"), defaults: { allow: [{ read: root }] }, owner: "pi", network: false });
  expect(wide.refusals).toEqual([]);
  expect(allows(wide, root, "read")).toBe(true);
  expect(closes(wide, at("codex"))).toBe(true);
});

test("the closed list is closed unless a place in it is asked for by name, and niwa's own places are added to it", () => {
  const made = sandbox({ closed: [at("vault")] });
  const ssh = realpathSync(homedir()) + "/.ssh";
  const plain = made.plan({ cwd: at("work"), defaults: { allow: [{ read: "~" }] }, closed: [{ path: at("niwa", "journal.db"), from: "niwa" }], network: false });
  expect(plain.closed).toContainEqual({ path: ssh, from: "closed" });
  expect(plain.closed).toContainEqual({ path: at("vault"), from: "closed" });
  expect(plain.closed).toContainEqual({ path: at("niwa", "journal.db"), from: "niwa" });
  // Named, it opens; it is never the default's to give, so a call needs the rule even under `~`.
  const asked = made.plan({ cwd: at("work"), defaults: { allow: [{ read: "~" }] }, request: { allow: [{ read: "~/.ssh" }] }, network: false });
  expect(closes(asked, ssh)).toBe(false);
  expect(asked.rules).toEqual([`box.read@${ssh}`]);
});

test("allow adds to the host's default and only replaces it; what goes beyond the default names the rule it needs", () => {
  const made = host();
  const defaults = { allow: ["project", "tool", { read: at("data") }] } as const;
  const within = made.plan({ cwd: at("work"), defaults, request: { allow: [{ read: at("data", "set") }, { write: at("work", "out") }, "tool"] }, network: false });
  expect(within.rules).toEqual([]);
  expect(within.request.items.map((one) => one.from)).toEqual(["host", "host", "host", "call", "call", "call"]);
  const beyond = made.plan({ cwd: at("work"), defaults, request: { allow: ["npm", { write: at("data") }, { read: at("my place") }, "toolchains"] }, network: false });
  expect(beyond.rules).toEqual(["box.use@npm", `box.write@${at("data")}`, `box.read@${at("my%20place")}`, "box.use@toolchains"]);
  const only = made.plan({ cwd: at("work"), defaults, request: { only: [{ read: "." }] }, network: false });
  expect(only.request).toEqual({ mode: "only", items: [{ item: { read: "." }, from: "call" }] });
  expect(only.rules).toEqual([]);
  expect(allows(only, at("work"), "read")).toBe(true);
  expect(allows(only, at("work"), "write")).toBe(false);
  expect(allows(only, at("tool-cache"))).toBe(false);
  expect(closes(only, at("tool-cache"))).toBe(true);
});

test("a relative path is read from the working directory, and a link is followed before anything is decided", () => {
  const made = host();
  symlinkSync(at("codex"), at("work", "alias"));
  try {
    const plan = made.plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: [{ write: "../artifacts" }, { read: "alias/auth.json" }] }, owner: "pi", network: false });
    expect(allows(plan, at("artifacts"), "write")).toBe(true);
    expect(codes(plan.refusals)).toEqual(["closed"]);
  } finally {
    rmSync(at("work", "alias"));
  }
});

test("toolchains reads the PATH and the catalog's programs, and leaves out what holds the home or a closed place", () => {
  const made = host();
  const plan = made.plan({ cwd: at("work"), defaults: { allow: ["toolchains"] }, network: false });
  expect(plan.paths).toContainEqual({ path: at("bin"), mode: "read", from: "toolchains" });
  expect(plan.paths).toContainEqual({ path: at("lib", "node_modules", "@acme", "tool"), mode: "read", from: "toolchains" });
  process.env["PATH"] = `${at("bin")}:${homedir()}:${at("codex")}`;
  try {
    const skipped = made.plan({ cwd: at("work"), defaults: { allow: ["toolchains"] }, owner: "pi", network: false }).skipped;
    expect(skipped.map((one) => one.place)).toEqual([realpathSync(homedir()), at("codex")]);
  } finally {
    process.env["PATH"] = at("bin");
  }
});

test("a box with no network refuses a host asked of it, and leaves out the hosts of its profiles, saying so", () => {
  const made = host();
  const plan = made.plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: [{ net: "example.com" }] }, owner: "codex-luna", network: false });
  expect(codes(plan.refusals)).toEqual(["no-network"]);
  expect(plan.net).toEqual([]);
  expect(plan.skipped).toContainEqual({ place: "api.openai.com", from: "harness:codex-luna", why: "this box reaches no network" });
  const reaching = made.plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: [{ net: "example.com" }] }, network: true });
  expect(reaching.net).toEqual([{ host: "example.com", from: "call" }]);
  expect(reaching.rules).toEqual(["box.net@example.com"]);
});

test("an unknown name is refused with the names a box may ask for", () => {
  const plan = host().plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: ["yarn" as "npm"] }, network: false });
  expect(codes(plan.refusals)).toEqual(["unknown-profile"]);
  expect(plan.refusals[0]?.message).toContain("bun, cargo, git, node, npm, tool, uv");
});

test("admit refuses with every reason at once: the plan's own, each missing rule, and what the sandbox cannot hold", () => {
  const made = host();
  const plan = made.plan({
    cwd: at("work"),
    defaults: { allow: [] },
    request: { allow: ["yarn" as "npm", "npm", { read: root }] },
    owner: "pi",
    network: false,
  });
  let refused: BoxRefused | undefined;
  try {
    admit(plan, nono(), () => undefined);
  } catch (error) {
    refused = error as BoxRefused;
  }
  expect(refused).toBeInstanceOf(BoxRefused);
  expect(codes(refused?.reasons ?? [])).toEqual(["unknown-profile", "not-granted", "not-granted", "adapter", "adapter", "adapter"]);
  expect(refused?.reasons.filter((reason) => reason.code === "not-granted").map((reason) => reason.rule)).toEqual(["box.use@npm", `box.read@${root}`]);
  expect(refused?.message).toContain(`${at("codex")} closed inside ${root}`);
  // The grant's rules that cover what the plan needs are the ones the box took.
  const granted = made.plan({ cwd: at("work"), defaults: { allow: [] }, request: { allow: ["npm"] }, network: false });
  const held = admit(granted, nono(), (rule) => (rule.startsWith("box.use@") ? "box.use@*" : undefined));
  expect(held.rules).toEqual(["box.use@*"]);
});

test("nono grants a file as a file and a directory as a directory, and refuses a grant inside a closed directory", () => {
  const made = nono().manifest(boxSpec({ cwd: at("work"), read: [at("codex", "auth.json"), at("bin")], write: [at("codex", "auth.json"), at("pi")], closed: [at("other")] }));
  expect(() => nono().manifest(boxSpec({ cwd: at("codex", "child"), closed: [at("codex")] }))).toThrow(BoxRefused);
  expect(made.flags).toEqual(expect.arrayContaining(["--read-file", at("codex", "auth.json"), "--read", at("bin"), "--allow-file", at("codex", "auth.json"), "--allow", at("pi")]));
});

test("srt closes a place to reading and writing, and refuses to open a place inside a closed one", () => {
  const settings = srt().manifest(boxSpec({ cwd: at("work"), write: [at("work")], closed: [at("work", "secret")] })).settings;
  expect(settings.filesystem.denyRead).toEqual([{ path: at("work", "secret"), literal: true }]);
  expect(settings.filesystem.denyWrite).toEqual([{ path: at("work", "secret"), literal: true }]);
  expect(() => srt().manifest(boxSpec({ cwd: at("work"), read: [at("codex", "auth.json")], write: [at("codex", "x")], closed: [at("codex")] }))).toThrow(
    expect.objectContaining({ reasons: [expect.objectContaining({ code: "adapter" }), expect.objectContaining({ code: "adapter" })] }),
  );
});

test("the manifest records the request, the paths with their origins, the rules taken and the policy, the environment by name", () => {
  const made = host();
  const plan = made.plan({ cwd: at("work"), defaults: { allow: ["project"] }, request: { allow: ["tool"] }, owner: "pi", network: false });
  const adapter: Sandbox = srt();
  const admitted = admit(plan, adapter, () => "box.use@tool", { env: { HOME: homedir(), SECRET_TOKEN: "value" } });
  const manifest = boxManifest(plan, admitted.rules, admitted.manifest);
  expect(manifest.sandbox).toBe("srt");
  expect(manifest.request.items).toEqual([{ item: "project", from: "host" }, { item: "tool", from: "call" }]);
  expect(manifest.paths).toContainEqual({ path: at("pi"), mode: "write", from: "harness:pi" });
  expect(manifest.rules).toEqual(["box.use@tool"]);
  expect(manifest.env.sort()).toEqual(["HOME", "PATH", "SECRET_TOKEN"]);
  expect(JSON.stringify(manifest)).not.toContain("value");
  expect("except" in manifest.policy.read).toBe(true);
});

test("a command line item is read as a mode and a place, or as a name", () => {
  expect(itemOf("bun")).toBe("bun");
  expect(itemOf("write:../artifacts")).toEqual({ write: "../artifacts" });
  expect(itemOf("read:.")).toEqual({ read: "." });
  expect(itemOf("net:crates.io")).toEqual({ net: "crates.io" });
});

test("a runtime or a package a profile names through bin stays open to a box whose project holds it", () => {
  const made = sandbox();
  const pkg = at("repo", "node_modules", "@vendor", "sdk");
  mkdirSync(pkg, { recursive: true });
  made.install("claude", ({ bin }) => ({ read: [...bin(pkg)], write: [at("claude-home")] }));
  const plan = made.plan({ cwd: at("repo"), defaults: { allow: ["project"] }, network: false });
  expect(closes(plan, pkg)).toBe(false);
  expect(closes(plan, at("claude-home"))).toBe(true);
});

test("a program found through a link keeps the link's name in the box beside its target", () => {
  const plan = host().plan({ cwd: at("work"), defaults: { allow: ["tool"] }, network: false });
  expect(allows(plan, at("bin", "tool"), "read")).toBe(true);
  expect(allows(plan, at("lib", "node_modules", "@acme", "tool", "bin", "tool.js"), "read")).toBe(true);
});

test("a box whose working directory nobody chose is not given it to write, and says why", () => {
  const plan = host().plan({ cwd: at("work"), defaults: { allow: ["project"] }, noProject: "the session names no working directory", network: false });
  expect(allows(plan, at("work"), "write")).toBe(false);
  expect(plan.skipped).toEqual([{ place: at("work"), from: "project", why: "the session names no working directory" }]);
});

test("a box that writes its directory gets what git keeps of it outside: a worktree's own git directory, and the shared objects and refs", () => {
  const main = at("main");
  const tree = at("trees", "wt1");
  mkdirSync(main);
  const git = (args: string[]) => {
    const made = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: main, env: { ...process.env, PATH: savedPath, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stderr: "pipe",
    });
    if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  };
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "fixture"]);
  git(["worktree", "add", "-qb", "fixture", tree]);
  const input = { cwd: tree, defaults: { allow: ["project"] }, network: false } as const;
  const worktree = { id: "wt1", path: tree, repo: main };
  const common = join(main, ".git");
  const admin = join(common, "worktrees", "wt1");
  for (const binding of [undefined, { ...worktree, id: "unrelated" }]) {
    const denied = host().plan({ ...input, ...(binding && { worktree: binding }) });
    expect(denied.refusals[0]?.code).toBe("not-granted");
    if (!binding) expect(denied.refusals[0]?.message).toContain(JSON.stringify({ read: admin }));
    expect(denied.paths.some((need) => need.from === "repository")).toBe(false);
  }
  const adminOnly = host().plan({ ...input, request: { allow: [{ read: admin }] } });
  expect(adminOnly.refusals[0]?.message).toContain("common Git directory " + common + " needs explicit read access");
  const unapproved = host().plan({ ...input, request: { allow: [{ read: admin }] }, holdsRule: () => false });
  expect(unapproved.refusals[0]?.message).toContain("checkout Git directory " + admin);
  expect(unapproved.refusals[0]?.message).not.toContain("common Git directory");
  for (const request of [{ allow: [{ read: common }] }, { only: [{ write: "." }, { read: common }] }, { only: [{ read: "." }, { read: common }] }]) {
    const external = host().plan({ ...input, request, holdsRule: () => true });
    expect(external.refusals).toEqual([]);
    expect(external.rules).toContain("box.read@" + common);
    expect(external.paths.filter((need) => need.from === "repository" || need.path.startsWith(common)))
      .toEqual([{ path: common, mode: "read", from: "call" }]);
    expect(() => admit(external, srt(), () => undefined)).toThrow("box.read@" + common);
    const confined = admit(external, nono(), (rule) => rule);
    expect(confined.manifest.policy.read).toEqual({ only: expect.arrayContaining([common]) });
    expect(confined.manifest.policy.write.some((path) => path.startsWith(common))).toBe(false);
  }
  for (const path of [join(tree, ".git"), admin, join(admin, "commondir")]) {
    const closed = sandbox().plan({ ...input, request: { allow: [{ read: common }] },
      closed: [{ path, from: "niwa" }] });
    expect(closed.refusals).toEqual([{ code: "closed", message: expect.stringContaining(path) }]);
  }
  const explicit = host().plan({ ...input, request: { allow: [{ write: join(main, ".git") }] } });
  expect(explicit.refusals).toEqual([]);
  expect(explicit.paths.some((need) => need.from === "repository")).toBe(false);
  expect(() => admit(explicit, nono(), () => undefined)).toThrow(BoxRefused);
  const plan = host().plan({ ...input, worktree });
  expect(plan.refusals).toEqual([]);
  expect(plan.paths).toContainEqual({ path: join(main, ".git", "worktrees", "wt1"), mode: "write", from: "repository" });
  expect(plan.paths).toContainEqual({ path: join(main, ".git"), mode: "read", from: "repository" });
  for (const part of ["objects", "refs", "logs"]) expect(plan.paths).toContainEqual({ path: join(main, ".git", part), mode: "write", from: "repository" });
  // Its configuration and hooks are read, never written.
  expect(allows(plan, join(main, ".git"), "write")).toBe(false);
  // A box that only reads its directory gets nothing of the repository.
  const reading = host().plan({ cwd: tree, worktree, defaults: { allow: [{ read: "." }] }, network: false });
  expect(reading.paths.some((need) => need.from === "repository")).toBe(false);
  // A plain subdirectory carries no independent grant on its parent.
  mkdirSync(join(main, "pkg"));
  const inner = host().plan({ cwd: join(main, "pkg"), defaults: { allow: ["project"] }, network: false });
  expect(inner.paths).not.toContainEqual({ path: join(main, ".git"), mode: "write", from: "repository" });

  const outside = at("outside-git");
  mkdirSync(outside);
  writeFileSync(join(admin, "commondir"), outside + "\n");
  const separate = host().plan({ ...input, request: { allow: [{ read: admin }] } });
  expect(separate.refusals[0]?.message).toContain(JSON.stringify({ read: outside }));
  const both = host().plan({ ...input, request: { allow: [{ read: admin }, { read: outside }] } });
  expect(both.refusals).toEqual([]);
  expect(both.paths.some((need) => need.from === "repository")).toBe(false);
  writeFileSync(join(outside, "commondir"), "/ungranted\n");
  const alias = join(common, "worktrees", "alias");
  symlinkSync(outside, alias);
  writeFileSync(join(tree, ".git"), "gitdir: " + alias + "\n");
  const redirected = host().plan({ ...input, request: { allow: [{ read: common }] } });
  expect(redirected.refusals[0]?.message).toContain("cannot verify checkout pointer");
  expect(redirected.refusals[0]?.message).not.toContain("/ungranted");
});

test("the toolchains read what each profile of the catalog reads, and nothing it writes, nor anything of a host's profile", () => {
  const home = realpathSync(homedir());
  const plan = host().plan({ cwd: at("work"), defaults: { allow: ["toolchains"] }, owner: "pi", network: false });
  expect(plan.paths).toContainEqual({ path: join(home, ".gitconfig"), mode: "read", from: "toolchains" });
  expect(closes(plan, join(home, ".gitconfig"))).toBe(false);
  // What a tool writes stays its own: npm's configuration and git's stored credentials may hold tokens.
  expect(closes(plan, join(home, ".npmrc"))).toBe(true);
  expect(closes(plan, join(home, ".git-credentials"))).toBe(true);
  expect(closes(plan, join(home, ".config", "git", "credentials"))).toBe(true);
  // A host's own profile is not the toolchains' to open, nor is an installation's.
  expect(closes(plan, at("tool.conf"))).toBe(true);
  expect(closes(plan, at("codex"))).toBe(true);
  const bare = host().plan({ cwd: at("work"), defaults: { allow: [] }, owner: "pi", network: false });
  expect(closes(bare, join(home, ".gitconfig"))).toBe(true);
});

test("the cwd and required writes respect installation boundaries", () => {
  const cwd = at("pi", "workspace");
  const input = { cwd, defaults: { allow: [] }, network: false, writes: [{ path: cwd, from: "cwd" }] };
  expect(host().plan({ ...input, owner: "pi" }).refusals).toEqual([]);
  expect(host().plan({ ...input, owner: "codex-sol" }).refusals[0]).toMatchObject({
    code: "closed", message: expect.stringContaining("Choose a cwd outside that home, or start the owning harness pi"),
  });
});


test("opening a closed path for reading preserves its write restriction", () => {
  const path = at("archive");
  const boxes = sandbox({ closed: [path] });
  const input = { cwd: path, defaults: { allow: [{ read: path }] }, writes: [{ path, from: "cwd" }], network: false };
  expect(boxes.plan(input).refusals[0]?.code).toBe("closed");
  expect(boxes.plan({ ...input, defaults: { allow: [{ write: path }] } }).refusals).toEqual([]);
});

test("admission checks the host socket against the resolved profile boundaries", () => {
  const plan = host().plan({ cwd: at("work"), defaults: { allow: [] }, network: false });
  expect(() => admit(plan, srt({ platform: "darwin" }), () => undefined, { sockets: [at("pi", "socket")] })).toThrow(BoxRefused);
});
