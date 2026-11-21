// Finding the installed harnesses and proposing instances.
//
// The finding looks for the binary of each kind, asks it for its version and checks that the
// home of the installation is there. It runs no real harness: a fake PATH holds a script named
// "mcode" that prints a version, and the homes are directories of the test's own.
//
// What it proves:
//   1. a kind whose binary is on the PATH is proposed, with the version the binary said
//   2. a kind whose binary is nowhere is not proposed, and is named as missing
//   3. the environment override wins over the PATH
//   4. a kind with no binary is proposed on its home alone
//   5. the action writes a "harness.proposed" record, and a second run writes nothing new

import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import type { StoredRecord } from "@niwa-labs/core";
import { discover } from "@niwa-labs/harness";
import { HARNESS_DISCOVER_ACTION, HarnessProposed, harnessDiscovery } from "@niwa-labs/sessions";
import type { HarnessDiscoverOutput } from "@niwa-labs/sessions";
import { claudeCodeKind, CLAUDE_CODE_ADAPTER, claudeSdkKind } from "@niwa-labs/harness-claude";

import { mcodeKind, ncodeKind } from "@niwa-labs/harness-mcode";
import { tempDir, tempHome } from "@niwa-labs/testing";

/** The version the fake binary says. */
const FAKE_VERSION = "9.9.9-fake";

/** A directory with a program in it that prints the version it was given. */
async function fakeBinary(dir: string, name: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  // The interpreter is named by its own path: the probe runs the binary with the PATH of the
  // finding, which holds the fake programs and nothing else.
  await writeFile(path, `#!/bin/sh\necho "${version}"\n`);
  await chmod(path, 0o755);
  return path;
}


test("a kind whose binary is on the PATH is proposed with the version it said", async () => {
  const root = await tempDir("discover");
  try {
    const bin = join(root, "bin");
    const path = await fakeBinary(bin, "mcode", FAKE_VERSION);
    await mkdir(join(root, ".minimax"), { recursive: true });

    const { proposals, missing } = await discover([mcodeKind], { PATH: bin, HOME: root });

    expect(missing).toEqual([]);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal?.kind).toBe(mcodeKind.kind);
    expect(proposal?.binary?.path).toBe(path);
    expect(proposal?.binary?.version).toBe(FAKE_VERSION);
    expect(proposal?.home).toBe(join(root, ".minimax"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kind whose binary is nowhere is not proposed, and is named as missing", async () => {
  const root = await tempDir("discover");
  try {
    await mkdir(join(root, ".minimax"), { recursive: true });

    const { proposals, missing } = await discover([mcodeKind], {
      PATH: join(root, "no-such-dir"),
      HOME: root,
    });

    expect(proposals).toEqual([]);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.kind).toBe(mcodeKind.kind);
    expect(missing[0]?.reason).toContain("mcode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mcode and ncode find their own launchers and take independent overrides", async () => {
  const root = await tempDir("discover");
  try {
    const bin = join(root, "bin");
    const upstream = await fakeBinary(bin, "mcode", "0.7.1");
    const fork = await fakeBinary(bin, "ncode", "0.8.0");
    const other = await fakeBinary(join(root, "other"), "mcode", "0.7.4");
    await mkdir(join(root, ".minimax"), { recursive: true });
    const { proposals, missing } = await discover([mcodeKind, ncodeKind], { PATH: bin, HOME: root });

    expect(missing).toEqual([]);
    const found = new Map(proposals.map((proposal) => [String(proposal.kind), proposal]));
    expect(found.get("mcode")?.binary?.path).toBe(upstream);
    expect(found.get("ncode")?.binary?.path).toBe(fork);

    const split = await discover([mcodeKind, ncodeKind], { PATH: bin, HOME: root, MCODE_BIN: other });
    const byKind = new Map(split.proposals.map((proposal) => [String(proposal.kind), proposal]));
    expect(byKind.get("mcode")?.binary?.path).toBe(other);
    expect(byKind.get("mcode")?.binary?.version).toBe("0.7.4");
    expect(byKind.get("ncode")?.binary?.path).toBe(fork);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the environment override wins over the PATH", async () => {
  const root = await tempDir("discover");
  try {
    const onPath = join(root, "bin");
    const override = join(root, "override");
    await fakeBinary(onPath, "mcode", "1.0.0-on-path");
    const path = await fakeBinary(override, "mcode", "2.0.0-override");
    await mkdir(join(root, ".minimax"), { recursive: true });

    const { proposals } = await discover([mcodeKind], {
      PATH: onPath,
      HOME: root,
      MCODE_BIN: path,
    });

    expect(proposals[0]?.binary?.path).toBe(path);
    expect(proposals[0]?.binary?.version).toBe("2.0.0-override");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kind with no binary is proposed on its home alone", async () => {
  const root = await tempDir("discover");
  try {
    const home = join(root, ".claude");
    await mkdir(home, { recursive: true });

    const { proposals, missing } = await discover([claudeSdkKind], {
      PATH: "",
      HOME: root,
    });

    expect(missing).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.binary).toBeUndefined();
    expect(proposals[0]?.home).toBe(home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude-code is found through niwa's own adapter, with nothing on the PATH", async () => {
  const root = await tempDir("discover");
  try {
    const home = join(root, ".claude");
    await mkdir(home, { recursive: true });

    const { proposals, missing } = await discover([claudeCodeKind], { PATH: "", HOME: root });

    expect(missing).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.binary?.path).toBe(CLAUDE_CODE_ADAPTER.path);
    expect(proposals[0]?.binary?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(proposals[0]?.home).toBe(home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the environment override wins over the bundled adapter", async () => {
  const root = await tempDir("discover");
  try {
    const home = join(root, ".claude");
    await mkdir(home, { recursive: true });
    const path = await fakeBinary(join(root, "override"), "claude-code-acp", "3.0.0-override");

    const { proposals } = await discover([claudeCodeKind], { PATH: "", HOME: root, CLAUDE_CODE_BIN: path });

    expect(proposals[0]?.binary?.path).toBe(path);
    expect(proposals[0]?.binary?.version).toBe("3.0.0-override");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the action writes a proposal, and a second run writes nothing new", async () => {
  const root = await tempDir("discover");
  const home = await tempHome();
  try {
    const bin = join(root, "bin");
    await fakeBinary(bin, "mcode", FAKE_VERSION);
    await mkdir(join(root, ".minimax"), { recursive: true });

    const niwa = createNiwa({ home: home.path });
    niwa.use(
      harnessDiscovery({
        kinds: [mcodeKind],
        env: { PATH: bin, HOME: root },
      }),
    );
    try {
      await niwa.serve();

      const first = (await niwa.call(actionName(HARNESS_DISCOVER_ACTION), {})) as HarnessDiscoverOutput;
      expect(first.proposals).toHaveLength(1);
      expect(first.proposals[0]?.home).toBe(join(root, ".minimax"));

      const written = await recordsOf(niwa);
      expect(written).toHaveLength(1);
      expect(written[0]?.data).toMatchObject({
        kind: "mcode",
        home: join(root, ".minimax"),
        binary: { version: FAKE_VERSION },
      });

      // The same finding again: the proposal is the same installation, so the same record is
      // found and nothing new is written.
      const second = (await niwa.call(actionName(HARNESS_DISCOVER_ACTION), {})) as HarnessDiscoverOutput;
      expect(second.proposals).toHaveLength(1);
      expect(await recordsOf(niwa)).toHaveLength(1);
    } finally {
      await niwa.close();
    }
  } finally {
    await home.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

/** Is there a process with this pid? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An mcode that writes its pid to a file and then becomes the given program. */
async function misbehaving(root: string, exec: string): Promise<{ bin: string; pidFile: string }> {
  const bin = join(root, "bin");
  const pidFile = join(root, "pid");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "mcode"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec ${exec}\n`);
  await chmod(join(bin, "mcode"), 0o755);
  await mkdir(join(root, ".minimax"), { recursive: true });
  return { bin, pidFile };
}

test("a binary that never answers is stopped at the deadline", async () => {
  const root = await tempDir("discover");
  try {
    const { bin, pidFile } = await misbehaving(root, "/bin/sleep 60");
    const started = Date.now();
    const { proposals } = await discover([mcodeKind], { PATH: bin, HOME: root });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(proposals[0]?.binary?.version).toBe("unknown");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await Bun.sleep(200);
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a binary that says too much is stopped at the cap", async () => {
  const root = await tempDir("discover");
  try {
    const { bin, pidFile } = await misbehaving(root, "/usr/bin/yes aaaaaaaa");
    const started = Date.now();
    const { proposals } = await discover([mcodeKind], { PATH: bin, HOME: root });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(proposals[0]?.binary?.version).toBe("aaaaaaaa");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await Bun.sleep(200);
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The records of the proposals that were written. */
async function recordsOf(niwa: ReturnType<typeof createNiwa>): Promise<StoredRecord[]> {
  return niwa.records.read({ types: [HarnessProposed.name] });
}
