// proc.exec and secrets: a command with no box, its environment, and a secret that is never written.
//
// What it proves:
//   1. exec runs with no box, even where none could run, and is not held to the cwd
//   2. its environment is PATH, HOME, what the call lists and the secrets it names: not the host's
//   3. a secret is resolved from a file of the home or from the host's environment, and reaches the process
//   4. the value of a secret is in no byte under the home (journal, its log, artifacts), nor in the
//      result, nor in an error; the output has it replaced
//   5. a secret that is not there, or a file anyone may read, stops the call before a process exists
//   6. exec is stopped on its timeout with what it started, and says so

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { eventually } from "@niwa-labs/testing";

import { secret } from "@niwa-labs/core";

import { procExec } from "../src/index.ts";
import { absentSandbox, alive, dirIn, filesUnder, outputOf, procHost } from "./support.ts";

type Host = Awaited<ReturnType<typeof procHost>>;
const hosts: Host[] = [];
afterEach(async () => {
  delete process.env["NIWA_SECRET_FROM_ENV"];
  delete process.env["NIWA_ID"];
  for (const host of hosts.splice(0)) await host.stop();
});

async function start(): Promise<Host> {
  // No box can run: exec must not need one.
  const host = await procHost({ sandbox: absentSandbox, killGraceMs: 200 });
  hosts.push(host);
  return host;
}

const sh = (script: string) => ["/bin/sh", "-c", script];
const VALUE = "s3cr3t-Value-0042";

function putSecret(host: Host, name: string, value: string, mode = 0o600): void {
  const dir = host.niwa.secrets.dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${value}\n`, { mode });
  chmodSync(join(dir, name), mode);
}

test("exec runs with no box and is not held to its cwd", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  const elsewhere = join(host.home, "elsewhere.txt");
  const result = await host.niwa.call(procExec, { cmd: sh(`echo done > ${elsewhere}`), cwd, timeout: 10_000 });
  expect(result.exit).toBe(0);
  expect(readFileSync(elsewhere, "utf8")).toBe("done\n");
  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect(finished.map((row) => (row.data as { action: string; box?: unknown }).action)).toEqual(["proc.exec"]);
  expect((finished[0]?.data as { box?: unknown }).box).toBeUndefined();
});

test("the environment of exec is what the call lists, not the host's", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  process.env["NIWA_ID"] = "leaked-session";
  const result = await host.niwa.call(procExec, { cmd: sh("env | sort"), cwd, timeout: 10_000, env: { MODE: "ci" } });
  const names = outputOf(host, result.output)
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split("=")[0])
    .filter((name) => name !== "PWD" && name !== "SHLVL" && name !== "_" && name !== "OLDPWD");
  expect(names).toEqual(["HOME", "MODE", "PATH"]);
});

test("a secret from a file reaches the process, and the output has it replaced", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  putSecret(host, "DEPLOY", VALUE);
  const result = await host.niwa.call(procExec, {
    cmd: sh('printf "len=%s\\n" "${#TOKEN}"; printf "value=%s\\n" "$TOKEN"'),
    cwd,
    timeout: 10_000,
    env: { TOKEN: secret("DEPLOY") },
  });
  expect(result.exit).toBe(0);
  expect(result.tail).toBe(`len=${VALUE.length}\nvalue=***\n`);
  expect(outputOf(host, result.output)).toBe(`len=${VALUE.length}\nvalue=***\n`);
});

test("the secrets a call names are given as variables of their own names", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  process.env["NIWA_SECRET_FROM_ENV"] = VALUE;
  const result = await host.niwa.call(procExec, { cmd: sh('printf "%s" "${#FROM_ENV}"'), cwd, timeout: 10_000, secrets: ["FROM_ENV"] });
  expect(result.tail).toBe(String(VALUE.length));
});

test("the value of a secret is in no byte under the home, and not in the result", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  process.env["NIWA_SECRET_FROM_ENV"] = VALUE;
  const result = await host.niwa.call(procExec, {
    cmd: sh('echo "token is $TOKEN"; echo "again $TOKEN" >&2'),
    cwd,
    timeout: 10_000,
    env: { TOKEN: secret("FROM_ENV") },
  });
  expect(JSON.stringify(result)).not.toContain(VALUE);
  expect(result.tail.split("\n").sort()).toEqual(["", "again ***", "token is ***"]);
  const files = filesUnder(host.home);
  expect(files.some((file) => file.path.includes("artifacts"))).toBe(true);
  // The scan reaches the journal: the record of this very command is in its bytes.
  expect(files.some((file) => file.path.includes("journal.db") && file.bytes.includes(Buffer.from("proc.finished")))).toBe(true);
  for (const file of files) expect(file.bytes.includes(Buffer.from(VALUE))).toBe(false);
  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect(JSON.stringify(finished)).not.toContain(VALUE);
});

test("a secret that is not there stops the call before a process exists, and the error names no value", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  const marker = join(cwd, "ran");
  const call = host.niwa.call(procExec, { cmd: sh(`touch ${marker}`), cwd, timeout: 10_000, env: { TOKEN: secret("MISSING") } });
  await expect(call).rejects.toThrow(/no secret "MISSING"/);
  await Bun.sleep(100);
  expect(existsSync(marker)).toBe(false);
});

test("a secret file that others may read is refused, naming the secret and not its value", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  putSecret(host, "OPEN", VALUE, 0o644);
  const error = await host.niwa.call(procExec, { cmd: ["/usr/bin/true"], cwd, timeout: 10_000, env: { TOKEN: secret("OPEN") } }).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error?.message).toMatch(/"OPEN".*0600/);
  expect(error?.message).not.toContain(VALUE);
});

test("exec that outlasts its timeout is stopped with the child it started", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  const result = await host.niwa.call(procExec, { cmd: sh("sleep 60 & echo $! > child.pid; wait"), cwd, timeout: 400 });
  expect(result.outcome).toBe("timed-out");
  expect(result.exit).toBeNull();
  const child = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
  await eventually(() => !alive(child), 5_000, "the child should be gone");
});

test("a program that is not there is refused, and nothing is recorded", async () => {
  const host = await start();
  const cwd = dirIn(host.home, "work");
  await expect(host.niwa.call(procExec, { cmd: ["/no/such/program"], cwd, timeout: 1000 })).rejects.toThrow(/cannot start/);
  expect((await host.niwa.records.read()).filter((row) => row.type === "proc.finished")).toEqual([]);
});
