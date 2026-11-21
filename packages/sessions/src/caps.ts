/**
 * The ceiling of a harness: how many of its sessions may run a turn at once on this host.
 *
 * A session holds a slot while it runs a turn: from the moment a start, a send or an ask into it is
 * let through until the journal says its turn ended, or the session did, or the ask was answered.
 * A session that sleeps between turns holds nothing, and neither does one this host does not
 * follow: its process is not this host's, and nor does a turn that began before this host served.
 * A session counts once however many calls go into it, and a call into a session that holds a slot
 * already is let through: it joins that session's queue, not the harness's. What a slot is held by
 * is read from the journal at every look; only the calls on their way to the harness are counted
 * in memory, until the turn they began is in the journal.
 *
 * A call over the ceiling waits until a slot is free, in the order nothing promises.
 */

import type { JournalReader, Seq } from "@niwa-labs/core";
import type { DeliveryReceipt } from "@niwa-labs/harness";

import type { SessionRef } from "./identity.ts";
import { SessionEnded, SessionTurnEnded, SessionTurnStarted } from "./records.ts";

/** How long a waiting call sleeps before it looks again when nothing is committed. */
const LOOK_AGAIN_MS = 1000;

/** A slot that was let through: told the session its call reached, and let go when the call is over. */
export interface Slot {
  /** The call reached a session: a turn that the receipt says began or waits holds the slot until it ends. */
  reached(ref: SessionRef, receipt: DeliveryReceipt | undefined): void;
  /** The call is over, or began no turn: the slot is free. */
  release(): void;
}

export interface CapsDeps {
  readonly journal: () => JournalReader | undefined;
  readonly untilCommit: (ms: number) => Promise<void>;
  /** The sessions this host follows now. */
  readonly followed: () => Iterable<SessionRef>;
  /** The harness a session is of. */
  readonly harnessOf: (ref: SessionRef) => string;
  /** The last record before this host served: a turn that began at or before it is one a process of another host ran. */
  readonly servedAfter: () => Seq;
}

const FREE: Slot = { reached() {}, release() {} };

/** The ceilings of the harnesses that have one, and the slots their sessions hold. */
export class HarnessCaps {
  /** The starts let through that have not named a session yet, by harness. */
  readonly #going = new Map<string, number>();
  /** The calls into a session that are going now, by session. */
  readonly #into = new Map<SessionRef, number>();
  /** The sessions a call reached whose turn the journal does not show yet, with the position the call was let through at. */
  readonly #reached = new Map<SessionRef, Seq>();
  /** Wakes the calls that wait when a slot is let go here. */
  #wake: () => void = () => {};
  #woken = new Promise<void>((resolve) => {
    this.#wake = resolve;
  });

  constructor(
    private readonly caps: Readonly<Record<string, number>>,
    private readonly deps: CapsDeps,
  ) {
    for (const [harness, cap] of Object.entries(caps)) {
      if (!Number.isInteger(cap) || cap < 1) throw new TypeError(`the ceiling of harness "${harness}" must be a whole number of at least 1, got ${String(cap)}`);
    }
  }

  /**
   * Waits for a slot of the harness and takes it: for a new session, or for the session `into`. A harness with no
   * ceiling, and a session that holds a slot already, are let through at once.
   */
  async admit(harness: string, into?: SessionRef): Promise<Slot> {
    const cap = this.caps[harness];
    if (cap === undefined) return FREE;
    for (;;) {
      const busy = this.#busy(harness);
      if ((into !== undefined && busy.sessions.has(into)) || busy.count < cap) break;
      const woken = this.#woken;
      await Promise.race([this.deps.untilCommit(LOOK_AGAIN_MS), woken]);
    }
    // What the journal says after this moment is about the turn this call may begin.
    const admitted = this.#last();
    if (into === undefined) this.#going.set(harness, (this.#going.get(harness) ?? 0) + 1);
    else this.#into.set(into, (this.#into.get(into) ?? 0) + 1);
    let held = true;
    const leave = (): void => {
      if (!held) return;
      held = false;
      if (into === undefined) this.#going.set(harness, (this.#going.get(harness) ?? 1) - 1);
      else {
        const left = (this.#into.get(into) ?? 1) - 1;
        if (left > 0) this.#into.set(into, left);
        else this.#into.delete(into);
      }
    };
    return {
      reached: (ref, receipt) => {
        // A message that joined a running turn began none of its own.
        if (receipt !== undefined && receipt.status !== "delivered") this.#reached.set(ref, admitted);
        leave();
        this.#notify();
      },
      release: () => {
        leave();
        this.#notify();
      },
    };
  }

  /** The slots of a harness that are held now, and the sessions that hold them. */
  #busy(harness: string): { count: number; sessions: Set<SessionRef> } {
    const journal = this.deps.journal();
    const sessions = new Set<SessionRef>();
    for (const ref of new Set([...this.deps.followed(), ...this.#reached.keys(), ...this.#into.keys()])) {
      if (this.deps.harnessOf(ref) !== harness) continue;
      if (this.#into.has(ref) || (journal !== undefined && this.#running(journal, ref))) sessions.add(ref);
    }
    return { count: sessions.size + (this.#going.get(harness) ?? 0), sessions };
  }

  /** Does the session run a turn: its last turn began and did not end, or a call reached it and its turn has not begun yet. */
  #running(journal: JournalReader, ref: SessionRef): boolean {
    const last = (type: string): Seq | undefined => journal.find({ type: type as never, field: "session", equals: ref }).at(-1)?.seq;
    const start = last(SessionTurnStarted.name);
    const began = start === undefined || start <= this.deps.servedAfter() ? undefined : start;
    const ended = Math.max(last(SessionTurnEnded.name) ?? 0, last(SessionEnded.name) ?? 0);
    const reached = this.#reached.get(ref);
    if (reached !== undefined) {
      // The journal caught up with the call: from here it says whether the turn runs.
      if ((began !== undefined && began > reached) || ended > reached) this.#reached.delete(ref);
      else return true;
    }
    return began !== undefined && began > ended;
  }

  /** The position of the latest record. */
  #last(): Seq {
    return this.deps.journal()?.last() ?? (0 as Seq);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#woken = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    wake();
  }
}
