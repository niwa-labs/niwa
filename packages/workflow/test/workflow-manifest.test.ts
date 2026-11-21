// The manifest of a registered version says what the version is: its entry, the hash of every file of its
// source closure, the data files it reads, the packages it imports by name with their versions, and the
// version of the script ABI it was registered for. A start and a run read the copy through it: a copy that
// is not what its manifest says, or one made for another ABI, does not run.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SCRIPT_ABI } from "@niwa-labs/script";
import { createNiwa, requests, tempHome, timers } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { workflow, workflowRegister, workflowStart, workflowWait } from "../src/index.ts";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
}, 60_000);

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

async function registered(): Promise<{ host: Host; home: string; id: string; version: string; dir: string }> {
  const temp = await tempHome();
  homes.push(temp);
  const host = createNiwa({ home: temp.path });
  host.use(requests(), timers([]), workflow());
  await host.serve();
  hosts.push(host);
  const home = realpathSync(temp.path);
  const src = join(home, "src");
  await mkdir(join(src, "lib"), { recursive: true });
  await symlink(realpathSync(join(import.meta.dir, "..", "node_modules")), join(src, "node_modules"), "dir");
  await writeFile(join(src, "lib", "label.ts"), 'export const label = "one";\n');
  await writeFile(join(src, "lib", "table.json"), '{ "n": 2 }\n');
  await writeFile(
    join(src, "flow.ts"),
    [
      'import { z as zod } from "zod";',
      'import { label } from "./lib/label.ts";',
      'import table from "./lib/table.json";',
      'export default workflow({ description: "Answer the label", output: z.string() }, async () => zod.string().parse(`${label}:${String(table.n)}`));',
    ].join("\n"),
  );
  const { id, version } = await host.call(workflowRegister, { file: join(src, "flow.ts") });
  return { host, home, id, version, dir: join(home, "workflows", id, version) };
}

const run = async (host: Host, id: string): Promise<unknown> => {
  const { run: started } = await host.call(workflowStart, { id });
  return (await host.call(workflowWait, { run: started, timeoutMs: 20_000 })).outcome;
};

test("the manifest names the files with their hashes, the data files, the packages and the script ABI", async () => {
  const { host, home, id, version, dir } = await registered();
  const manifest = JSON.parse(readFileSync(join(home, "workflows", id, `${version}.json`), "utf8"));
  const zod = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules", "zod", "package.json"), "utf8")) as { version: string };
  expect(manifest).toEqual({
    entry: "flow.ts",
    from: join(home, "src", "flow.ts"),
    abi: SCRIPT_ABI,
    files: { "flow.ts": sha(join(dir, "flow.ts")), "lib/label.ts": sha(join(dir, "lib", "label.ts")) },
    data: { "lib/table.json": sha(join(dir, "lib", "table.json")) },
    imports: { zod: zod.version },
  });
  expect(await run(host, id)).toEqual({ status: "done", result: "one:2" });
}, 60_000);

test("a copy that is not what its manifest says does not start", async () => {
  const { host, id, dir } = await registered();
  await writeFile(join(dir, "lib", "table.json"), '{ "n": 3 }\n');
  await expect(host.call(workflowStart, { id })).rejects.toThrow('"lib/table.json" is not the file');
}, 60_000);

test("a version registered for another script ABI does not start", async () => {
  const { host, home, id, version } = await registered();
  const path = join(home, "workflows", id, `${version}.json`);
  await writeFile(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), abi: SCRIPT_ABI + 1 }));
  await expect(host.call(workflowStart, { id })).rejects.toThrow(`script ABI ${String(SCRIPT_ABI + 1)}`);
}, 60_000);

test("a manifest that names only the entry is completed from the copy, which is its version", async () => {
  const { host, home, id, version } = await registered();
  const path = join(home, "workflows", id, `${version}.json`);
  const full = JSON.parse(readFileSync(path, "utf8"));
  await writeFile(path, JSON.stringify({ entry: full.entry, from: full.from }));
  expect(await run(host, id)).toEqual({ status: "done", result: "one:2" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(full);
}, 60_000);
