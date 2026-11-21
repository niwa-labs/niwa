/**
 * The conformance suite of the insert side.
 *
 * The insert reports what cannot be seen from outside. The suite reads the events the side
 * yields and holds the side to what its installation declares: an event it reports is an ability
 * it declares, and an ability it declares is one it showed.
 */

import { supports } from "../capabilities.ts";
import type { InsertCapabilities } from "../capabilities.ts";
import type { Harness } from "../instance.ts";
import { InsertEventSchema } from "../insert.ts";
import type { HarnessInsert, InsertEvent } from "../insert.ts";

import { attempt, collector } from "./reading.ts";
import type { ConformanceReport } from "./reading.ts";

/** The insert side under test, and the installation that declares it. */
export interface InsertConformanceSides {
  readonly instance: Harness;
  readonly insert: HarnessInsert;
  /**
   * How long the suite waits for events from a stream that has neither ended nor given another,
   * in milliseconds. A live source is silent between events; the suite reads what comes in this
   * time and says which declared events it did not reach.
   */
  readonly eventWaitMs?: number;
}

/** The ability that each kind of event shows. */
const EVENT_ABILITY = {
  "nested-spawned": "nested",
  compacted: "compaction",
  "opened-by-hand": "manualOpen",
  "permission-asked": "permission",
  "session-ended": "end",
} as const satisfies Record<InsertEvent["kind"], keyof InsertCapabilities>;

/** Events read at most; a side that never ends its stream must not hang the suite. */
const EVENT_LIMIT = 32;

/** How long the suite waits for the next event of an open stream, unless told otherwise. */
const EVENT_WAIT_MS = 5_000;

export function insertConformance(
  kind: string,
  { instance, insert, eventWaitMs = EVENT_WAIT_MS }: InsertConformanceSides,
): () => Promise<ConformanceReport> {
  return async () => {
    const { check, report } = collector(kind);

    // A side that is put into the harness has no stream to read: it reports its events itself.
    const stream = insert.events?.bind(insert);
    check("the side either yields events or is put into the harness", stream !== undefined || insert.install !== undefined);

    // The stream was open and silent when the time ran out.
    let waitedOut = false;
    const events =
      stream === undefined
        ? []
        : await attempt("events: the side yields its events", check, async () => {
            const seen: unknown[] = [];
            const iterator = stream()[Symbol.asyncIterator]();
            const deadline = Date.now() + eventWaitMs;
            try {
              while (seen.length < EVENT_LIMIT) {
                const remaining = deadline - Date.now();
                const next = await waitFor(iterator.next(), remaining);
                if (next === undefined) {
                  waitedOut = true;
                  break;
                }
                if (next.done === true) break;
                seen.push(next.value);
              }
            } finally {
              // The subscription is closed, but not waited for: a generator that waits inside for
              // its next event would keep the suite waiting for it.
              void Promise.resolve(iterator.return?.()).catch(() => undefined);
            }
            return seen;
          });
    if (events === undefined) return report();

    const parsed = events.map((event) => InsertEventSchema.safeParse(event));
    check("events: every event is a known one", parsed.every((result) => result.success));
    const known = parsed.flatMap((result) => (result.success ? [result.data] : []));

    // An event is an ability declared, and an ability declared is shown by an event. A side
    // without a stream reports its events itself, so the pair is not checked here.
    if (stream !== undefined) {
      for (const [eventKind, ability] of Object.entries(EVENT_ABILITY)) {
        const seen = known.some((event) => event.kind === eventKind);
        const declared = supports(instance, "insert", ability);
        check(
          `events: ${eventKind} is reported exactly when ${ability} is declared`,
          seen === declared,
          declared
            ? waitedOut
              ? `${ability} is declared and no ${eventKind} came in ${eventWaitMs} ms, while the stream was still open`
              : `${ability} is declared but no ${eventKind} came`
            : `${eventKind} came but ${ability} is not declared`,
        );
      }
    }

    // The answer to a permission question goes back to the side that asked.
    const permission = supports(instance, "insert", "permission");
    check(
      "answers: answerPermission is implemented exactly when permission is declared",
      permission === (insert.answerPermission !== undefined),
    );
    const asked = known.find((event) => event.kind === "permission-asked");
    if (asked !== undefined && insert.answerPermission !== undefined) {
      const answer = insert.answerPermission.bind(insert);
      await attempt("answers: the side carries the answer back", check, () =>
        answer({ requestId: asked.requestId, allow: true }),
      );
    }
    return report();
  };
}

/** What `next` gives, or `undefined` when it gives nothing within `ms`. */
async function waitFor<T>(next: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([next, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
