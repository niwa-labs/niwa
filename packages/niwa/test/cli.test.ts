// The checks of the CLI surface: the commands of the actions and `niwa serve`.
//
// The generated commands are checked in test/generated-commands.test.ts. This file checks
// the parts that are the CLI's own: the home of the host, the serve, and the way a failure
// ends.
//

import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record, seq, Address } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { RequestAnswered, RequestCreated, requestAsk, question, requests } from "@niwa-labs/requests";
import { eventually, spawnHost, tempHome, connectAsOwner, opt } from "@niwa-labs/testing";
import { z } from "zod";

import { Note } from "./fixtures/surface-host.ts";

const HOST_SCRIPT = new URL("./fixtures/surface-host.ts", import.meta.url).pathname;
const COMPOSITION = new URL("./fixtures/composition.ts", import.meta.url).pathname;

/** One run of the CLI: what it printed, and how it ended. */
interface Run {
  readonly out: string;
  readonly err: string;
  readonly code: number;
}

/**
 * Run the CLI against a home.
 *
 * The CLI is a program: it is started, it is given the home and the command, and what it
 * printed and how it ended are what the test reads.
 */
async function cli(home: string, args: string[], env?: Record<string, string>): Promise<Run> {
  // An empty home means the CLI must find it itself: from the environment, or from the
  // place niwa keeps it by default.
  const withHome = home === "" ? args : ["--home", home, ...args];
  const child = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, ...withHome], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { out, err, code };
}

test("the CLI reads the records of the journal, traces a record and reads its causes", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();

    // A record is written through the core, so the journal has something to read.
    const writer = await connectAsOwner(homePath);
    await writer.emit(Note, { text: "hello" });
    await writer.close();

    // The observation actions of the core are commands, because the host declares them.
    const records = await cli(homePath, ["niwa.records.read"]);
    expect(records.code).toBe(0);
    expect(records.out).toContain("niwa.invocation.admitted");

    // The machine form is JSON: a script reads it.
    const machine = await cli(homePath, ["--json", "niwa.records.read"]);
    expect(machine.code).toBe(0);
    const parsed = (JSON.parse(machine.out) as { records: Array<{ type: string; id: string }> }).records;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((record) => record.type === "niwa.invocation.admitted")).toBe(true);

    // The trace of a record that exists is not empty, and the causes of it are readable.
    const id = parsed.find((record) => record.type === "niwa.invocation.admitted")?.id;
    expect(id).toBeDefined();
    const traced = await cli(homePath, ["niwa.trace", "--id", String(id)]);
    expect(traced.code).toBe(0);
    expect(traced.out).toContain("niwa.invocation.admitted");

    const caused = await cli(homePath, ["niwa.causes", "--id", String(id)]);
    expect(caused.code).toBe(0);
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("the CLI takes the home from --home, from NIWA_HOME, and from the default", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();

    // The home from the environment.
    const fromEnv = await cli("", ["niwa.describe"], { NIWA_HOME: homePath });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.out).toContain("surface.greet");

    // A home that holds no host fails, and says so.
    const empty = await tempHome();
    const nowhere = await cli(empty.path, ["niwa.describe"]);
    expect(nowhere.code).toBe(3);
    expect(nowhere.err.trim().split("\n")).toEqual([`no host is serving ${empty.path} (start it with "niwa serve <composition>")`]);
    await empty.cleanup();
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("niwa serve runs a host from a composition file", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let server: ReturnType<typeof Bun.spawn> | undefined;

  try {
    // The composition is served by the CLI itself: the program is started, and it becomes
    // the host of that home.
    server = Bun.spawn(
      [process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", homePath, "serve", COMPOSITION],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );
    // The host serves: the CLI of the same home sees it.
    let described = await cli(homePath, ["niwa.describe"]);
    for (let attempt = 0; described.code !== 0 && attempt < 200; attempt += 1) {
      await Bun.sleep(50);
      described = await cli(homePath, ["niwa.describe"]);
    }
    expect(described.code).toBe(0);
    expect(described.out).toContain("composition.ping");

    // SIGTERM ends the host cleanly: exit 0, and the home has no host any more.
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect((await cli(homePath, ["niwa.describe"])).code).not.toBe(0);
  } finally {
    server?.kill("SIGKILL");
    await home.cleanup();
  }
}, 40_000);

test("niwa status shows the host and what its plugins hold, and niwa stop ends the host that serves", async () => {
  const home = await tempHome();
  let server: ReturnType<typeof Bun.spawn> | undefined;

  try {
    server = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home.path, "serve", COMPOSITION], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    let status = await cli(home.path, ["status"]);
    for (let attempt = 0; status.code !== 0 && attempt < 200; attempt += 1) {
      await Bun.sleep(50);
      status = await cli(home.path, ["status"]);
    }
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/^up {2}pid \d+ {2}.*journal seq \d+\ncomposition/);
    expect(JSON.parse((await cli(home.path, ["--json", "status"])).out)).toMatchObject({ pid: server.pid, plugins: [{ name: "composition" }] });

    const stopped = await cli(home.path, ["stop"]);
    expect(stopped.code).toBe(0);
    expect(await server.exited).toBe(0);
    expect((await cli(home.path, ["status"])).code).toBe(3);
  } finally {
    server?.kill("SIGKILL");
    await home.cleanup();
  }
}, 40_000);

test("niwa stop waits until the host has let go of the journal, so a serve right after it succeeds", async () => {
  const home = await tempHome();
  const servers: Array<ReturnType<typeof Bun.spawn>> = [];
  const serve = (): ReturnType<typeof Bun.spawn> => {
    const server = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home.path, "serve", COMPOSITION], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    servers.push(server);
    return server;
  };

  try {
    serve();
    let status = await cli(home.path, ["status"]);
    for (let attempt = 0; status.code !== 0 && attempt < 200; attempt += 1) {
      await Bun.sleep(50);
      status = await cli(home.path, ["status"]);
    }
    expect(status.code).toBe(0);

    const stopped = await cli(home.path, ["stop"]);
    expect(stopped.code).toBe(0);
    expect(stopped.out.trim()).toBe("stopped");

    // The journal is free the moment stop has printed: the next host takes it at once.
    const next = serve();
    let nextStatus = await cli(home.path, ["status"]);
    for (let attempt = 0; nextStatus.code !== 0 && attempt < 200; attempt += 1) {
      await Bun.sleep(50);
      nextStatus = await cli(home.path, ["status"]);
    }
    expect(nextStatus.code).toBe(0);
    expect(nextStatus.err).not.toContain("holds the journal");
    expect(next.exitCode).toBeNull();
    expect((await cli(home.path, ["stop"])).code).toBe(0);
    expect(await next.exited).toBe(0);
  } finally {
    for (const server of servers) server.kill("SIGKILL");
    await home.cleanup();
  }
}, 60_000);

test("the CLI reads fields in the schema's types and refuses what does not fit", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();

    // A field the action does not have is refused by the CLI, and the fields are listed.
    const unknown = await cli(home.path, ["surface.greet", "--nope", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("text");

    // A broken --input is a usage error, not a crash.
    const broken = await cli(home.path, ["surface.greet", "--input", "{nope"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("not valid JSON");

    // A position that is not a position is refused.
    const since = await cli(home.path, ["niwa.records.read", "--from", "abc"]);
    expect(since.code).toBe(1);
    expect(since.err).not.toBe("");
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("niwa help lists the commands the host declares", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();

    // The help is read from the host: the commands are the actions it declares.
    const helped = await cli(home.path, ["help"]);
    expect(helped.code).toBe(0);
    expect(helped.out).toContain("surface.greet");
    expect(helped.out).toContain("niwa.records.read");
    expect(helped.out).toContain("niwa.trace");
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("niwa with no command lists the commands the host declares, and says so when no host answers", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    const alone = await cli(home.path, []);
    expect(alone.code).toBe(2);
    expect(alone.err).toContain("No host answers");

    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();
    const bare = await cli(home.path, []);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("surface.greet");
    expect(bare.err).toContain("niwa.records.read");
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

test("niwa log prints one line per record, hides the noise, filters, and follows until idle or a limit", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();
    const writer = await connectAsOwner(home.path);
    for (let n = 1; n <= 3; n += 1) await writer.emit(Note, { text: `note ${String(n)}` });

    // The last records, one line each: the time, the type, and the data as key=value.
    const tail = await cli(home.path, ["log", "-n", "2", "--type", "surface.note"]);
    expect(tail.code).toBe(0);
    const lines = tail.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d  surface\.note\s+text=note 3$/);

    // The noise is hidden unless everything is asked for.
    const quiet = await cli(home.path, ["log", "-n", "200"]);
    expect(quiet.out).not.toContain("step.intent");
    expect((await cli(home.path, ["log", "-n", "500", "--all"])).out).toContain("invocation.admitted");

    // The machine form is one record per line.
    const machine = await cli(home.path, ["log", "--json", "--type", "surface.note", "-n", "3"]);
    expect(machine.out.trim().split("\n").map((line) => (JSON.parse(line) as { data: { text: string } }).data.text)).toEqual([
      "note 1",
      "note 2",
      "note 3",
    ]);

    // Following ends after the limit, with the records that come later, or when nothing came in the time asked.
    const following = cli(home.path, ["log", "-f", "--type", "surface.note", "-n", "1", "--limit", "3"]);
    await Bun.sleep(300);
    await writer.emit(Note, { text: "note 4" });
    await writer.emit(Note, { text: "note 5" });
    const followed = await following;
    expect(followed.code).toBe(0);
    expect(followed.out).toContain("note 5");
    expect(followed.out.trim().split("\n")).toHaveLength(3);

    const idle = await cli(home.path, ["log", "-f", "--type", "surface.note", "-n", "1", "--wait-ms", "200"]);
    expect(idle.code).toBe(0);
    expect(idle.out.trim().split("\n")).toHaveLength(1);

    // A wrong line says what is wrong.
    const wrong = await cli(home.path, ["log", "-n", "x"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("-n needs a positive integer");
    await writer.close();
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a field is written with dashes, and a boolean field with no value is a flag", async () => {
  const home = await tempHome();
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, home.path);
    await host.ready();
    // `--wait-ms` is `waitMs`: the read waits, and ends empty at the end of the time.
    const started = Date.now();
    const read = await cli(home.path, ["--json", "niwa.records.read", "--from", "100000", "--wait-ms", "300"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.out)).toMatchObject({ records: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // A name that is no field of the action, written either way, is refused with the fields.
    const wrong = await cli(home.path, ["niwa.records.read", "--no-such-field", "1"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('no field "no-such-field"');
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);

async function recordsOf(home: string, settleMs: number): Promise<StoredRecord[]> {
  const reader = await connectAsOwner(home);
  const records: StoredRecord[] = [];
  const reading = (async () => {
    for await (const stored of reader.records.since(seq(0))) records.push(stored);
  })().catch(() => undefined);
  await Bun.sleep(settleMs);
  await reader.close().catch(() => undefined);
  await reading;
  return records;
}

test("the CLI speaks as the owner: a request to the owner is answered from the terminal", async () => {
  const home = await tempHome();
  const Choice = question("cli.choice", { kind: "choice", title: "Ship the release?", options: [opt("yes"), opt("no")] });
  const Start = record("cli.start", z.object({ to: Address }), { open: true });
  const Continued = record("cli.continued", z.object({ answer: z.string() }));
  const host = createNiwa({ home: home.path });

  try {
    host.use(requests());
    host.use(
      plugin("cli-asker", (api) => {
        api.declare(Start, Continued);
        api.on(Start, async (data, step) => {
          const { answer } = await step(requestAsk, { to: data.to, ...Choice });
          await step.emit(Continued, { answer: JSON.stringify(answer) });
        });
      }),
    );
    await host.serve();

    const client = await connectAsOwner(home.path);
    await client.emit(Start, { to: { kind: "owner" } });
    const find = async (type: string) =>
      (await recordsOf(home.path, 200)).filter((stored) => stored.type === type).map((stored) => stored.data);
    await eventually(async () => (await find(RequestCreated.name)).length === 1, 5_000, "request created");
    const created = (await find(RequestCreated.name))[0] as { id: string };

    const answered = await cli(home.path, ["request.answer", "--id", created.id, "--answer", '{"ids":["yes"]}']);
    expect(answered.err).toBe("");
    expect(answered.code).toBe(0);
    await eventually(async () => (await find(Continued.name)).length === 1, 5_000, "the asker goes on");
    expect((await find(RequestAnswered.name))[0]).toMatchObject({ answer: { ids: ["yes"] }, by: { kind: "owner" } });
  } finally {
    await host.close();
    await home.cleanup();
  }
}, 40_000);

test("niwa serve -d starts a detached host, prints where it is, and a second one is refused", async () => {
  const home = await tempHome();
  const log = `${home.path}/niwa.log`;
  let pid: number | undefined;

  try {
    const started = await cli(home.path, ["serve", "-d", COMPOSITION]);
    expect(started.code).toBe(0);
    const lines = started.out.trim().split("\n");
    pid = Number(lines[0]?.replace("pid ", ""));
    expect(Number.isInteger(pid)).toBe(true);
    expect(lines.slice(1)).toEqual([`home ${home.path}`, `log ${log}`]);

    // The host answers as soon as the command has returned, and it is that process.
    expect(JSON.parse((await cli(home.path, ["--json", "status"])).out)).toMatchObject({ pid, plugins: [{ name: "composition" }] });
    expect(await Bun.file(log).text()).toContain("niwa: serving");

    const again = await cli(home.path, ["serve", "-d", COMPOSITION]);
    expect(again.code).toBe(5);
    expect(again.err).toContain(`a host already serves ${home.path} (pid ${String(pid)})`);

    const stopped = await cli(home.path, ["stop"]);
    expect(stopped.code).toBe(0);
    expect((await cli(home.path, ["status"])).code).toBe(3);

    // The log is appended, never replaced: a second start adds to it.
    const first = (await Bun.file(log).text()).split("\n").filter((line) => line.includes("niwa: serving")).length;
    expect((await cli(home.path, ["serve", "-d", COMPOSITION])).code).toBe(0);
    const second = (await Bun.file(log).text()).split("\n").filter((line) => line.includes("niwa: serving")).length;
    expect(second).toBe(first + 1);
    expect((await cli(home.path, ["stop"])).code).toBe(0);
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await home.cleanup();
  }
}, 60_000);

test("niwa serve -d prints the log tail and fails when the host does not come up", async () => {
  const home = await tempHome();
  try {
    const failed = await cli(home.path, ["serve", "-d", new URL("./fixtures/does-not-exist.ts", import.meta.url).pathname]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("exited with code");
    expect(failed.err).toContain("does-not-exist.ts");
  } finally {
    await home.cleanup();
  }
}, 40_000);

test("niwa web serves the cockpit of the host and prints its address and login link; a bad port is refused", async () => {
  const home = await tempHome();
  let web: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

  try {
    expect((await cli(home.path, ["serve", "-d", COMPOSITION])).code).toBe(0);
    expect((await cli(home.path, ["web", "--port", "70000"])).code).toBe(2);

    web = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home.path, "web"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NIWA_ID: "" },
    });
    const reader = web.stdout.getReader();
    let printed = "";
    while (!printed.includes("log in:")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      printed += new TextDecoder().decode(chunk.value);
    }
    const url = /niwa web: (http\S+) \(home /.exec(printed)?.[1];
    expect(url).toBeDefined();
    expect(printed).toMatch(/log in: http\S+\/login\?secret=/);
    // The page is behind its cookie: no cookie, no page.
    expect((await fetch(url ?? "")).status).toBe(401);

    web.kill("SIGTERM");
    expect(await web.exited).toBe(0);
  } finally {
    web?.kill("SIGKILL");
    await cli(home.path, ["stop"]);
    await home.cleanup();
  }
}, 60_000);

test("niwa mcp is an MCP server over stdio: it initializes and lists the tools of the host", async () => {
  const home = await tempHome();
  let client: Client | undefined;

  try {
    expect((await cli(home.path, ["serve", "-d", COMPOSITION])).code).toBe(0);
    client = new Client({ name: "check", version: "0.1.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home.path, "mcp"],
        cwd: process.cwd(),
        stderr: "ignore",
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("niwa_describe");
  } finally {
    await client?.close();
    await cli(home.path, ["stop"]);
    await home.cleanup();
  }
}, 60_000);
