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

import { BoxRefused, admit, boxManifest, boxSpec, itemOf, nono, resolveProfile, sandbox, srt } from "@niwa-labs/sandbox";
import type { BoxRefusal, Sandbox } from "@niwa-labs/sandbox";
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

test("nono grants a file as a file and a directory as a directory, and keeps a place granted inside a closed one", () => {
  const made = nono().manifest(boxSpec({ cwd: at("work"), read: [at("codex", "auth.json"), at("bin")], write: [at("codex", "auth.json"), at("pi")], closed: [at("codex")] }));
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
