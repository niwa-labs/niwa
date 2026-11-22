import { expect, test } from "bun:test";

import { MODE_PERMISSIONS, hasModePermissions } from "../src/permissions.ts";

test("mode verification checks each stored permission and preserves rule order", () => {
  const auto = MODE_PERMISSIONS.auto.map((rule) => ({ ...rule }));
  expect(hasModePermissions("auto", auto)).toBe(true);
  expect(hasModePermissions("full", MODE_PERMISSIONS.full)).toBe(true);
  expect(hasModePermissions("full", auto)).toBe(false);
  expect(hasModePermissions("auto", undefined)).toBe(false);
  // A later catch-all would take precedence over the file-tool allowances.
  expect(hasModePermissions("auto", auto.toReversed())).toBe(false);
  expect(hasModePermissions("auto", auto.map((rule) => ({ ...rule, resource: "changed" })))).toBe(false);
});
