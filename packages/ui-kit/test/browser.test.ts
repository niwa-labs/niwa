// The kit runs in the browser: its own code must not reach Node or Bun modules.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the entry bundles for the browser", async () => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const result = await Bun.build({ entrypoints: [entry], target: "browser", packages: "external" });
  expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code).not.toMatch(/from\s*["'](node:|bun:)/);
});
