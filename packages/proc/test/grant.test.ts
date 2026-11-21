// What a grant can say about a command: both actions are called at the real directory they run in,
// so a rule names a place, and a link cannot name a place the rule does not cover.

import { existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { grant, isCallTarget, principalOf } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { connect } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { fileTarget, procExec, procRun } from "../src/index.ts";
import { dirIn, procHost, recordingSandbox } from "./support.ts";
import type { ProcOptions } from "../src/index.ts";

const clients: NiwaApi[] = [];
const hosts: Array<Awaited<ReturnType<typeof procHost>>> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.stop();
});

async function served(options: ProcOptions = { sandbox: recordingSandbox() }) {
  const host = await procHost(options);
  hosts.push(host);
  const as = async (rules: string[]): Promise<NiwaApi> => {
    const token = host.niwa.issueToken(principalOf("session", "caller"), { grant: grant(rules) });
    const client = await connect({ home: host.home, id: "session:caller", token });
    clients.push(client);
    return client;
  };
  return { host, as };
}

test("a grant on a directory lets a command run there and in no other directory", async () => {
  const { host, as } = await served();
  const here = realpathSync(dirIn(host.home, "here"));
  const there = realpathSync(dirIn(host.home, "there"));
  const caller = await as([`proc.run@${here}`]);
  expect((await caller.call(procRun, { cmd: ["/usr/bin/true"], cwd: here, timeout: 10_000 })).exit).toBe(0);
  await expect(caller.call(procRun, { cmd: ["/usr/bin/true"], cwd: there, timeout: 10_000 })).rejects.toThrow(/grant/);
});

test("a link to a directory is the directory it leads to: the grant of that place covers it, and the link's own name does not", async () => {
  const { host, as } = await served();
  const other = realpathSync(dirIn(host.home, "other"));
  const link = join(host.home, "link");
  symlinkSync(other, link);
  const byPlace = await as([`proc.run@${other}`]);
  expect((await byPlace.call(procRun, { cmd: ["/usr/bin/true"], cwd: link, timeout: 10_000 })).exit).toBe(0);
  const byLink = await as([`proc.run@${link}`]);
  await expect(byLink.call(procRun, { cmd: ["/usr/bin/true"], cwd: link, timeout: 10_000 })).rejects.toThrow(/grant/);
});

test("a grant of run does not let a caller exec, and exec needs its own rule", async () => {
  const { host, as } = await served();
  const here = realpathSync(dirIn(host.home, "here"));
  const runner = await as([`proc.run@${here}`]);
  await expect(runner.call(procExec, { cmd: ["/usr/bin/true"], cwd: here, timeout: 10_000 })).rejects.toThrow(/grant/);
  const execer = await as([`proc.exec@${here}`]);
  expect((await execer.call(procExec, { cmd: ["/usr/bin/true"], cwd: here, timeout: 10_000 })).exit).toBe(0);
});

test("a link that is moved after the grant was checked does not move the command to a place the grant never covered", async () => {
  const { host, as } = await served();
  const here = realpathSync(dirIn(host.home, "here"));
  const there = realpathSync(dirIn(host.home, "there"));
  const link = join(host.home, "link");
  symlinkSync(here, link);
  // A guard runs after the grant was matched and before the command starts: the window of the race.
  host.niwa.use(
    plugin("mover", (api) => {
      api.guard(procRun, () => {
        rmSync(link);
        symlinkSync(there, link);
        return undefined;
      });
    }),
  );
  const caller = await as([`proc.run@${here}`]);
  await expect(caller.call(procRun, { cmd: ["/usr/bin/touch", "ran"], cwd: link, timeout: 10_000 })).rejects.toThrow(/changed/);
  expect(existsSync(join(there, "ran"))).toBe(false);
  expect(existsSync(join(here, "ran"))).toBe(false);
});

test("a directory with a space, a percent sign or a colon in its name is a target a rule can name", async () => {
  const { host, as } = await served();
  const plain = realpathSync(dirIn(host.home, "My Project"));
  const odd = realpathSync(dirIn(host.home, "a%b:c@d*e"));
  const other = realpathSync(dirIn(host.home, "other"));

  const anywhere = await as(["proc.run"]);
  expect((await anywhere.call(procRun, { cmd: ["/usr/bin/true"], cwd: plain, timeout: 10_000 })).exit).toBe(0);
  expect((await anywhere.call(procRun, { cmd: ["/usr/bin/true"], cwd: odd, timeout: 10_000 })).exit).toBe(0);

  const named = await as([`proc.run@${fileTarget(plain)}`]);
  expect(fileTarget(plain)).toBe(`${realpathSync(host.home)}/My%20Project`);
  expect((await named.call(procRun, { cmd: ["/usr/bin/true"], cwd: plain, timeout: 10_000 })).exit).toBe(0);
  await expect(named.call(procRun, { cmd: ["/usr/bin/true"], cwd: other, timeout: 10_000 })).rejects.toThrow(/grant/);
  await expect(named.call(procRun, { cmd: ["/usr/bin/true"], cwd: odd, timeout: 10_000 })).rejects.toThrow(/grant/);

  const underHome = await as([`proc.run@${fileTarget(realpathSync(host.home))}/*`]);
  expect((await underHome.call(procRun, { cmd: ["/usr/bin/true"], cwd: odd, timeout: 10_000 })).exit).toBe(0);
});

test("a path with only plain segments is its own target, and an encoded one cannot be read as another place", () => {
  expect(fileTarget("/work/repo-1/src.d")).toBe("/work/repo-1/src.d");
  expect(fileTarget("/a b/c")).toBe("/a%20b/c");
  expect(fileTarget("/a%20b")).toBe("/a%2520b");
  expect(fileTarget("/a%20b")).not.toBe(fileTarget("/a b"));
  expect(isCallTarget(fileTarget("/x/{y}/*/z@q:r s"))).toBe(true);
});
