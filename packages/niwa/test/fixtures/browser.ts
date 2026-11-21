// A real browser for the tests that look at a page: the headless Chromium Playwright keeps in its cache, or the one the
// environment names. When there is none the tests that need it are skipped, not failed.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The path of a headless Chromium on this machine, or undefined when there is none. */
export function chromiumPath(): string | undefined {
  const named = process.env.NIWA_TEST_CHROMIUM;
  if (named !== undefined && named !== "") return existsSync(named) ? named : undefined;
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")];
  for (const cache of caches) {
    if (cache === undefined || !existsSync(cache)) continue;
    const shells = readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const shell of shells) {
      const folder = join(cache, shell);
      const candidates = [
        join(folder, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        join(folder, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
        join(folder, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(folder, "chrome-headless-shell-linux", "chrome-headless-shell"),
        join(folder, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
      ];
      const found = candidates.find((path) => existsSync(path));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
