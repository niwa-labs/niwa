// Where the owner's token is read from: a home written with `~` is the same home as the socket's.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { OWNER_TOKEN_FILE } from "@niwa-labs/core";

const READER = join(import.meta.dir, "fixtures/owner-token-of.ts");

/** The token a fresh process reads for a home, when the user's home is `user`. */
async function tokenRead(user: string, home: string): Promise<string> {
  const child = Bun.spawn([process.execPath, READER, home], { env: { ...process.env, HOME: user }, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return out.trim();
}

test("the owner token of a home written with a leading ~ is read from the home of the user", async () => {
  const user = mkdtempSync(join(tmpdir(), "niwa-user-"));
  try {
    mkdirSync(join(user, ".niwa"));
    writeFileSync(join(user, ".niwa", OWNER_TOKEN_FILE), "ab12\n");
    expect(await tokenRead(user, "~/.niwa")).toBe("ab12");
    expect(await tokenRead(user, join(user, ".niwa"))).toBe("ab12");
    expect(await tokenRead(user, "~/.elsewhere")).toBe("none");
  } finally {
    rmSync(user, { recursive: true, force: true });
  }
}, 30_000);
