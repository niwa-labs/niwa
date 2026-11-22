import { expect, test } from "bun:test";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { nono, resolveProfile, spawnAgent } from "@niwa-labs/sandbox";
import { live, tempDir } from "@niwa-labs/testing";

import { zcodeKind } from "../../src/index.ts";
import { boxedStorage, installationStorage } from "../../src/storage.ts";

test.skipIf(!live || process.platform !== "darwin")("ZCode's nono box creates and reopens SQLite in WAL mode without granting its sibling", async () => {
  const root = await realpath(await tempDir("zcode-nono-sqlite"));
  try {
    const cwd = join(root, "work");
    const home = join(root, "home");
    const sibling = join(root, "sibling");
    const database = join(root, "external", "db", "sessions.sqlite");
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(sibling)]);
    const binding = zcodeKind.bind({ id: "zcode-sqlite", home });
    const profile = resolveProfile(binding.profile ?? {}, "zcode-sqlite", { home, env: {} });
    const adapter = nono();
    const launch = await boxedStorage({
      sandbox: adapter,
      spec: { cwd, read: [sibling], write: [...profile.write], env: { ZCODE_SESSION_DB: database } },
    }, installationStorage(home), cwd);
    expect(launch.box.spec.write).toEqual([home, dirname(database)]);

    for (const [sql, expected] of [
      ["PRAGMA journal_mode = WAL; CREATE TABLE sessions (id); INSERT INTO sessions VALUES (1); SELECT count(*) FROM sessions;", "wal\n1"],
      ["PRAGMA journal_mode; INSERT INTO sessions VALUES (2); SELECT count(*) FROM sessions;", "wal\n2"],
    ] as const) {
      const child = await spawnAgent({
        harness: "zcode-sqlite",
        program: "/bin/sh",
        args: ["-eu", "-c", `
          printf '%s\n' "$1" '.shell test -f "$ZCODE_SESSION_DB_PATH-wal" && test -f "$ZCODE_SESSION_DB_PATH-shm" && echo sidecars' |
            /usr/bin/sqlite3 -bail "$ZCODE_SESSION_DB_PATH"
          if (echo denied > "$2/marker") 2>/dev/null; then exit 99; fi
        `, "sqlite-check", sql, sibling],
        cwd,
        ...launch,
      });
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        new Promise<number | null>((resolve, reject) => {
          child.once("close", resolve);
          child.once("error", reject);
        }),
      ]);
      expect({ stdout: stdout.trim(), stderr, code }).toEqual({ stdout: expected + "\nsidecars", stderr: "", code: 0 });
    }
    await expect(stat(join(sibling, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
