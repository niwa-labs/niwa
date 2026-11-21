/**
 * insert.ts — `niwa insert report`: the command an insert reports through.
 *
 * An insert runs inside a harness (a hook of Claude Code, an extension of pi) and is no client of
 * the host. It runs this command and gives one event, as JSON, on stdin. The command connects to
 * the host at the home and calls the action `insert.report`; the host writes the record.
 *
 * The command connects without a token on purpose: the hooks of a harness report without one
 * (the `default` profile may call `insert.report`), and the `NIWA_ID` a session carries in its
 * environment must not make the report a call of that session.
 *
 *     echo '{"kind":"compacted","session":{"harness":"pi","native":"s1"}}' | niwa insert report
 *
 * Exit codes: 0 reported, 1 the host refused or is not there, 2 the command line or the event is
 * not usable.
 */

import { connect } from "@niwa-labs/client";
import { actionName } from "@niwa-labs/core";
import type { CliResult } from "./index.ts";

/**
 * The name of the action the command calls: the one the harness module declares as
 * `INSERT_REPORT_ACTION`. The CLI is a client and imports no harness, so the name is written here too.
 */
export const INSERT_REPORT = "insert.report";

/** What the command says of itself. */
export const INSERT_USAGE = "usage: niwa insert report   (the event as JSON on stdin)";

/** Where the event comes from: stdin, unless a test says otherwise. */
export type EventSource = () => Promise<string>;

/** Run `niwa insert <args>` against the host at `home`. */
export async function runInsert(
  args: readonly string[],
  home: string,
  readEvent: EventSource = () => Bun.stdin.text(),
): Promise<CliResult> {
  if (args[0] !== "report" || args.length !== 1) return { output: INSERT_USAGE, code: 2 };

  let event: unknown;
  try {
    event = JSON.parse(await readEvent());
  } catch (error) {
    return { output: `niwa insert report: the event on stdin is not JSON: ${String(error)}`, code: 2 };
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return { output: "niwa insert report: the event on stdin must be a JSON object", code: 2 };
  }

  let api: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    api = await connect({ home, id: "insert-report" });
    await api.call(actionName(INSERT_REPORT), event as never);
    return { output: "", code: 0 };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    return {
      output: `niwa insert report: ${error instanceof Error ? error.message : String(error)}`,
      code: 1,
      ...(code === undefined ? {} : { errorCode: code }),
    };
  } finally {
    await api?.close().catch(() => {});
  }
}
