/**
 * log.ts — `niwa log`: the journal as a person reads a log, like `journalctl` or `kubectl logs`.
 *
 * Every filter is one of the filters of `niwa.records.read`, so what the CLI shows and what an
 * MCP client or a script reads for the same filter are the same records. Following is a read that
 * waits for a commit, again and again; nothing in the CLI watches the journal itself.
 *
 *     niwa log                       the last 20 records, without the noise
 *     niwa log -f --run run-1a2b     what the run does, as it does it
 *     niwa log --type 'workflow.*' --since 10m
 */

import { z } from "zod";

import { RECORDS_READ_ACTION, storedRecordSchema } from "@niwa-labs/client";
import type { RecordFilterInput, Seq, StoredRecord } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";
import { seq, resolveId } from "@niwa-labs/core";
import { logLine } from "./render.ts";

/** What the command line of `niwa log` said. */
interface LogOptions {
  tail: number | undefined;
  limit: number | undefined;
  follow: boolean;
  waitMs: number | undefined;
  from: number;
  stream: string | undefined;
  filter: RecordFilterInput;
  json: boolean;
}

/** What a read answers with, as the wire carries it. */
const Read = z.object({ records: z.array(storedRecordSchema), next: z.number() });

/** The record a session niwa started is named in: its pair, and the id niwa gave it. */
const SessionStarted = z.object({ session: z.string(), id: z.string() });

/**
 * The ids niwa gave the sessions it started, by their pair, as the journal holds them now.
 *
 * The records of a session name it by its pair; a line names it by its id, and `--session` takes it.
 */
async function sessionIdsOf(api: NiwaApi): Promise<Map<string, string>> {
  const found = Read.parse(await api.call(RECORDS_READ_ACTION, { from: 0, filter: { types: ["session.started"] } }));
  const ids = new Map<string, string>();
  for (const record of found.records) {
    const started = SessionStarted.safeParse(record.data);
    if (started.success) ids.set(started.data.session, started.data.id);
  }
  return ids;
}

/**
 * The pair `--session` stands for: the session whose id the text is, or the start or the end of.
 * A text that names no id is taken as it is: the pair, or the start of the harness's own id.
 */
function sessionFilterOf(text: string, ids: ReadonlyMap<string, string>): string {
  const named = resolveId(text, [...ids.values()], "session");
  return named === undefined ? text : ([...ids].find(([, id]) => id === named)?.[0] ?? text);
}

/** The records that say what niwa did rather than what happened: shown with `--all`. */
const NOISE = ["!session.activity", "!niwa.step.decision", "!niwa.step.intent"];

/** The number of records a bare `niwa log` shows. */
const DEFAULT_TAIL = 20;

/** How long a follow waits for a commit before it asks again. */
const POLL_MS = 30_000;

const UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The usage line of `niwa log`, for the errors that name it. */
export const LOG_USAGE =
  "niwa log [-n N] [-f] [--run ID] [--session ID] [--request ID] [--task ID] [--type T]... [--actor A] [--stream S] " +
  "[--grep TEXT] [--since SEQ|10m] [--until SEQ|10m] [--limit N] [--wait-ms N] [--all] [--json]";

/** A wrong command line of `niwa log`. */
export class LogUsage extends Error {
  override name = "LogUsage";
}

function numberOf(name: string, text: string | undefined): number {
  const value = Number(text);
  if (text === undefined || !Number.isInteger(value) || value < 1) throw new LogUsage(`${name} needs a positive integer, got "${String(text)}"`);
  return value;
}

/** A position, or a span of time before now: `120` is the position 120, `10m` is ten minutes ago. */
function pointOf(name: string, text: string | undefined, now: number): { seq: number } | { at: number } {
  const unit = /^(\d+)(ms|s|m|h|d)$/.exec(text ?? "");
  if (unit !== null) return { at: now - Number(unit[1]) * (UNITS[unit[2] ?? "ms"] ?? 1) };
  const position = Number(text);
  if (text === undefined || !Number.isInteger(position) || position < 0) {
    throw new LogUsage(`${name} needs a position or a span of time (120, 10m, 2h), got "${String(text)}"`);
  }
  return { seq: position };
}

function optionsOf(args: readonly string[], json: boolean, now: number): LogOptions {
  const types: string[] = [];
  const filter: { -readonly [K in keyof RecordFilterInput]: RecordFilterInput[K] } = {};
  const options: LogOptions = { tail: undefined, limit: undefined, follow: false, waitMs: undefined, from: 0, stream: undefined, filter, json };
  let all = false;
  let since = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const takes = (): string => {
      const value = args[index + 1];
      if (value === undefined) throw new LogUsage(`${argument} needs a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "-n": options.tail = numberOf("-n", takes()); break;
      case "-f": options.follow = true; break;
      case "--json": options.json = true; break;
      case "--all": all = true; break;
      case "--limit": options.limit = numberOf("--limit", takes()); break;
      case "--wait-ms": options.waitMs = numberOf("--wait-ms", takes()); break;
      case "--stream": options.stream = takes(); break;
      case "--type": types.push(takes()); break;
      case "--run": filter.run = takes(); break;
      case "--session": filter.session = takes(); break;
      case "--request": filter.request = takes(); break;
      case "--task": filter.task = takes(); break;
      case "--actor": filter.actor = takes(); break;
      case "--grep": filter.grep = takes(); break;
      case "--since": {
        const point = pointOf("--since", takes(), now);
        since = true;
        if ("seq" in point) options.from = point.seq;
        else filter.after = point.at;
        break;
      }
      case "--until": {
        const point = pointOf("--until", takes(), now);
        if ("seq" in point) filter.until = point.seq;
        else filter.before = point.at;
        break;
      }
      default:
        throw new LogUsage(`unexpected argument "${argument}"; usage: ${LOG_USAGE}`);
    }
  }
  // The noise is hidden unless the records were asked for by type or `--all` asked for everything.
  if (types.length === 0 && !all) types.push(...NOISE);
  if (types.length > 0) filter.types = types;
  // Without a span or a count, the last records; with a span, all that it holds.
  if (options.tail === undefined && !since && filter.after === undefined && options.limit === undefined) options.tail = DEFAULT_TAIL;
  return options;
}

/** Run `niwa log`: print what it was asked for, and with `-f` go on printing. */
export async function log(
  api: NiwaApi,
  args: readonly string[],
  json: boolean,
  width: number,
  out: (text: string) => void,
): Promise<void> {
  const options = optionsOf(args, json, Date.now());
  const sessions = await sessionIdsOf(api);
  if (options.filter.session !== undefined) options.filter.session = sessionFilterOf(options.filter.session, sessions);
  const read = async (from: Seq, extra: { tail?: number; limit?: number; waitMs?: number }) =>
    Read.parse(
      await api.call(RECORDS_READ_ACTION, {
        from,
        filter: options.filter,
        ...(options.stream === undefined ? {} : { stream: options.stream }),
        ...extra,
      }),
    );
  const show = (records: readonly StoredRecord[]): void => {
    for (const record of records) {
      const started = record.type === "session.started" ? SessionStarted.safeParse(record.data) : undefined;
      if (started?.success === true) sessions.set(started.data.session, started.data.id);
      out(options.json ? JSON.stringify(record) : logLine(record, width, sessions));
    }
  };

  const first = await read(seq(options.from), {
    ...(options.tail === undefined ? {} : { tail: options.tail }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  show(first.records);
  if (!options.follow) return;

  let from = seq(first.next);
  let shown = first.records.length;
  while (options.limit === undefined || shown < options.limit) {
    const more = await read(from, {
      waitMs: options.waitMs ?? POLL_MS,
      ...(options.limit === undefined ? {} : { limit: options.limit - shown }),
    });
    show(more.records);
    shown += more.records.length;
    from = seq(more.next);
    // With `--wait-ms` the follow ends when nothing came in that time: for a caller that is not a person at a terminal.
    if (more.records.length === 0 && options.waitMs !== undefined) return;
  }
}
