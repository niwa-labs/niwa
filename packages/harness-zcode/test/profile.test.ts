// The profile of a ZCode installation.
//
// The kind remains admitted. The installation may opt in to the broker's private socket bind.

import { expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { resolveProfile } from "@niwa-labs/sandbox";
import type { InstanceOptions } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { zcodeKind } from "../src/index.ts";

test("an installation's profile is its program, the runtime it runs on and its home, with the hosts the owner names", () => {
  const binding = zcodeKind.bind({ id: "zcode-a", home: "/srv/zcode", control: { binary: "/bin/sh" }, net: ["api.z.ai"] });
  const profile = resolveProfile(binding.profile ?? {}, "zcode-a", { home: "/home/u", env: { PATH: "/nowhere" } });
  expect(profile.read).toEqual(["/bin/sh"]);
  expect(profile.write).toEqual(["/srv/zcode"]);
  expect(profile.net).toEqual(["api.z.ai"]);
  expect(profile.unixSocketBind).toBeUndefined();
  expect(zcodeKind.profile.status).toBe("admitted");
});

test("an installation accepts mixed bind entries and retains legacy hosts and paths", async () => {
  const home = await realpath(process.cwd());
  const binding = zcodeKind.bind({
    id: "zcode-bind", home: "/srv/zcode", control: { binary: "/bin/sh" }, net: ["api.z.ai"],
    boxProfile: { unixSocketBind: ["sessionTemp", { dir: "~/ipc/../run" }] },
  });
  const profile = resolveProfile(binding.profile ?? {}, "zcode-bind", { home, env: { PATH: "/nowhere" } });
  expect(profile.unixSocketBind).toEqual(["sessionTemp", { dir: join(home, "run") }]);
  expect(profile.write).toEqual(["/srv/zcode"]);
  expect(profile.net).toEqual(["api.z.ai"]);
});

test("the profile grants the actual database directory when the installation links outside its home", async () => {
  const root = await realpath(await tempDir("zcode-storage-profile"));
  try {
    const home = join(root, "home");
    const target = join(root, "home-db");
    await mkdir(join(home, "cli"), { recursive: true });
    await mkdir(target);
    await symlink(target, join(home, "cli", "db"));
    const binding = zcodeKind.bind({ id: "zcode-linked", home });
    const profile = resolveProfile(binding.profile ?? {}, "zcode-linked", { home: root, env: {} });
    expect(profile.write).toEqual([home, target]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installation rejects invalid runtime bind options", () => {
  for (const entry of ["sessionTmp", { dir: "relative" }, { dir: "" }, { dir: "/bad\0path" }, { dir: "/ok", extra: true }]) {
    const boxProfile = { unixSocketBind: [entry] } as NonNullable<InstanceOptions["boxProfile"]>;
    expect(() => zcodeKind.bind({ id: "zcode-invalid", boxProfile })).toThrow(/unixSocketBind/);
  }
});
