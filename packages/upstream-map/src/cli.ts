// Measure the mapping of the upstream snapshot: `upstream-map <command>`.
//
//   check    [--upstream <checkout>] [--head <rev> | --worktree] [--map <file>] [--out <file>] [--summary]
//            validate the mapping, report coverage of the upstream text, and what became of each entry's ranges since
//            the commits they were recorded at. Draws no conclusion. `--out` writes the whole report as JSON;
//            `--summary` prints one line of JSON numbers instead of the text. A map that cannot be read at all is one
//            problem, said in the same form. It also holds the texts the scripts import to the map, counted apart (`textProblems`):
//            the exit is 1 whenever the map or a text has a problem.
//   advance  [--upstream <checkout>] [--head <rev>]   record the unchanged entries at the current commits
//   accept   <id>... [--upstream <checkout>] [--head <rev>]   record the named entries at the carried positions
//   assemble [--check]   write the texts the scripts import from the mapping; with `--check`, only compare them
//   refresh  <checkout> [<commit>]   take a new snapshot of an upstream checkout, at a commit of it
//
// `--upstream` is needed only when the mapping has ranges at an upstream commit other than the snapshot's.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { formatReport, summaryOf, unreadable } from "./format.ts";
import { Git } from "./git.ts";
import { refreshUpstream } from "./snapshot.ts";
import { differingTexts, openMap, recordMap, WORKTREE, writeAssembled } from "./tool.ts";
import type { ToolContext, UpstreamMapConfig } from "./tool.ts";

/** The value of a flag, and the arguments that are not flags. */
function parse(args: readonly string[], valued: readonly string[]): { flags: Map<string, string | true>; words: string[] } {
  const flags = new Map<string, string | true>();
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) words.push(arg);
    else if (valued.includes(arg)) flags.set(arg, args[(i += 1)] ?? "");
    else flags.set(arg, true);
  }
  return { flags, words };
}

const usage = (): number => {
  console.error("usage: upstream-map check|advance|accept|assemble|refresh (see the head of this file)");
  return 2;
};

/** Run the map commands for a downstream package and return the process exit code. */
export function runUpstreamMapCli(config: UpstreamMapConfig, argv: readonly string[] = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  const { flags, words } = parse(rest, ["--upstream", "--head", "--out", "--map"]);
  const text = (flag: string): string | undefined => {
    const value = flags.get(flag);
    return typeof value === "string" ? value : undefined;
  };
  const checkout = text("--upstream");
  const map = text("--map");
  const context = (): ToolContext => ({
    ...config,
    root: new Git(config.paths.dir).out(["rev-parse", "--show-toplevel"]).trim(),
    ...(checkout === undefined ? {} : { checkout }),
    head: flags.has("--worktree") ? WORKTREE : (text("--head") ?? "HEAD"),
    ...(map === undefined ? {} : { map }),
  });

  if (command === "check") {
    const out = text("--out");
    let opened: ReturnType<typeof openMap>;
    try {
      opened = openMap(context());
    } catch (error) {
      // Keep unreadable maps in the same summary format as the other problems.
      const said = unreadable(error);
      if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify({ error: said.error }, null, 2)}\n`);
      console.log(flags.has("--summary") ? JSON.stringify(said) : `PROBLEMS 1\n  the map could not be read: ${said.error}`);
      return 1;
    }
    const { report } = opened;
    if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(flags.has("--summary") ? JSON.stringify(summaryOf(report)) : formatReport(report));
    return report.problems.length === 0 && report.texts.length === 0 ? 0 : 1;
  } else if (command === "advance" || command === "accept") {
    const changed = recordMap(context(), command === "advance" ? "unchanged" : words);
    console.log(`${command === "advance" ? "advanced" : "accepted"}: ${String(changed)} entries recorded`);
  } else if (command === "assemble") {
    if (flags.has("--check")) {
      const wrong = differingTexts(context());
      if (wrong.length > 0) {
        console.error(`these texts differ from the mapping: ${wrong.join(", ")}`);
        return 1;
      }
      console.log("the texts match the mapping");
    } else console.log(`${String(writeAssembled(context()))} texts written`);
  } else if (command === "refresh") {
    const [checkout, commit] = words;
    if (checkout === undefined) return usage();
    const source = refreshUpstream(resolve(checkout), config.snapshot, { upstream: config.paths.upstream, ...(commit === undefined ? {} : { commit }) });
    console.log(`snapshot taken at ${source.commit}`);
  } else {
    return usage();
  }
  return 0;
}
