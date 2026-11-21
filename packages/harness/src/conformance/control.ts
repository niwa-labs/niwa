/**
 * The conformance suite of the control side.
 *
 * The control side starts processes, so the suite runs against whatever the kind gives it: a
 * real installation or a fake process that implements the interface. It checks what niwa relies
 * on: the harness names the session, the abilities it declares work, and the signs of life come.
 *
 * The signs of life are forward-only: a watcher sees what happens after it subscribed, never
 * what happened before. So the suite subscribes before every action that starts a turn and
 * waits for the turn that subscription sees end. The one exception is the first turn: it begins
 * inside the start, before there is an id to watch, so the side keeps its signs for the first
 * stream opened on the session, and the suite opens that stream right after the start. A turn that does not end before the deadline
 * fails its check with a message that says so: the suite waits, but it never waits forever.
 */

import { z } from "zod";

import { requireAbility, supports, Unavailable, Unsupported } from "../capabilities.ts";
import type { ControlCapabilities } from "../capabilities.ts";
import { DeliveryReceiptSchema, LifeEventSchema, describeToolsMode, promptFromText } from "../control.ts";
import type { LifeEvent, SessionControl, ToolsMode } from "../control.ts";
import { excessOf } from "../declaration.ts";
import type { KindCapabilities } from "../declaration.ts";
import type { Harness } from "../instance.ts";
import type { SessionId } from "../reading.ts";

import { attempt, collector } from "./reading.ts";
import type { ConformanceReport } from "./reading.ts";

/** The control side under test, the installation that declares it, and what its kind declares. */
export interface ControlConformanceSides {
  readonly instance: Harness;
  readonly control: SessionControl;
  /** What the kind declares it can serve; the installation is checked against it when given. */
  readonly declared?: KindCapabilities;
  /**
   * How many messages the harness has been sent so far, when the side under test can tell: a
   * refusal is then checked to have sent nothing.
   */
  readonly dispatched?: () => Promise<number>;
}

/**
 * How long one turn may take before the check that waits for it fails.
 *
 * The deadline is what keeps the suite from hanging on a side whose turn never ends.
 */
const TURN_DEADLINE_MS = 120_000;

export function controlConformance(
  kind: string,
  { instance, control, declared, dispatched }: ControlConformanceSides,
): () => Promise<ConformanceReport> {
  return async () => {
    const { check, report } = collector(kind);
    if (declared !== undefined) {
      // The installation is bounded by its kind: an ability, a model choice, an effort level or
      // a mode its kind does not declare is a promise nobody can keep.
      const excess = excessOf(instance.sides, declared, {
        reading: instance.sides.reading !== undefined,
        control: true,
        insert: instance.sides.insert !== undefined,
      });
      check("capabilities: the installation claims no more than the kind declares", excess.length === 0, excess.join(", "));

      // A tool mode the kind declares it cannot hold is refused by the side itself, by name,
      // before anything reaches the harness: a session must never start with tools on silently.
      const refused: Array<["niwaOnly" | "allow", ToolsMode]> = [
        ["niwaOnly", "niwa-only"],
        ["allow", { allow: [] }],
      ];
      for (const [name, mode] of refused) {
        if (declared.control.tools[name].supported) continue;
        const before = dispatched === undefined ? undefined : await dispatched();
        let refusal: unknown;
        try {
          const started = await control.start({ prompt: promptFromText("the conformance suite"), tools: mode });
          refusal = new Error(`the side started ${started.session.native}`);
        } catch (error) {
          refusal = error;
        }
        check(
          `tools: ${describeToolsMode(mode)} is refused by the side when the kind cannot hold it`,
          refusal instanceof Unsupported && refusal.side === "control" && refusal.ability === "start",
          refusal instanceof Error ? refusal.message : String(refusal),
        );
        if (before !== undefined && dispatched !== undefined) {
          const after = await dispatched();
          check(`tools: a refused ${describeToolsMode(mode)} sends nothing to the harness`, after === before, `${after - before} messages were sent`);
        }
      }
    }
    if (!supports(instance, "control", "start")) {
      check("the side declares it can start", false, "control.start is not declared");
      return report();
    }

    // Every sign of life the suite has seen; the checks on them come at the end.
    const signs: LifeEvent[] = [];

    // the harness names the session; its identity is the harness id and that name.
    //
    // The start returns once the session is named; it does not wait for the first turn. The
    // prompt is that turn, delivered like a send, and the start says what became of it.
    const started = await attempt("start: the harness names the session", check, () =>
      control.start({ prompt: promptFromText("the conformance suite") }),
    );
    if (started === undefined) return report();
    const session = started.session;
    check("start: the name is not empty", session.native.length > 0);
    check(
      "start: the session belongs to the installation",
      session.harness === instance.id,
      `the session is of "${session.harness}", the installation is "${instance.id}"`,
    );

    // The first turn: the start gives its receipt, and its end is observed like the end of any
    // turn. It is waited for before anything else drives the session, so the checks below begin
    // on a session that is not busy.
    const first = started.first;
    check(
      "start: the first message has a receipt that says it started or queued a turn",
      first !== undefined &&
        DeliveryReceiptSchema.safeParse(first).success &&
        (first.status === "started" || first.status === "queued"),
      first === undefined ? "the start gave no receipt for its prompt" : `the receipt says "${first.status}"`,
    );
    if (first !== undefined) {
      const wait = nextTurnEnd(control, session);
      const seen = await attempt("start: the first turn ends, as the signs of life show", check, () => wait.ended);
      if (seen !== undefined && first.turn !== undefined) {
        check(
          "start: the first turn that ends is the turn of the receipt",
          seen.some((event) => event.kind === "turn-ended" && event.turn === first.turn),
          `the receipt names turn ${first.turn}`,
        );
      }
      signs.push(...wait.seen);
    }

    // What the side declares it can do, it does.
    if (supports(instance, "control", "resume")) {
      // Resuming without a prompt begins no turn, so there is no turn to wait for.
      await attempt("resume: the session resumes by its id", check, () => control.resume(session));
      const wait = nextTurnEnd(control, session);
      const resumed = await attempt("resume: the session resumes with a prompt", check, async () => {
        await control.resume(session, { prompt: promptFromText("the conformance suite") });
        return true;
      });
      if (resumed !== true) wait.cancel();
      else await attempt("resume: the turn it began has ended", check, () => wait.ended);
      signs.push(...wait.seen);
    }
    if (supports(instance, "control", "send")) {
      const wait = nextTurnEnd(control, session);
      const receipt = await attempt("send: the message is accepted", check, () =>
        control.send(session, "the conformance suite"),
      );
      if (receipt === undefined) {
        wait.cancel();
      } else {
        check("send: the receipt says what happened", DeliveryReceiptSchema.safeParse(receipt).success);
        check("send: a receipt that says the message was handled names no turn", receipt.status !== "handled" || receipt.turn === undefined);
        // A message the harness handled itself began no turn: there is no end to wait for.
        if (receipt.status === "handled") wait.cancel();
        else await attempt("send: the turn it began has ended", check, () => wait.ended);
      }
      signs.push(...wait.seen);
    }
    if (supports(instance, "control", "ask")) {
      const wait = nextTurnEnd(control, session);
      const answer = await attempt("ask: an answer comes back", check, () =>
        control.ask(session, { schema: z.string(), prompt: promptFromText("answer with a word") }),
      );
      if (answer === undefined) {
        wait.cancel();
      } else {
        check("ask: the answer passed the schema", z.string().safeParse(answer.value).success);
        await attempt("ask: the turn it began has ended", check, () => wait.ended);
      }
      signs.push(...wait.seen);
    }
    if (supports(instance, "control", "send") && supports(instance, "control", "ask")) {
      // A question to a busy session waits behind what runs, like a send: the message begins a
      // turn, and the question comes straight after it, while that turn may still be running.
      const wait = nextTurnEnd(control, session);
      const sent = await attempt("ask behind a turn: the message that keeps the session busy is sent", check, () =>
        control.send(session, "the conformance suite"),
      );
      if (sent === undefined) {
        wait.cancel();
      } else {
        const answer = await attempt("ask behind a turn: a question to a busy session is answered", check, () =>
          control.ask(session, { schema: z.string(), prompt: promptFromText("answer with a word") }),
        );
        if (answer !== undefined) {
          check("ask behind a turn: the answer passed the schema", z.string().safeParse(answer.value).success);
        }
        await attempt("ask behind a turn: the turn that ran before the question has ended", check, () => wait.ended);
      }
      signs.push(...wait.seen);
    }
    if (supports(instance, "control", "interrupt")) {
      // A turn to interrupt: the suite sends one and cuts it.
      const wait = nextTurnEnd(control, session);
      const sent = await attempt("interrupt: a message to interrupt is sent", check, () =>
        control.send(session, "the conformance suite"),
      );
      if (sent === undefined) {
        wait.cancel();
      } else {
        // The turn must have begun, so the interrupt has a running turn to cut. A turn that
        // ends without its start having been reported fails here, with that reason.
        await attempt("interrupt: the turn began before it was cut", check, () => wait.started);
        await attempt("interrupt: a turn is interrupted", check, async () => {
          try {
            await control.interrupt(session);
          } catch (error) {
            // The turn ended before the interrupt reached it. The side said so by name, and
            // that is its right, not a defect.
            if (!(error instanceof Unavailable)) throw error;
          }
        });
        await attempt("interrupt: the turn it cut has ended", check, () => wait.ended);
      }
      signs.push(...wait.seen);
    }

    // what it does not declare is refused by name.
    for (const ability of ["resume", "send", "interrupt", "ask"] as const satisfies readonly (keyof ControlCapabilities)[]) {
      if (supports(instance, "control", ability)) continue;
      let refusal: unknown;
      try {
        requireAbility(instance, "control", ability);
      } catch (error) {
        refusal = error;
      }
      check(
        `refusal: ${ability} is refused by name when it is not declared`,
        refusal instanceof Error && refusal.name === "Unsupported",
      );
    }

    // the turn started and the turn ended are both reported. A side that cannot drive a
    // turn has no turn to report, so the checks apply to the sides that can.
    const drives = (["resume", "send", "ask"] as const).some((ability) =>
      supports(instance, "control", ability),
    );
    if (drives) {
      check("life: every sign is a known one", signs.every((event) => LifeEventSchema.safeParse(event).success));
      check("life: the turn started is reported", signs.some((event) => event.kind === "turn-started"));
      check("life: the turn ended is reported", signs.some((event) => event.kind === "turn-ended"));
    }

    const state = await attempt("state: the side says what the session is doing", check, () => control.state(session));
    if (state !== undefined) {
      check("state: it is one of running, idle, unknown", ["running", "idle", "unknown"].includes(state));
    }
    return report();
  };
}

/** A wait for the end of the next turn of a session. */
interface TurnEnd {
  /** The signs of life seen until the turn ended. */
  readonly ended: Promise<LifeEvent[]>;
  /** The sign of life that the turn began, when the turn began. */
  readonly started: Promise<LifeEvent>;
  /** The signs of life seen so far, also when the wait did not end in a turn. */
  readonly seen: LifeEvent[];
  /** Gives the wait up: the suite stops watching the session. */
  cancel(): void;
}

/**
 * Waits for the end of the next turn of a session.
 *
 * The subscription is made when this is called, before the action that starts the turn: the
 * stream is forward-only, so a watcher that arrives after the turn ended sees nothing of it.
 * When the deadline passes, the wait is refused with a message that says what did not happen,
 * and the stream is closed: the suite fails the check instead of hanging.
 */
function nextTurnEnd(control: SessionControl, session: SessionId, deadlineMs = TURN_DEADLINE_MS): TurnEnd {
  const seen: LifeEvent[] = [];
  let settle: ((value: LifeEvent[]) => void) | undefined;
  let refuse: ((reason: Error) => void) | undefined;
  let giveUp: (() => void) | undefined;
  let began: ((value: LifeEvent) => void) | undefined;
  let beganNever: ((reason: Error) => void) | undefined;
  let hasBegun = false;

  const ended = new Promise<LifeEvent[]>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  // The waits may be given up before anyone awaits them; an unhandled refusal is noise.
  void ended.catch(() => undefined);

  const started = new Promise<LifeEvent>((resolve, reject) => {
    began = resolve;
    beganNever = reject;
    // The start wait ends when the end wait does: both wait for the same turn.
    void ended.catch((error: unknown) =>
      reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
  void started.catch(() => undefined);

  // One promise for the whole wait: a wait given up in one turn is given up in the next.
  const givenUp = new Promise<{ kind: "given up" }>((resolve) => {
    giveUp = () => resolve({ kind: "given up" });
  });

  void (async () => {
    const deadline = Date.now() + deadlineMs;
    const iterator = control.life(session)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          refuse?.(new Error(`the turn did not end within ${deadlineMs} ms`));
          return;
        }
        // The first next() registers the watcher, before the action that starts the turn.
        const next = await Promise.race([
          iterator.next().then((value) => ({ kind: "event" as const, value })),
          expiry(remaining),
          givenUp,
        ]);
        if (next.kind === "timeout") {
          refuse?.(new Error(`the turn did not end within ${deadlineMs} ms`));
          return;
        }
        if (next.kind === "given up") {
          refuse?.(new Error("the wait for the turn was given up"));
          return;
        }
        if (next.value.done === true) {
          refuse?.(new Error("the session ended before a turn did"));
          return;
        }
        seen.push(next.value.value);
        if (next.value.value.kind === "turn-started") {
          hasBegun = true;
          began?.(next.value.value);
        }
        if (next.value.value.kind === "turn-ended") {
          // A turn that ends before its start was reported leaves nothing for `started` to wait for.
          if (!hasBegun) beganNever?.(new Error("the turn ended without its start having been reported"));
          settle?.(seen);
          return;
        }
      }
    } catch (error) {
      refuse?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // The stream is closed, but not waited for: a generator that waits inside for its next
      // event would keep the suite waiting for it, and that is the hang this suite avoids.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  })();

  return { ended, started, seen, cancel: () => giveUp?.() };

  /** A promise that ends when the deadline is near. */
  function expiry(ms: number): Promise<{ kind: "timeout" }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}
