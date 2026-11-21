/** An instance bound to a Claude Code installation: its processes write where its reading side looks. */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import { onSpawn, resolveProfile } from "@niwa-labs/sandbox";
import { fakeSdkQuery } from "@niwa-labs/testing";

import { claudeCodeControl } from "../../src/code/control.ts";
import { claudeCodeKind } from "../../src/code/index.ts";
import { claudeHomeEnv } from "../../src/code/needs.ts";
import { claudeSdkKind } from "../../src/sdk/index.ts";
import { ClaudeSdkControl } from "../../src/sdk/control.ts";

const OTHER = "/tmp/niwa-other-claude-home";
const DEFAULT = join(homedir(), ".claude");

test("a process is told its installation only when it is not the default one", () => {
  expect(claudeHomeEnv(undefined)).toEqual({});
  expect(claudeHomeEnv(DEFAULT)).toEqual({});
  expect(claudeHomeEnv(OTHER)).toEqual({ CLAUDE_CONFIG_DIR: OTHER });
});

test("an installation's profile writes its directory, and the configuration file beside the default one", () => {
  const resolved = (kind: typeof claudeCodeKind | typeof claudeSdkKind, home?: string) =>
    resolveProfile(kind.bind({ id: "claude-a", ...(home === undefined ? {} : { home }) }).profile ?? {}, "claude-a", { home: homedir(), env: { PATH: "/nowhere" } });
  for (const kind of [claudeCodeKind, claudeSdkKind]) {
    expect(resolved(kind, OTHER).write).toEqual([OTHER]);
    expect(resolved(kind).write).toEqual([DEFAULT, join(homedir(), ".claude.json")]);
    expect(resolved(kind).net).toEqual(["api.anthropic.com"]);
    // The runtime niwa's adapter runs on is in it.
    expect(resolved(kind).read).toContain(process.execPath);
    expect(kind.profile.status).toBe("admitted");
  }
});

test("the ACP adapter is started bound to the installation of its instance", async () => {
  const spawned: Array<Readonly<Record<string, string>>> = [];
  const stop = onSpawn((event) => spawned.push(event.env));
  try {
    for (const home of [OTHER, DEFAULT]) {
      const control = claudeCodeControl({ harness: "home-proof", command: ["/usr/bin/true"], executable: "/opt/claude/claude", home });
      await expect(control.start({ prompt: promptFromText("one") })).rejects.toThrow();
      await control.dispose();
    }
  } finally {
    stop();
  }
  expect(spawned[0]?.CLAUDE_CONFIG_DIR).toBe(OTHER);
  expect(spawned[1]?.CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("a query of the SDK is bound to the installation of its instance", async () => {
  const fake = fakeSdkQuery();
  const bound = new ClaudeSdkControl({ harness: harnessId("home-proof"), query: fake.query, home: OTHER });
  const plain = new ClaudeSdkControl({ harness: harnessId("home-proof"), query: fake.query });
  try {
    await bound.start({ prompt: promptFromText("one") });
    expect(fake.asked()[0]?.env?.CLAUDE_CONFIG_DIR).toBe(OTHER);
    await plain.start({ prompt: promptFromText("one") });
    expect(fake.asked()[1]?.env?.CLAUDE_CONFIG_DIR).not.toBe(OTHER);
  } finally {
    await bound.dispose();
    await plain.dispose();
  }
});
