import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { ADAPTER_PATCHES, patchAdapter } from "../../src/code/acp/adapter-patch.ts";

/** The source of the adapter build niwa pins, as the runtime would load it. */
async function pinnedSource(): Promise<{ path: string; source: string }> {
  const require = createRequire(import.meta.url);
  const path = join(dirname(require.resolve("@zed-industries/claude-code-acp/package.json")), "dist", "acp-agent.js");
  return { path, source: await Bun.file(path).text() };
}

test("every line niwa changes is in the pinned adapter, once", async () => {
  const { source } = await pinnedSource();
  for (const patch of ADAPTER_PATCHES) expect(source.split(patch.from).length - 1).toBe(1);
});

test("the patched adapter takes its tools from _meta.niwa.tools and no longer gives the preset alone", async () => {
  const { path, source } = await pinnedSource();
  const patched = patchAdapter(source, path);
  for (const patch of ADAPTER_PATCHES) {
    expect(patched).toContain(patch.to);
    expect(patched.replace(patch.to, "")).not.toContain(patch.from);
  }
});

test("a build without one of the lines does not load", () => {
  const [first, second] = ADAPTER_PATCHES;
  expect(() => patchAdapter(first!.from, "acp-agent.js")).toThrow(second!.what);
});
