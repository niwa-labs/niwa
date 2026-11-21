// What a grant can say about a command: both actions are called at the real directory they run in,
// so a rule names a place, and a link cannot name a place the rule does not cover.

import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { procExec, procRun } from "../src/index.ts";
import { dirIn, procHost, recordingSandbox } from "./support.ts";

const clients: NiwaApi[] = [];
const hosts: Array<Awaited<ReturnType<typeof procHost>>> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.stop();
});

async function served() {
  const host = await procHost({ sandbox: recordingSandbox() });
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
