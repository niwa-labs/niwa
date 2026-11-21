// The profile of an mcode installation, and the proof of it.
//
// Offline: the profile is the program, the runtime it runs on and the home of its profile. Live
// (NIWA_LIVE=1, nono and an mcode on this machine): a session runs one turn in a nono box closed to
// reading, with nothing but that profile. MCODE_BIN selects the upstream executable. For the fork,
// NIWA_MCODE_LINEAGE=fork selects ncode, NCODE_BIN overrides its launcher and NCODE_PROFILE
// selects the account (default astrum). MCODE_MODEL and MCODE_NET select the model and hosts.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { profileConformance } from "@niwa-labs/harness";
import { nono, resolveProfile } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { mcodeKind, ncodeKind } from "../src/index.ts";

test("an installation's profile is its program, the runtime it runs on, and the home of its profile", () => {
  const binding = mcodeKind.bind({ id: "mcode-a", home: "/srv/minimax", control: { binary: "/bin/sh" }, net: ["agent.example.com"] });
  const profile = resolveProfile(binding.profile ?? {}, "mcode-a", { home: "/home/u", env: { PATH: "/nowhere" } });
  expect(profile.read).toEqual(["/bin/sh"]);
  expect(profile.write).toEqual(["/srv/minimax"]);
  expect(profile.net).toEqual(["agent.example.com"]);
  expect(mcodeKind.profile.status).toBe("admitted");
  expect(ncodeKind.profile.status).toBe("verified");
});

test("a versioned ncode launcher reads only its current package and pinned Node", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ncode-install-")));
  try {
    const prefix = join(root, "store");
    const alias = join(root, "active");
    const revision = "a".repeat(40);
    const relative = join("installs", "ncode", revision, "lib", "node_modules", "@niwa-labs", "ncode");
    const pkg = join(alias, relative);
    const node = join(root, "runtime", "bin", "node");
    const launcher = join(alias, "bin", "ncode");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(prefix, alias);
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(root, "runtime", "bin"), { recursive: true });
    mkdirSync(join(root, "runtime", "include", "node"), { recursive: true });
    writeFileSync(join(root, "runtime", "include", "node", "node_version.h"), "");
    writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@niwa-labs/ncode" }));
    writeFileSync(join(pkg, "release.json"), JSON.stringify({ revision }));
    writeFileSync(join(pkg, "cli.js"), "");
    writeFileSync(launcher, `#!/bin/sh\nMCODE_BUILD_ID=${revision}\nexec ${node} ${pkg}/cli.js "$@"\n`, { mode: 0o755 });
    const instance = ncodeKind.bind({ id: "ncode-flash", profile: "astrum", control: { binary: launcher } });
    const resolved = () => resolveProfile(instance.profile!, "ncode-flash", { home: root, env: { PATH: "/absent" } });
    expect(new Set(resolved().read)).toEqual(new Set([launcher, realpathSync(launcher), pkg, realpathSync(pkg), node]));
    expect(resolved().write).toEqual([join(homedir(), ".minimax-astrum")]);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "unrelated" }));
    expect(resolved().read).toEqual([launcher, realpathSync(launcher)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const fork = process.env["NIWA_MCODE_LINEAGE"] === "fork";
const binary = (fork ? process.env["NCODE_BIN"] ?? process.env["MCODE_BIN"] : process.env["MCODE_BIN"]) ?? (fork ? "ncode" : "mcode");
const present = live && Bun.which(binary) !== null && (await nono().available());

test.skipIf(!present)(
  `a ${fork ? "ncode" : "mcode"} session runs a turn in a nono box with nothing but its installation's profile`,
  async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "mcode-profile-")));
    try {
      const kind = fork ? ncodeKind : mcodeKind;
      const id = fork ? "ncode-flash" : "mcode-flash";
      const binding = kind.bind({
        id,
        ...(fork ? { profile: process.env["NCODE_PROFILE"] ?? "astrum" } : { home: join(homedir(), ".minimax") }),
        model: process.env["MCODE_MODEL"] ?? "minimax/MiniMax-M3.1-Flash",
        net: (process.env["MCODE_NET"] ?? "agent.minimax.io").split(","),
        control: { binary },
      });
      const result = await profileConformance(binding, { cwd });
      expect(result.ended).toBe(true);
      expect(result.answered).toBe(true);
      expect(result.box.paths.every((need) => need.from === `harness:${id}` || need.from === "temp")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
