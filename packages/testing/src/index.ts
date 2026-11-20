import { mkdtemp, realpath } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty directory that is removed when the process ends. `label` shows up in its name. */
export async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), `niwa-${label}-`));
  made.push(dir);
  return dir;
}

/** Tests that need real binaries or the network run only when `NIWA_LIVE=1`. */
export const live: boolean = process.env.NIWA_LIVE === "1";
