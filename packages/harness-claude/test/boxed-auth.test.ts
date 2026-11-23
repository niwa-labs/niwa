import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { secret } from "@niwa-labs/core";
import { harnessId, promptFromText } from "@niwa-labs/harness";
import { homePath, nono, onBoxManifest, onSpawn, resolveProfile, spawnAgent } from "@niwa-labs/sandbox";
import { fakeSdkQuery, tempDir } from "@niwa-labs/testing";

import { claudeCodeControl } from "../src/code/control.ts";
import { claudeCodeKind } from "../src/code/index.ts";
import { ClaudeSdkControl } from "../src/sdk/control.ts";
import { claudeSdkKind } from "../src/sdk/index.ts";
import type { SdkQuery } from "../src/sdk/control.ts";
import { StartupDiagnostics } from "../src/startup-diagnostics.ts";

const SYNTHETIC = "synthetic-api-key";
const harness = harnessId("boxed-auth-test");

test("both Claude installations declare only their OAuth service for local login", async () => {
  const defaultHome = homePath(".claude");
  const customHome = join(await tempDir("claude-custom-profile"), "Cafe\u0301");
  const suffix = createHash("sha256").update(customHome.normalize("NFC")).digest("hex").slice(0, 8);
  const machine = { home: homePath(), env: process.env };
  for (const kind of [claudeCodeKind, claudeSdkKind]) {
    for (const [home, names] of [
      [defaultHome, ["Claude Code-credentials"]],
      [customHome, [`Claude Code-credentials-${suffix}`]],
    ] as const) {
      const binding = kind.bind({ id: "claude-local", home });
      const profile = resolveProfile(binding.profile, "claude-local", machine);
      expect(profile.keychainRead).toEqual(process.platform === "darwin" ? names : undefined);
      expect(profile.net).toEqual(process.platform === "darwin" ? ["api.anthropic.com", "platform.claude.com"] : ["api.anthropic.com"]);
    }
  }
});

for (const kind of ["ACP", "SDK"] as const) {
  test(`${kind} supplies a configured key only to its boxed child`, async () => {
    const dir = await tempDir("boxed-auth");
    const wrapper = join(dir, "wrapper");
    const executable = join(dir, "fake-claude");
    const home = join(dir, "claude-home");
    await mkdir(home);
    await writeFile(wrapper, `#!/bin/sh
if [ "$1" = profile ]; then echo '{"filesystem":{"grants":[]}}'; exit 0; fi
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, { mode: 0o755 });
    await writeFile(executable, `#!/bin/sh
test "$ANTHROPIC_API_KEY" = '${SYNTHETIC}' &&
test "$ANTHROPIC_BASE_URL" = 'https://api.anthropic.com' &&
test "$CLAUDE_CODE_TMPDIR" = "$TMPDIR" &&
test "$CLAUDE_CONFIG_DIR" = '${home}' || exit 9
printf '%s\\n' 'operation not permitted: stub reached with expected environment' >&2
exit 19
`, { mode: 0o755 });
    let missing = false;
    const resolve = (name: string) => {
      expect(name).toBe("EXISTING_CLAUDE_KEY");
      resolutions += 1;
      if (missing) throw new Error(`missing test secret ${SYNTHETIC}`);
      return SYNTHETIC;
    };
    const auth = { harness, home, executable, boxedApiKey: { ref: secret("EXISTING_CLAUDE_KEY"), store: { resolve } } };
    const control = kind === "ACP" ? claudeCodeControl({ ...auth, callTimeoutMs: 3_000 }) : new ClaudeSdkControl({ ...auth, startTimeoutMs: 3_000 });
    const box = { sandbox: nono({ binary: wrapper }), spec: { cwd: dir } };
    let resolutions = 0;
    const observed: unknown[] = [];
    const stopSpawn = onSpawn((event) => { if (event.harness === harness) observed.push(event); });
    const stopManifest = onBoxManifest((record) => { if (record.harness === harness) observed.push(record); });
    try {
      await expect(control.start({ cwd: dir, box, env: { TMPDIR: dir }, prompt: promptFromText("test") })).rejects.toThrow(/permission denied/);
      expect(resolutions).toBe(1);
      expect(observed).toHaveLength(2);
      expect(JSON.stringify(observed)).not.toContain(SYNTHETIC);
      expect(JSON.stringify(observed)).not.toContain("ANTHROPIC_API_KEY");
      const child = await spawnAgent({
        harness: "unconfigured",
        program: "/bin/sh",
        args: ["-c", 'test -z "${ANTHROPIC_API_KEY+x}"'],
        box,
      });
      expect(await new Promise((resolve) => child.once("close", resolve))).toBe(0);
      await expect(control.start({ cwd: dir, prompt: promptFromText("test") })).rejects.toThrow();
      expect(resolutions).toBe(1);
      missing = true;
      const failure = await control.start({ cwd: dir, box, env: { TMPDIR: dir }, prompt: promptFromText("test") }).catch(String);
      expect(failure).toMatch(/host API key unavailable/i);
      expect(failure).not.toContain(SYNTHETIC);
      expect(resolutions).toBe(2);
      expect(observed).toHaveLength(3); // The failed lookup admitted a manifest and spawned nothing.
    } finally {
      stopSpawn();
      stopManifest();
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const [error, diagnostic] of [
  ["Not logged in · Please run /login", "not signed in"],
  ["CONNECT tunnel failed, response 403", "network denied"],
] as const) {
  test(`SDK turn after init reports ${diagnostic}`, async () => {
    const fake = fakeSdkQuery();
    const query: SdkQuery = (params) => {
      const original = fake.query(params);
      return {
        close: () => original.close(),
        interrupt: () => original.interrupt(),
        async *[Symbol.asyncIterator]() {
          for await (const message of original) {
            yield message.type === "result" && message.subtype === "success"
              ? { ...message, is_error: true, result: `${error} ${SYNTHETIC}` }
              : message;
          }
        },
      };
    };
    const control = new ClaudeSdkControl({ harness, query });
    try {
      const { session } = await control.start({ prompt: promptFromText("test") });
      for await (const event of control.life(session)) {
        if (event.kind === "turn-ended") {
          expect(event).toMatchObject({ outcome: "failed", diagnostic });
          expect(JSON.stringify(event)).not.toContain(SYNTHETIC);
          return;
        }
      }
      throw new Error("missing turn-ended");
    } finally {
      await control.dispose();
    }
  });
}

test("ACP reports proxy denial, auth-required and API rejection separately", () => {
  for (const [code, details, diagnostic] of [
    [-32603, "CONNECT tunnel failed, response 403", "network denied"],
    [-32000, "Authentication required", "not signed in"],
    [-32603, "API Error: 401", "authentication rejected"],
  ] as const) {
    const signals = new StartupDiagnostics();
    expect(signals.rpc("session/prompt", { code, error: "Unable to process prompt", data: { details: `${details} ${SYNTHETIC}` } })).not.toContain(SYNTHETIC);
    expect(signals.accessFailure()).toBe(diagnostic);
  }
});
