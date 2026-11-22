import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessId, promptFromText } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { claudeCodeControl } from "../src/code/control.ts";
import { ClaudeSdkControl } from "../src/sdk/control.ts";
import { StartupDiagnostics } from "../src/startup-diagnostics.ts";

const PRIVATE = "synthetic-token-env-and-conversation";

test("ACP classifies legacy error.data and ignores arbitrary text and unknown report fields", () => {
  const diagnostics = new StartupDiagnostics();
  diagnostics.stderr("operation not ");
  diagnostics.stderr(`permitted: ${PRIVATE}`);
  expect(diagnostics.rpc("session/new", {
    code: -32603,
    error: "Internal error",
    data: { details: `unknown flag ${PRIVATE}`, claudeStartup: { stage: PRIVATE, signals: [PRIVATE] } },
  })).toBe("session/new failed (RPC -32603): permission denied, unsupported command-line option");
});

for (const kind of ["ACP", "SDK"] as const) {
  test(`${kind} start reports a safe diagnosis when the configured executable exits early`, async () => {
    const dir = await tempDir("claude-startup");
    const home = join(dir, ".claude");
    const executable = join(dir, "fake-claude");
    await mkdir(home);
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' 'operation not permitted: ${PRIVATE}' >&2\nexit 19\n`, { mode: 0o755 });
    const harness = harnessId("claude-startup");
    const control = kind === "ACP"
      ? claudeCodeControl({ harness, home, executable, callTimeoutMs: 5_000 })
      : new ClaudeSdkControl({ harness, home, executable, startTimeoutMs: 5_000 });
    try {
      const failure = await control.start({
        cwd: dir,
        env: { HOME: dir },
        prompt: promptFromText(PRIVATE),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = String(failure);
      expect(message).not.toContain(PRIVATE);
      expect(message).toContain("permission denied");
      if (kind === "ACP") expect(message).toContain("session/new / initializationResult failed (RPC -32603)");
      else {
        expect(message).toContain("before system/init");
        expect(message).toContain("exit 19");
      }
    } finally {
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
