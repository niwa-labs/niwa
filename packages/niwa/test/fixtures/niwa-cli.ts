// The `niwa` program for tests that run an insert: a wrapper that runs bin/niwa.ts with the bun
// that runs the test, so the insert's `niwa insert report` needs neither a PATH nor an install.

import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Writes the wrapper into a directory and returns its path: what `NIWA_CLI` is set to. */
export async function niwaCli(dir: string): Promise<string> {
  const path = join(dir, "niwa-cli.sh");
  const bin = resolve(import.meta.dir, "../../bin/niwa.ts");
  await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${bin}' "$@"\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}
