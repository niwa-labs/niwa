/**
 * Waiting: on the world until a reading of it is settled, and on the owner at a gate.
 */

import type { AskOption, Duration, ScriptRecordQuery } from "@niwa-labs/script";

import { checkKey, script } from "./script.ts";

/**
 * Read the facts until `done` says they are settled. The facts are read first, with the position
 * of the records `on` names: what is settled already is not waited for. Then each round waits for
 * a record `on` names after that position, at most `every`, and reads again. Past `deadline` the
 * outcome is `timed-out`, with the facts last read.
 *
 * A query of one exact type waits for it; any other query is looked at every `every`.
 */
export async function settle<F>(
  key: string,
  opts: { on: ScriptRecordQuery; every: Duration; read: () => Promise<F>; done: (facts: F) => boolean; deadline?: Duration },
): Promise<{ facts: F; outcome: "done" | "timed-out" }> {
  checkKey(key, "the key of a settle");
  const g = script();
  const types = opts.on.types ?? [];
  const only = types.length === 1 && !(types[0] as string).endsWith("*") && opts.on.stream === undefined ? (types[0] as string) : undefined;
  let facts: { value: F } | undefined;
  const settled = await g.scope(key, opts.deadline === undefined ? undefined : { deadline: opts.deadline, onDeadline: "skip" }, async () => {
    let { next } = await g.read.records({ ...opts.on, tail: 1 });
    for (;;) {
      facts = { value: await opts.read() };
      if (opts.done(facts.value)) return true;
      if (only !== undefined) {
        const got = await g.wait(only, { from: next, timeout: opts.every, ...(opts.on.filter === undefined ? {} : { filter: opts.on.filter }) });
        if (!("timedOut" in got)) next = got.at;
      } else {
        await g.sleep(opts.every);
        next = (await g.read.records({ ...opts.on, from: next, tail: 1 })).next;
      }
    }
  });
  if (facts === undefined) throw new Error(`settle "${key}": the deadline passed before the facts were read once`);
  return { facts: facts.value, outcome: settled === true ? "done" : "timed-out" };
}

/** The option a gate adds for the owner to say no. */
const DECLINE = "decline";

/**
 * Ask the owner to choose one of `options`, or to decline. It never throws for a decline, a cancel
 * or a timeout: they are outcomes, and none of them opens the gate.
 */
export async function humanGate<O extends string>(
  key: string,
  opts: { summary: string; options: readonly O[]; recommend?: O; risk?: string; timeout?: Duration },
): Promise<{ outcome: "chosen"; choice: O } | { outcome: "declined" | "expired" | "cancelled" }> {
  checkKey(key, "the key of a gate");
  if (opts.options.length === 0) throw new TypeError(`humanGate "${key}": give at least one option`);
  if ((opts.options as readonly string[]).includes(DECLINE)) throw new TypeError(`humanGate "${key}": "${DECLINE}" is the option the gate adds itself`);
  if (opts.recommend !== undefined && !opts.options.includes(opts.recommend)) throw new TypeError(`humanGate "${key}": the recommended "${opts.recommend}" is not an option`);
  const g = script();
  const text = [opts.summary, ...(opts.risk === undefined ? [] : [`Risk: ${opts.risk}`]), ...(opts.recommend === undefined ? [] : [`Recommended: ${opts.recommend}`])].join("\n\n");
  const options: AskOption[] = [
    ...opts.options.map((id) => (id === opts.recommend ? { id, label: `${id} (recommended)` } : id)),
    { id: DECLINE, label: "Decline" },
  ];
  return g.scope(key, undefined, async () => {
    try {
      const choice = (await g.ask.choice(text, options, opts.timeout === undefined ? {} : { timeout: opts.timeout })) as string;
      return choice === DECLINE ? { outcome: "declined" as const } : { outcome: "chosen" as const, choice: choice as O };
    } catch (error) {
      if (error instanceof Error && error.name === "AskCancelled") return { outcome: "cancelled" as const };
      if (error instanceof Error && error.name === "AskExpired") return { outcome: "expired" as const };
      throw error;
    }
  });
}
