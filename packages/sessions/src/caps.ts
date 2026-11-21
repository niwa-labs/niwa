/**
 * The ceiling of a harness: how many of its sessions may run a turn at once on this host.
 *
 * A session holds a slot while it runs a turn: from the moment a start or a send into it is let
 * through until the journal says its turn ended, or the session did. A session that sleeps between
 * turns holds nothing, and neither does one this host does not follow: its process is not this
 * host's, and nor does a turn that began before this host did. What a slot is held by is read from
 * the journal at every look; only the calls on their way to the harness are counted in memory,
 * until the turn they began is in the journal.
 *
 * A start or a send over the ceiling waits until a slot is free, in the order nothing promises.
 */

import type { JournalReader, Seq } from "@niwa-labs/core";
import type { DeliveryReceipt } from "@niwa-labs/harness";

import type { SessionRef } from "./identity.ts";
import { SessionEnded, SessionTurnEnded, SessionTurnStarted } from "./records.ts";

/** How long a waiting call sleeps before it looks again when nothing is committed. */
const LOOK_AGAIN_MS = 1000;

/** A slot that was let through: told the session its call reached, and let go when the call failed. */
export interface Slot {
  /** The call reached a session: a turn that the receipt says began or waits holds the slot until it ends. */
  reached(ref: SessionRef, receipt: DeliveryReceipt | undefined): void;
  /** The call began no turn: the slot is free. */
  release(): void;
}

export interface CapsDeps {
  readonly journal: () => JournalReader | undefined;
  readonly untilCommit: (ms: number) => Promise<void>;
  /** The sessions this host follows now. */
  readonly followed: () => Iterable<SessionRef>;
  /** The harness a session is of. */
  readonly harnessOf: (ref: SessionRef) => string;
  /** When this host began: a turn that began before it is one a process of another host ran. */
  readonly since: number;
}

const FREE: Slot = { reached() {}, release() {} };

/** The ceilings of the harnesses that have one, and the slots their sessions hold. */
export class HarnessCaps {
  /** The calls let through that have not reached a session yet, by harness. */
  readonly #going = new Map<string, number>();
  /** The sessions a call reached whose turn the journal does not show yet, with the position it was reached at. */
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

  /** Waits for a slot of the harness and takes it. A harness with no ceiling is always let through. */
  async admit(harness: string): Promise<Slot> {
    const cap = this.caps[harness];
    if (cap === undefined) return FREE;
    while (this.#busy(harness) >= cap) {
      const woken = this.#woken;
      await Promise.race([this.deps.untilCommit(LOOK_AGAIN_MS), woken]);
    }
    this.#going.set(harness, (this.#going.get(harness) ?? 0) + 1);
    let held = true;
    const leave = (): void => {
      if (!held) return;
      held = false;
      this.#going.set(harness, (this.#going.get(harness) ?? 1) - 1);
    };
    return {
      reached: (ref, receipt) => {
        leave();
        // A message that joined a running turn began none of its own.
        if (receipt !== undefined && receipt.status !== "delivered") this.#reached.set(ref, this.#last());
        this.#notify();
      },
      release: () => {
        leave();
        this.#notify();
      },
    };
  }

  /** The slots of a harness that are held now. */
  #busy(harness: string): number {
    const journal = this.deps.journal();
    const refs = new Set<SessionRef>([...this.deps.followed(), ...this.#reached.keys()]);
    let busy = this.#going.get(harness) ?? 0;
    for (const ref of refs) {
      if (this.deps.harnessOf(ref) !== harness) continue;
      if (journal !== undefined && this.#running(journal, ref)) busy += 1;
    }
    return busy;
  }

  /** Does the session run a turn: its last turn began and did not end, or a call reached it and its turn has not begun yet. */
  #running(journal: JournalReader, ref: SessionRef): boolean {
    const latest = (type: string) => journal.find({ type: type as never, field: "session", equals: ref }).at(-1);
    const last = (type: string): Seq | undefined => latest(type)?.seq;
    const start = latest(SessionTurnStarted.name);
    const began = start === undefined || start.at < this.deps.since ? undefined : start.seq;
    const ended = Math.max(last(SessionTurnEnded.name) ?? 0, last(SessionEnded.name) ?? 0);
    const reached = this.#reached.get(ref);
    if (reached !== undefined) {
      // The journal caught up with the call: from here it says whether the turn runs.
      if ((began !== undefined && began > reached) || ended > reached) this.#reached.delete(ref);
      else return ended <= reached;
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
