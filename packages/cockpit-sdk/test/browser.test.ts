// The SDK runs in the browser: its own code, and what it takes from the other niwa packages,
// must bundle without Node or Bun modules. Shared libraries stay external, as they are in the
// cockpit, where one copy serves every module.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const SHARED = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@tanstack/*",
  "zustand",
  "zustand/*",
  "zod",
  "@base-ui/*",
  "@pierre/*",
  "@streamdown/*",
  "streamdown",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "tailwind-merge",
  "use-stick-to-bottom",
];

test("the entry bundles for the browser with the niwa packages it uses inlined", async () => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const result = await Bun.build({ entrypoints: [entry], target: "browser", external: SHARED });
  expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code).not.toMatch(/["'](node|bun):/);
  // The kit is inlined, so the check covers it too.
  expect(code).toContain("id-chip");
});
