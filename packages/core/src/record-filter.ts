/**
 * The filter of a read of the journal: which records a caller wants,
 * said once for every surface that reads.
 *
 * A filter is data: type patterns, an actor, a subject (a run, a session, a request, a task), a text
 * in the data, a span of time and a span of positions. The host applies it to the records it reads,
 * so the CLI, MCP and any other client get the same answer for the same filter.
 */

import { z } from "zod";

import type { JournalReader, Seq, StoredRecord, StreamId } from "./types.ts";
import { seq } from "./record.ts";

/** The kinds of subject a record may be about. */
const SUBJECTS = ["run", "session", "request", "task"] as const;
type Subject = (typeof SUBJECTS)[number];

/** What a read keeps of the journal. Every field narrows; the fields together are an `and`. */
export const RecordFilterInput = z.object({
  /**
   * Record types as patterns: `workflow.*` is every type that begins `workflow.`, and a pattern that
   * begins `!` leaves its types out. A record is kept when it matches a pattern that does not begin
   * `!` (any, when there is none) and matches none that does.
   */
  types: z.array(z.string().min(1)).optional(),
  /** Who wrote the record: `owner`, `host`, `session:<id>`, `run:<id>`, `client:<id>` or `handler:<id>`; a prefix is enough. */
  actor: z.string().min(1).optional(),
  /** Records about this run: its own, what its steps wrote, the sessions it started and the requests it asked. An id may be a prefix. */
  run: z.string().min(1).optional(),
  /** Records about this session. */
  session: z.string().min(1).optional(),
  /** Records about this request. */
  request: z.string().min(1).optional(),
  /** Records about this task. */
  task: z.string().min(1).optional(),
  /** Records whose data holds this text, in any case. */
  grep: z.string().min(1).optional(),
  /** Only records committed at or after this moment, in milliseconds since the epoch. */
  after: z.number().int().nonnegative().optional(),
  /** Only records committed before this moment. */
  before: z.number().int().nonnegative().optional(),
  /** Only records up to this position. */
  until: z.number().int().nonnegative().optional(),
});
export type RecordFilterInput = z.infer<typeof RecordFilterInput>;

/** How many records one read of the journal takes while a filter scans it. */
const CHUNK = 1000;

/** Every record after a position, up to a position, in order, a chunk at a time; `visit` answers true to stop. */
function scan(
  journal: JournalReader,
  from: Seq,
  to: Seq,
  visit: (record: StoredRecord) => boolean | void,
  stream?: StreamId,
): void {
  let cursor = from;
  for (;;) {
    const chunk = journal.since(cursor, undefined, CHUNK, stream);
    for (const record of chunk) {
      if (record.seq > to || visit(record) === true) return;
    }
    const last = chunk.at(-1);
    if (last === undefined || chunk.length < CHUNK) return;
    cursor = last.seq;
  }
}

/** `workflow.*` as a test of a type name. */
function patternOf(text: string): RegExp {
  return new RegExp(`^${text.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** The principal-or-client name a record's actor goes by: `owner`, `run:<id>`, `client:<id>`, `handler:<id>`, `host`. */
function actorName(record: StoredRecord): string {
  const actor = record.actor;
  if (actor.kind === "host") return "host";
  if (actor.kind === "handler") return `handler:${String(actor.handler)}`;
  return actor.principal === undefined ? `client:${String(actor.id)}` : `${actor.principal.kind}:${String(actor.principal.id)}`;
}

/** The text of a value that may be an id, or an object that holds one. */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") return value.id;
  return undefined;
}

/**
 * The ids a record is about: its data fields named for a subject, the `id` of a record of that
 * subject's own family (`request.created` is about its `id`), and a run that wrote it or asked.
 */
export function mentions(record: StoredRecord, kind: Subject): string[] {
  const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {};
  const found = [idOf(data[kind])];
  if (record.type.startsWith(`${kind}.`)) found.push(idOf(data["id"]));
  if (kind === "run") {
    if (record.actor.kind === "client" && record.actor.principal?.kind === "run") found.push(String(record.actor.principal.id));
    const from = idOf(data["from"]);
    if (from?.startsWith("run:") === true) found.push(from.slice("run:".length));
  }
  return found.filter((id): id is string => id !== undefined);
}

/** Does a recorded id answer to what was asked for: the same id, or the start of it, or of its native part (`harness native`)? */
function answers(have: string, want: string): boolean {
  return have.startsWith(want) || have.split(" ").at(-1)?.startsWith(want) === true;
}

/**
 * What a run is: the records whose data names it, and everything that grew from them.
 *
 * A run is a chain of records: the request that began it is the root of what its steps write, and
 * what its steps start (the sessions, the requests it asks) are about it though their own records
 * name only themselves. The roots are found first, then the sessions and requests written under them.
 *
 * The journal only grows, so what was found up to a position stays found: the closure is kept and
 * extended by the records after the position it reached, and a follow that reads again after each
 * commit pays for the new records and not for the whole journal. Only a root met for the first time
 * goes back over the earlier records, for what its chain had written before the run was named.
 */
class RunClosure {
  private readonly roots = new Set<string>();
  private readonly sessions = new Set<string>();
  private readonly requests = new Set<string>();
  private upTo: Seq = seq(0);

  constructor(private readonly run: string) {}

  /** The position the closure has read the journal to. */
  get reached(): Seq {
    return this.upTo;
  }

  /** Read the records after the position the closure reached, up to `to`. */
  extend(journal: JournalReader, to: Seq): void {
    if (to <= this.upTo) return;
    const fresh = new Set<string>();
    scan(journal, this.upTo, to, (record) => {
      const root = String(record.root);
      if (!this.roots.has(root) && mentions(record, "run").some((id) => answers(id, this.run))) {
        this.roots.add(root);
        fresh.add(root);
      }
      if (this.roots.has(root)) this.take(record);
    });
    if (fresh.size > 0) {
      scan(journal, seq(0), to, (record) => {
        if (fresh.has(String(record.root))) this.take(record);
      });
    }
    this.upTo = to;
  }

  /** What a record of a root of the run starts: its sessions and its requests. */
  private take(record: StoredRecord): void {
    for (const id of mentions(record, "session")) this.sessions.add(id);
    for (const id of mentions(record, "request")) this.requests.add(id);
  }

  /** Is the record of the run? */
  has(record: StoredRecord): boolean {
    return (
      this.roots.has(String(record.root)) ||
      mentions(record, "run").some((id) => answers(id, this.run)) ||
      mentions(record, "session").some((id) => this.sessions.has(id)) ||
      mentions(record, "request").some((id) => this.requests.has(id))
    );
  }
}

/** How many runs a journal keeps a closure of at once. */
const CLOSURES_PER_JOURNAL = 16;

/** The closures kept for a journal, by the run that was asked for; the journal and they go together. */
const closures = new WeakMap<JournalReader, Map<string, RunClosure>>();

/** The closure of a run up to `to`: the kept one, carried on, or a new one when a read is made at a position before it. */
function closureOf(journal: JournalReader, run: string, to: Seq): RunClosure {
  let kept = closures.get(journal);
  if (kept === undefined) {
    kept = new Map();
    closures.set(journal, kept);
  }
  let closure = kept.get(run);
  if (closure !== undefined && closure.reached > to) {
    const past = new RunClosure(run);
    past.extend(journal, to);
    return past;
  }
  if (closure === undefined) {
    closure = new RunClosure(run);
    if (kept.size >= CLOSURES_PER_JOURNAL) {
      const oldest = kept.keys().next();
      if (oldest.done !== true) kept.delete(oldest.value);
    }
  } else {
    kept.delete(run);
  }
  // The most recently asked for is the last: the first of the map is the one that goes.
  kept.set(run, closure);
  closure.extend(journal, to);
  return closure;
}

/**
 * The test a filter makes of a record.
 *
 * It reads the journal when the filter names a run, to find what the run grew into; the journal it
 * reads is the one up to `to`, the position the read is made at, and only from where an earlier read
 * of the same run left off.
 */
export function recordTest(filter: RecordFilterInput, journal: JournalReader, to: Seq): (record: StoredRecord) => boolean {
  const patterns = (filter.types ?? []).map((text) => ({ not: text.startsWith("!"), test: patternOf(text.replace(/^!/, "")) }));
  const wanted = patterns.filter((pattern) => !pattern.not);
  const unwanted = patterns.filter((pattern) => pattern.not);
  const grep = filter.grep?.toLowerCase();
  const inRun = filter.run === undefined ? undefined : closureOf(journal, filter.run, to);
  return (record) => {
    if (wanted.length > 0 && !wanted.some((pattern) => pattern.test.test(record.type))) return false;
    if (unwanted.some((pattern) => pattern.test.test(record.type))) return false;
    if (filter.actor !== undefined && !actorName(record).startsWith(filter.actor)) return false;
    if (filter.after !== undefined && record.at < filter.after) return false;
    if (filter.before !== undefined && record.at >= filter.before) return false;
    if (inRun !== undefined && !inRun.has(record)) return false;
    for (const kind of ["session", "request", "task"] as const) {
      const want = filter[kind];
      if (want !== undefined && !mentions(record, kind).some((id) => answers(id, want))) return false;
    }
    return grep === undefined || (JSON.stringify(record.data) ?? "").toLowerCase().includes(grep);
  };
}

/** What a filtered read found: the records, and the position to read after next. */
export interface Found {
  readonly records: StoredRecord[];
  readonly next: Seq;
}

/**
 * Read the records after a position that pass a filter.
 *
 * `limit` keeps the first matches and `tail` the last ones. `next` is where the next read goes on
 * from: the last record kept when the limit stopped the read, else the position the read reached.
 */
export function readFiltered(
  journal: JournalReader,
  from: Seq,
  filter: RecordFilterInput,
  limits: { limit?: number; tail?: number; stream?: StreamId },
): Found {
  const end = seq(Math.min(journal.last(), filter.until ?? Number.MAX_SAFE_INTEGER));
  const test = recordTest(filter, journal, end);
  const records: StoredRecord[] = [];
  let next = end;
  scan(
    journal,
    from,
    end,
    (record) => {
      if (!test(record)) return false;
      records.push(record);
      if (limits.tail !== undefined && records.length > limits.tail) records.shift();
      if (limits.limit === undefined || records.length < limits.limit) return false;
      next = record.seq;
      return true;
    },
    limits.stream,
  );
  return { records, next: seq(Math.max(next, from)) };
}
