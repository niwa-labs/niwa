// The command line as a process: `bun command.ts [--home <dir>] [--json] <command> [args...]`.
//
// It runs the commands that are actions on a host, the same way a person's shell does, so a test
// can follow a host from outside it.

import { tokenOf } from "@niwa-labs/client";

import { homeOf, run } from "../../src/index.ts";

const argv = process.argv.slice(2);
const flags: string[] = [];
while (argv[0] === "--json" || argv[0] === "--home" || argv[0]?.startsWith("--home=")) {
  const flag = argv.shift() ?? "";
  flags.push(flag);
  if (flag === "--home") flags.push(argv.shift() ?? "");
}
const [command = "", ...args] = argv;

const home = homeOf(flags, process.env);
const token = tokenOf(home);
const result = await run(
  { home, ...(token === undefined ? {} : { token }), command, args, json: flags.includes("--json") },
  (text) => console.log(text),
);
if (result.code !== 0) console.error(result.output);
else if (result.output !== "") console.log(result.output);
process.exit(result.code);
