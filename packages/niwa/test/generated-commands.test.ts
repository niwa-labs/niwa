// Generated surfaces, on the CLI.
//
// "Declare a new action in a plugin. It appears as an MCP tool and as
// a CLI command with no change to either surface."
//
// The check runs the real CLI (bin/niwa.ts) against a real host process
// (test/fixtures/surface-host.ts):
//
//   1. "niwa describe" lists the actions the host declares
//   2. "niwa <action> --field value" calls the action: the output comes back
//   3. "niwa <action> --json '{...}'" calls the action the other way
//   4. a plugin declares a new action — the action is installed in the running host
//   5. the new action is a command at once, with no change to the CLI
//   6. the machine form is JSON, and a failure exits non-zero with the host's code
//

import { expect, test } from "bun:test";

import { spawnHost, tempHome } from "@niwa-labs/testing";

const HOST_SCRIPT = new URL("./fixtures/surface-host.ts", import.meta.url).pathname;

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
async function cli(home: string, args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { out, err, code };
}

test("generated surfaces: a new action is a CLI command, with no change to the CLI", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();

    // 1. The description lists the actions of the host.
    const described = await cli(homePath, ["niwa.describe"]);
    expect(described.code).toBe(0);
    expect(described.out).toContain("surface.greet");
    expect(described.out).toContain("text: string");

    // 1b. The commands are exactly the described actions: the CLI keeps no list of its own.
    const listed = await cli(homePath, ["--json", "niwa.describe"]);
    expect(listed.code).toBe(0);
    const actions = (JSON.parse(listed.out) as { actions: Array<{ name: string }> }).actions;
    const helped = await cli(homePath, ["help"]);
    expect(helped.code).toBe(0);
    for (const action of actions) expect(helped.out).toContain(action.name);

    // 2. A command of an action calls the action: the fields come from the command line.
    const greeted = await cli(homePath, ["surface.greet", "--text", "hello"]);
    expect(greeted.code).toBe(0);
    expect(greeted.out).toContain("ok: true");

    // 3. The whole input may be given as JSON.
    const whoami = await cli(homePath, ["--json", "surface.whoami", "--json", '{"caller":"liar"}']);
    expect(whoami.code).toBe(0);
    const answered = JSON.parse(whoami.out) as { caller: string; kind: string };
    expect(answered.kind).toBe("client");
    // The caller is the connection, not the claim.
    expect(answered.caller).not.toBe("liar");

    // 4. A plugin declares a new action: the action is installed in the running host.
    const added = await cli(homePath, ["surface.add-action"]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("ok: true");

    // 5. The new action is a command at once. Nothing in the CLI changed.
    const pong = await cli(homePath, ["surface.extra-ping"]);
    expect(pong.code).toBe(0);
    expect(pong.out).toContain("pong: true");

    // The description says it too.
    const after = await cli(homePath, ["niwa.describe"]);
    expect(after.out).toContain("surface.extra-ping");

    // 6. The machine form is JSON, and a failure exits non-zero with the host's code.
    const machine = await cli(homePath, ["--json", "surface.greet", "--text", "hello"]);
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.out)).toEqual({ ok: true });

    // A command that is not there fails, and says so.
    const unknown = await cli(homePath, ["no.such.action"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("no.such.action");

    // An input the action does not accept is refused by the host, and the refusal is
    // the exit code of the command.
    const badInput = await cli(homePath, ["surface.greet", "--text"]);
    expect(badInput.code).not.toBe(0);
    expect(badInput.err).not.toBe("");
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 40_000);
