// A test file that leaves its temporary directories behind: the failing test never reaches its cleanup.
// It is run by `bun test` from temp-dirs.test.ts, not by the suite.

import { expect, test } from "bun:test";

import { tempDir, tempHome } from "@niwa-labs/testing";

test("fails before its cleanup", async () => {
  const home = await tempHome();
  await tempDir("leaky");
  expect(home.path).toBe("never");
});
