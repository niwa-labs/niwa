/**
 * Loops: each round runs in a branch of its own (`r1`, `r2`, ...) of the loop's scope, so what a
 * round calls, a helper inside it included, is keyed by its round. Every loop has a most rounds,
 * and says whether it stopped there.
 */

import { map } from "./group.ts";
import { checkKey, script } from "./script.ts";
import type { Seat } from "./script.ts";
import { passes } from "./types.ts";
import type { Attempt, Judged, Settled } from "./types.ts";

/** Check a most rounds: a whole number, at least one. */
function checkMax(max: number, what: string): number {
  if (!Number.isInteger(max) || max < 1) throw new TypeError(`${what}: the most rounds is a whole number, at least one, not ${String(max)}`);
  return max;
}

/** Step a state until `done` says it is, or for `max` rounds. A state that is done from the start takes no round. */
export async function loop<S>(
  key: string,
  opts: { init: S; step: (state: S, round: number) => Promise<S>; done: (state: S) => boolean; max: number },
): Promise<{ state: S; rounds: number; hitMax: boolean }> {
  checkKey(key, "the key of a loop");
  checkMax(opts.max, "loop");
  return script().scope(key, undefined, async (s) => {
    let state = opts.init;
    let rounds = 0;
    while (!opts.done(state)) {
      if (rounds === opts.max) return { state, rounds, hitMax: true };
      rounds += 1;
      const before = state;
      const round = rounds;
      state = await s.start(`r${String(round)}`, () => opts.step(before, round)).value();
    }
    return { state, rounds, hitMax: false };
  });
}

/**
 * Gather items round by round until `quietRounds` rounds in a row bring nothing new (one by
 * default), or `max` rounds (ten by default). An item is new when `same` matches none seen.
 */
export async function saturate<T>(
  key: string,
  opts: { step: (seen: T[], round: number) => Promise<T[]>; same: (a: T, b: T) => boolean; quietRounds?: number; max?: number },
): Promise<{ items: T[]; rounds: number; saturated: boolean }> {
  checkKey(key, "the key of a saturation");
  const max = checkMax(opts.max ?? 10, "saturate");
  const quietRounds = checkMax(opts.quietRounds ?? 1, "saturate (quiet rounds)");
  return script().scope(key, undefined, async (s) => {
    const items: T[] = [];
    let quiet = 0;
    for (let round = 1; round <= max; round += 1) {
      const seen = [...items];
      const found = await s.start(`r${String(round)}`, () => opts.step(seen, round)).value();
      let fresh = 0;
      for (const item of found) {
        if (items.some((one) => opts.same(one, item))) continue;
        items.push(item);
        fresh += 1;
      }
      quiet = fresh === 0 ? quiet + 1 : 0;
      if (quiet >= quietRounds) return { items, rounds: round, saturated: true };
    }
    return { items, rounds: max, saturated: false };
  });
}

/** Every combination of a grid, in the order of its keys and values. */
export function gridCells<P>(grid: Record<string, readonly P[]>): Record<string, P>[] {
  let cells: Record<string, P>[] = [{}];
  for (const [name, values] of Object.entries(grid)) cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [name]: value })));
  return cells;
}

/** A cell of a grid that ran: its parameters, how it ended, and its score, which is null for a cell that failed. */
export type GridCell<P, R> = { params: Record<string, P>; result: Settled<R>; score: number | null };

/**
 * Run every cell of a grid of parameters and score it. A cell that failed has no score (null), and
 * a score of a cell that ran must be a finite number; `best` is the index of the cell with the
 * highest score, the first of equals, or -1 when every cell failed.
 */
export async function paramGrid<P, R>(
  key: string,
  opts: { grid: Record<string, readonly P[]>; run: (cell: Record<string, P>) => Promise<R>; score: (result: R) => number; concurrency?: number },
): Promise<{ cells: GridCell<P, R>[]; best: number }> {
  checkKey(key, "the key of a grid");
  const params = gridCells(opts.grid);
  const results = await map(
    key,
    params.map((cell, index) => ({ cell, key: `c${String(index)}` })),
    { key: (one) => one.key, ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }) },
    (one) => opts.run(one.cell),
  );
  const cells = results.map((result, index): GridCell<P, R> => {
    const score = result.ok ? opts.score(result.value) : null;
    if (score !== null && !Number.isFinite(score)) throw new TypeError(`paramGrid "${key}": the score of the cell c${String(index)} is ${String(score)}, a finite number is needed`);
    return { params: params[index] as Record<string, P>, result, score };
  });
  let best = -1;
  cells.forEach((cell, index) => {
    if (cell.score !== null && (best < 0 || cell.score > ((cells[best] as GridCell<P, R>).score as number))) best = index;
  });
  return { cells, best };
}

/**
 * Write, judge, and write again with the judgement, until a judgement passes or for `max` rounds
 * (three by default). The first round's `write` gets no feedback. `INCONCLUSIVE` is not a pass.
 */
export async function revise<T>(
  key: string,
  opts: { write: (feedback: Judged | null, round: number) => Promise<T>; judge: (value: T, round: number) => Promise<Judged>; max?: number },
): Promise<Attempt<T>> {
  checkKey(key, "the key of a revision");
  const max = checkMax(opts.max ?? 3, "revise");
  return script().scope(key, undefined, async (s) => {
    const history: Judged[] = [];
    let feedback: Judged | null = null;
    let last: { value: T; judged: Judged } | undefined;
    for (let round = 1; round <= max; round += 1) {
      const given = feedback;
      last = await s
        .start(`r${String(round)}`, async () => {
          const value = await opts.write(given, round);
          return { value, judged: await opts.judge(value, round) };
        })
        .value();
      history.push(last.judged);
      if (passes(last.judged)) return { value: last.value, judged: last.judged, rounds: round, history, stopped: "accepted" as const };
      feedback = last.judged;
    }
    const final = last as { value: T; judged: Judged };
    return { value: final.value, judged: final.judged, rounds: max, history, stopped: "max-rounds" as const };
  });
}

/**
 * `revise` up a ladder of seats: round one writes with the first seat, each round after a failed
 * judgement with the next one, as many rounds as there are seats.
 */
export function escalate<T>(
  key: string,
  opts: { seats: readonly Seat[]; write: (seat: Seat, feedback: Judged | null, round: number) => Promise<T>; judge: (value: T, round: number) => Promise<Judged> },
): Promise<Attempt<T>> {
  if (opts.seats.length === 0) return Promise.reject(new TypeError("escalate: give at least one seat"));
  return revise(key, { max: opts.seats.length, write: (feedback, round) => opts.write(opts.seats[round - 1] as Seat, feedback, round), judge: opts.judge });
}
