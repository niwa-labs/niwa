/**
 * How an insert tells niwa what it saw: it runs `niwa insert report` and gives the event on stdin.
 *
 * An insert lives inside a harness's own process and is no client of the host. The command is the
 * client: it connects to the host at the home and calls the action `insert.report`. The insert
 * only starts it, so it needs nothing of niwa but the name of the program.
 */

import { spawn } from "node:child_process";

import { NIWA_CLI_ENV } from "./insert.ts";

/** The longest one report may take before the command is stopped. */
const DEFAULT_DEADLINE_MS = 4_000;

/** How much of what the command says on stderr is kept for the error. */
const STDERR_CAP_BYTES = 2 * 1024;

/** Where an event goes. */
export interface InsertReportTarget {
  /** The home of the niwa host. */
  readonly home: string;
  /** The program that runs niwa's CLI. Default: `NIWA_CLI` of the environment, else `niwa`. */
  readonly cli?: string;
  /** The longest the command may run. */
  readonly deadlineMs?: number;
}

/**
 * Hand one event to `niwa insert report`.
 *
 * Resolves when the command ended with success. Rejects with what went wrong: the program could
 * not be run, the command refused (its stderr is in the message) or it did not end in time.
 */
export function reportThroughCli(event: unknown, target: InsertReportTarget): Promise<void> {
  const cli = target.cli ?? nonEmpty(process.env[NIWA_CLI_ENV]) ?? "niwa";
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cli, ["--home", target.home, "insert", "report"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`"${cli} insert report" did not end in time`));
    }, target.deadlineMs ?? DEFAULT_DEADLINE_MS);
    timer.unref?.();

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(new Error(`could not run "${cli}": ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`"${cli} insert report" failed (${code ?? "killed"}): ${stderr.trim()}`));
    });
    // The command may be gone before the event is written: its exit says why.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}
