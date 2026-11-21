/** An instance bound to a Claude Code installation: its processes write where its reading side looks. */

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import { onSpawn } from "@niwa-labs/sandbox";
import { fakeSdkQuery } from "@niwa-labs/testing";

import { claudeCodeControl } from "../../src/code/control.ts";
import { claudeHomeEnv, claudeNeeds } from "../../src/code/needs.ts";
import { ClaudeSdkControl } from "../../src/sdk/control.ts";

const OTHER = "/tmp/niwa-other-claude-home";
const DEFAULT = join(homedir(), ".claude");

test("a process is told its installation only when it is not the default one, and a box may write in it", () => {
  expect(claudeHomeEnv(undefined)).toEqual({});
  expect(claudeHomeEnv(DEFAULT)).toEqual({});
  expect(claudeHomeEnv(OTHER)).toEqual({ CLAUDE_CONFIG_DIR: OTHER });
  expect(claudeNeeds(OTHER).write).toEqual([OTHER]);
  expect(claudeNeeds(undefined).write).toEqual([DEFAULT]);
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
