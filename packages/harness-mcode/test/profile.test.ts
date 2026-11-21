// The profile of an mcode installation, and the proof of it.
//
// Offline: the profile is the program, the runtime it runs on and the home of its profile. Live
// (NIWA_LIVE=1, nono and an mcode on this machine): a session runs one turn in a nono box closed to
// reading, with nothing but that profile; the published build's profile is declared verified on
// that proof. MCODE_BIN names the program (default `mcode` on the PATH), MCODE_MODEL the model
// (default `minimax/MiniMax-M3.1-Flash`) and MCODE_NET the hosts of its endpoint (default
// `agent.minimax.io`); NIWA_MCODE_LINEAGE=fork runs the fork.

import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  expect(mcodeKind.profile.status).toBe("verified");
  expect(ncodeKind.profile.status).toBe("admitted");
});

const binary = process.env["MCODE_BIN"] ?? "mcode";
const present = live && Bun.which(binary) !== null && (await nono().available());

test.skipIf(!present)(
  "an mcode session runs a turn in a nono box with nothing but its installation's profile",
  async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "mcode-profile-")));
    try {
      const kind = process.env["NIWA_MCODE_LINEAGE"] === "fork" ? ncodeKind : mcodeKind;
      const binding = kind.bind({
        id: "mcode-flash",
        home: join(homedir(), ".minimax"),
        model: process.env["MCODE_MODEL"] ?? "minimax/MiniMax-M3.1-Flash",
        net: (process.env["MCODE_NET"] ?? "agent.minimax.io").split(","),
        control: { binary },
      });
      const result = await profileConformance(binding, { cwd });
      expect(result.ended).toBe(true);
      expect(result.answered).toBe(true);
      expect(result.box.paths.every((need) => need.from === "harness:mcode-flash" || need.from === "temp")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
