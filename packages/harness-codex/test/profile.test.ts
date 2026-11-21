// The profile of a Codex installation, and the proof of it.
//
// Offline: the profile is the installation's program, its home and the endpoints of its model and
// its sign-in. Live (NIWA_LIVE=1, nono and `codex` on this machine): a session of an installation
// runs one turn in a nono box closed to reading, with nothing but that profile; the kind's profile
// is declared verified on that proof. The model is the cheap one, `gpt-6-luna` unless CODEX_MODEL
// names another.

import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { profileConformance } from "@niwa-labs/harness";
import { nono, resolveProfile } from "@niwa-labs/sandbox";
import { live } from "@niwa-labs/testing";

import { codexKind } from "../src/index.ts";

test("an installation's profile is its program, its home, and the endpoints of its model and sign-in", () => {
  const binding = codexKind.bind({ id: "codex-a", home: "/srv/codex-a", control: { binary: "/bin/sh" } });
  const profile = resolveProfile(binding.profile ?? {}, "codex-a", { home: "/home/u", env: {} });
  expect(profile.write).toEqual(["/srv/codex-a"]);
  expect(profile.read).toContain("/bin/sh");
  expect(profile.programs).toContain("/bin/sh");
  expect(profile.net).toEqual(["api.openai.com", "chatgpt.com"]);
  expect(codexKind.profile.status).toBe("verified");
});

const present = live && Bun.which("codex") !== null && (await nono().available());

test.skipIf(!present)(
  "a Codex session runs a turn in a nono box with nothing but its installation's profile",
  async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "codex-profile-")));
    try {
      const binding = codexKind.bind({ id: "codex-luna", model: process.env["CODEX_MODEL"] ?? "gpt-6-luna" });
      const result = await profileConformance(binding, { cwd });
      expect(result.ended).toBe(true);
      expect(result.answered).toBe(true);
      expect(result.box.sandbox).toBe("nono");
      expect(result.box.paths.every((need) => need.from === "harness:codex-luna" || need.from === "temp")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
