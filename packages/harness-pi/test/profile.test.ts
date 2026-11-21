// The profile of a pi installation, and the proof of it.
//
// Offline: the profile is the launcher, the managed install beside its real path with the runtime
// pi's installer puts in place, and the agent directory. Live (NIWA_LIVE=1, nono and `pi` on this
// machine): a session runs one turn in a nono box closed to reading, with nothing but that profile;
// the kind's profile is declared verified on that proof. The agent directory of the test is a copy
// of the real one's settings and extensions without its packages (the owner's packages are not
// pi's to need), the model is PI_MODEL (default `bifrost/zai/glm-5.3-flash`) and the hosts of its
// provider PI_NET (default `127.0.0.1`).

import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { profileConformance } from "@niwa-labs/harness";
import { nono, resolveProfile } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { piKind } from "../src/index.ts";

test("an installation's profile is its launcher, the install the launcher runs, its runtime, and its agent directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-profile-")));
  try {
    // A managed install: the launcher in <agent>/bin, the versions in <agent>/install, a link on the PATH.
    mkdirSync(join(root, "agent", "bin"), { recursive: true });
    mkdirSync(join(root, "agent", "install"));
    writeFileSync(join(root, "agent", "install", "current-version"), "1.0.0");
    writeFileSync(join(root, "agent", "bin", "pi"), "#!/bin/sh\n");
    chmodSync(join(root, "agent", "bin", "pi"), 0o755);
    mkdirSync(join(root, "path"));
    symlinkSync(join(root, "agent", "bin", "pi"), join(root, "path", "pi"));
    const binding = piKind.bind({ id: "pi-a", home: join(root, "agent"), net: ["127.0.0.1"] });
    const profile = resolveProfile(binding.profile ?? {}, "pi-a", { home: "/home/u", env: { PATH: join(root, "path") } });
    expect(profile.read.slice(0, 3)).toEqual([join(root, "path", "pi"), join(root, "agent", "bin", "pi"), join(root, "agent", "install")]);
    // The install is a program: no other box finds it closed.
    expect(profile.programs).toContain(join(root, "agent", "install"));
    expect(profile.write).toEqual([join(root, "agent")]);
    expect(profile.net).toEqual(["127.0.0.1"]);
    expect(piKind.profile.status).toBe("verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const present = live && Bun.which("pi") !== null && (await nono().available());

/** An agent directory of the test's own: the real one's settings, less its packages, and its extensions. */
function agentHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-agent-")));
  const real = join(homedir(), ".pi", "agent");
  const settings = JSON.parse(readFileSync(join(real, "settings.json"), "utf8")) as Record<string, unknown>;
  delete settings["packages"];
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  mkdirSync(join(home, "extensions"));
  cpSync(join(real, "extensions"), join(home, "extensions"), { recursive: true });
  return home;
}

test.skipIf(!present)(
  "a pi session runs a turn in a nono box with nothing but its installation's profile",
  async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-profile-cwd-")));
    const home = agentHome();
    try {
      const binding = piKind.bind({
        id: "pi",
        home,
        model: process.env["PI_MODEL"] ?? "bifrost/zai/glm-5.3-flash",
        net: (process.env["PI_NET"] ?? "127.0.0.1").split(","),
      });
      const result = await profileConformance(binding, { cwd });
      expect(result.ended).toBe(true);
      expect(result.answered).toBe(true);
      expect(result.box.paths.every((need) => need.from === "harness:pi" || need.from === "temp")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  240_000,
);
