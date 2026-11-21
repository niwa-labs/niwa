// The profile of a ZCode installation.
//
// Its program, the runtime it runs on and its home. It stays admitted: a ZCode session listens on a
// unix socket it makes in its temp directory, which a box closed to reading does not let it bind,
// so no session has run in one with this profile alone.

import { expect, test } from "bun:test";

import { resolveProfile } from "@niwa-labs/sandbox";

import { zcodeKind } from "../src/index.ts";

test("an installation's profile is its program, the runtime it runs on and its home, with the hosts the owner names", () => {
  const binding = zcodeKind.bind({ id: "zcode-a", home: "/srv/zcode", control: { binary: "/bin/sh" }, net: ["api.z.ai"] });
  const profile = resolveProfile(binding.profile ?? {}, "zcode-a", { home: "/home/u", env: { PATH: "/nowhere" } });
  expect(profile.read).toEqual(["/bin/sh"]);
  expect(profile.write).toEqual(["/srv/zcode"]);
  expect(profile.net).toEqual(["api.z.ai"]);
  expect(zcodeKind.profile.status).toBe("admitted");
});
