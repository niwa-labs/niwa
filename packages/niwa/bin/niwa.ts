#!/usr/bin/env bun
// The `niwa` command. The commands that are actions come from `@niwa-labs/cli`, which is a client
// and nothing more; `serve`, `web`, `mcp` and the kinds of `skill` are composed here.
//
// Usage: bun bin/niwa.ts [--home <dir>] <command> [--field value ...]
//
// The commands are the actions the host declares: they are generated from the description, so
// a plugin that declares a new action has a command at once, with no change to this file.
//
// The home of the host: --home, else NIWA_HOME, else ~/.niwa.
//
// The output is for a person by default and for a machine under --json. A failure exits
// non-zero, and the exit code says what went wrong.

import { homedir } from "node:os";

import { homeOf, run, runInsert, runSkill, usageAt } from "@niwa-labs/cli";
import { tokenOf } from "@niwa-labs/client";

import { runMcp } from "../src/mcp.ts";
import { serveComposition, serveDetached } from "../src/serve.ts";
import { KINDS_WITH_SKILLS } from "../src/skills.ts";
import { portOf, runWeb } from "../src/web.ts";

const argv = process.argv.slice(2);

/**
 * Split the command line into the CLI's own flags and the command.
 *
 * The CLI's flags are the ones before the command: `--home`, `--json`. Everything after the
 * command belongs to the command, so an action may have a field called "json" and the CLI does
 * not take it away.
 */
function splitFlags(args: string[]): { flags: string[]; rest: string[] } {
  const flags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--home") {
      const value = args[index + 1];
      if (value === undefined) {
        console.error("--home needs a directory");
        process.exit(2);
      }
      flags.push(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--home=") || argument === "--json") {
      flags.push(argument);
      continue;
    }
    return { flags, rest: args.slice(index) };
  }
  return { flags, rest: [] };
}

const { flags, rest } = splitFlags(argv);
const command = rest[0];

if (command === undefined) {
  const home = homeOf(flags, process.env);
  console.error(await usageAt(home, tokenOf(home)));
  process.exit(2);
}

// `niwa skill` prints and installs the skill niwa ships: a file of niwa's own, so it needs no host.
//
// `niwa serve` starts a host instead of talking to one: it has no host to connect to yet.
// `niwa mcp` and `niwa web` are the other two programs of a home: the MCP server over stdio, and
// the cockpit. Like serve they run until they are stopped.
if (command === "skill") {
  const result = runSkill(rest.slice(1), { home: homedir(), cwd: process.cwd() }, KINDS_WITH_SKILLS);
  (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
} else if (command === "insert") {
  // `niwa insert report`: an insert inside a harness reports an event, given as JSON on stdin.
  const result = await runInsert(rest.slice(1), homeOf(flags, process.env));
  if (result.output !== "") (result.code === 0 ? console.log : console.error)(result.output);
  process.exit(result.code);
} else if (command === "mcp") {
  await runMcp(homeOf(flags, process.env), process.env);
} else if (command === "web") {
  const port = portOf(rest.slice(1));
  if (port === undefined) {
    console.error("usage: niwa web [--port N]  (N between 0 and 65535)");
    process.exit(2);
  }
  await runWeb(homeOf(flags, process.env), port, process.env);
} else if (command === "serve") {
  const detach = rest[1] === "-d";
  const file = rest[detach ? 2 : 1];
  if (file === undefined) {
    console.error("usage: niwa serve [-d] <composition.ts>");
    process.exit(2);
  }
  if (detach) {
    const started = await serveDetached({ file, home: homeOf(flags, process.env), entry: import.meta.path });
    (started.code === 0 ? console.log : console.error)(started.output);
    process.exit(started.code);
  }
  try {
    await serveComposition({ file, home: homeOf(flags, process.env) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  const home = homeOf(flags, process.env);
  const token = tokenOf(home);
  const result = await run(
    {
      home,
      ...(token === undefined ? {} : { token }),
      command,
      args: rest.slice(1),
      json: flags.includes("--json"),
    },
    (text) => console.log(text),
  );
  if (result.code !== 0) {
    console.error(result.output);
    if (result.errorCode !== undefined) console.error(`(${result.errorCode})`);
  } else if (result.output !== "") {
    console.log(result.output);
  }
  process.exit(result.code);
}
