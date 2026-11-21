/**
 * The script helper of the proc module: run a check (tests, a build, a coverage measure) and read
 * how it went.
 *
 *   import { runCheck } from "@niwa-labs/proc/flow"
 *   const tests = await runCheck("tests", { cmd: ["bun", "test"], cwd: wt.path, timeout: "10m" })
 *   if (!tests.ok) ...
 *
 * It runs inside a workflow script on its globals (`scope`, `call`), read when it is called, so it
 * imports nothing at all: a script that imports it pulls no more of niwa into its check. The call
 * is made in a scope named by the key, so two checks need two keys and a check may run again in
 * each round of a loop.
 *
 * A check runs with `proc.run`, in a box. A check whose environment holds a secret reference runs
 * with `proc.exec`, which has no box: the run's grant has to name that action.
 */

/** A duration as a script writes it: milliseconds, or "500ms", "30s", "5m", "2h". */
export type Duration = number | string;

/** A reference to a secret of the host, `secret("name")` of core: resolved where the command starts. */
export type SecretRef = { secret: string };

/** An artifact of the host: the whole output of a command. */
export type ArtifactRef = { digest: string; size: number; type: string };

/** A check: the command, where it runs, how long it may take, its environment and the report it prints. */
export type Check = {
  cmd: string[];
  cwd: string;
  timeout?: Duration;
  env?: Record<string, string | SecretRef>;
  /**
   * The structured report the command prints at the end of its output: `json` its last line, `junit` the
   * counts of its test suites, `lcov` the lines found and hit.
   */
  report?: "junit" | "lcov" | "json";
};

/** How a check went: whether it passed, its exit code, the end of its output, its report, and the whole output. */
export type CheckResult = { ok: boolean; exit: number | null; summary: string; report?: unknown; artifact: ArtifactRef };

/** What `proc.run` and `proc.exec` answer, as far as a check reads it. */
type ProcAnswer = { outcome: "exited" | "timed-out" | "cancelled"; exit: number | null; tail: string; output: ArtifactRef };

interface Globals {
  call(name: string, input: unknown): Promise<unknown>;
  scope<T>(name: string, opts: undefined, fn: () => Promise<T>): Promise<T>;
}

function globals(): Globals {
  const found = globalThis as unknown as Partial<Globals>;
  for (const name of ["call", "scope"] as const) {
    if (typeof found[name] !== "function") throw new Error(`@niwa-labs/proc/flow runs inside a workflow script: "${name}" is not a global here`);
  }
  return found as Globals;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** A duration in milliseconds. */
export function durationMs(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const parsed = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(duration);
  if (parsed === null) throw new TypeError(`not a duration: ${JSON.stringify(duration)} (milliseconds, or a number with ms, s, m or h)`);
  return Math.round(Number(parsed[1]) * (UNITS[parsed[2] as string] as number));
}

/** How long a check may run when it does not say: ten minutes. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** The most lines of the end of the output a summary keeps. */
const SUMMARY_LINES = 20;

const lines = (text: string): string[] => text.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");

/**
 * The report a command printed, read from the end of its output: undefined when the output does not hold
 * one. Only the end of the output is read, so a report has to come last.
 */
export function reportOf(kind: NonNullable<Check["report"]>, tail: string): unknown {
  if (kind === "json") {
    const last = lines(tail).at(-1);
    if (last === undefined) return undefined;
    try {
      return JSON.parse(last) as unknown;
    } catch {
      return undefined;
    }
  }
  if (kind === "lcov") {
    let found = 0;
    let hit = 0;
    for (const line of lines(tail)) {
      const lf = /^LF:(\d+)$/.exec(line);
      const lh = /^LH:(\d+)$/.exec(line);
      if (lf !== null) found += Number(lf[1]);
      if (lh !== null) hit += Number(lh[1]);
    }
    return found === 0 ? undefined : { found, hit, coverage: hit / found };
  }
  let seen = false;
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const tag of tail.match(/<testsuite\b[^>]*>/g) ?? []) {
    seen = true;
    for (const name of ["tests", "failures", "errors", "skipped"] as const) {
      const value = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
      if (value !== null) counts[name] += Number(value[1]);
    }
  }
  return seen ? counts : undefined;
}

/** Run a check and read it: it passes when the command exited with 0 in its time. */
export async function runCheck(key: string, check: Check): Promise<CheckResult> {
  const g = globals();
  const timeout = check.timeout === undefined ? DEFAULT_TIMEOUT_MS : durationMs(check.timeout);
  const secret = Object.values(check.env ?? {}).some((value) => typeof value !== "string");
  const input = { cmd: check.cmd, cwd: check.cwd, timeout, ...(check.env === undefined ? {} : { env: check.env }) };
  const answer = (await g.scope(key, undefined, () => g.call(secret ? "proc.exec" : "proc.run", input))) as ProcAnswer;
  const ended =
    answer.outcome === "timed-out" ? `timed out after ${String(timeout)} ms` : answer.outcome === "cancelled" ? "cancelled" : `exited with ${String(answer.exit)}`;
  const summary = [ended, ...lines(answer.tail).slice(-SUMMARY_LINES)].join("\n");
  const report = check.report === undefined ? undefined : reportOf(check.report, answer.tail);
  return {
    ok: answer.outcome === "exited" && answer.exit === 0,
    exit: answer.exit,
    summary,
    ...(report === undefined ? {} : { report }),
    artifact: answer.output,
  };
}
