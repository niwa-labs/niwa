/**
 * A fake harness: an installation with a control side that serves no process.
 *
 * It names a session for every start, records what it was asked, and answers an ask with a fixed
 * value, so a check can run the sessions module, the executor or an agent against a real host
 * without any program behind it. A check that needs more than this (a failing start, a stream of
 * signs of life) keeps its own control side.
 */

import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
} from "@niwa-labs/harness";
import type { HarnessBinding } from "@niwa-labs/harness";

/** The id the fake harness installation has unless a check names another. */
export const FAKE_HARNESS = "fake-harness";

/** The control side of the fake harness: it records, it serves nothing. */
export class FakeControl implements SessionControl {
  /** The prompts the sessions were started with, in order, each as the text of its sections. */
  readonly started: string[] = [];
  /** The questions the sessions were asked, in order. */
  readonly asked: string[] = [];
  /** The messages sent into sessions, in order. */
  readonly sent: string[] = [];
  /** What a session answers to an ask. */
  answer: unknown;
  /** Whether an ask blocks, never answering. */
  blockAsk = false;

  readonly #harness: string;

  constructor(harness: string, answer: unknown) {
    this.#harness = harness;
    this.answer = answer;
  }

  /** How many sessions were started. */
  get starts(): number {
    return this.started.length;
  }

  async start(options: { prompt: { sections: { text: string }[] } }): Promise<{ session: SessionId }> {
    this.started.push(options.prompt.sections.map((section) => section.text).join("\n"));
    return { session: sessionId(harnessId(this.#harness), `session-${String(this.started.length)}`) };
  }

  async resume(): Promise<void> {}

  async send(_id: SessionId, message: string): Promise<DeliveryReceipt> {
    this.sent.push(message);
    return { status: "started", turn: this.sent.length };
  }

  async interrupt(): Promise<void> {}

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    this.asked.push(options.prompt.sections.map((section) => section.text).join("\n"));
    if (this.blockAsk) await new Promise<void>(() => {});
    return { session: id, value: this.answer as T, at: 0 as never };
  }

  async *life(): AsyncIterable<LifeEvent> {
    // The fake has no signs of life.
  }

  async state(): Promise<SessionState> {
    return "idle";
  }
}

/** What a check may set on the fake harness. */
export interface FakeHarnessOptions {
  /** The id of the installation: `session.start({ harness })` names it. */
  readonly id?: string;
  /** What a session answers to an ask. */
  readonly answer?: unknown;
}

/** A fake installation, its control side, and the binding the sessions module takes. */
export interface FakeHarness {
  readonly instance: Harness;
  readonly control: FakeControl;
  readonly binding: HarnessBinding;
}

/** A fake harness: an installation that can start, resume, send, ask, and nothing else. */
export function fakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
  const id = options.id ?? FAKE_HARNESS;
  const control = new FakeControl(id, options.answer ?? { result: "done" });
  const instance: Harness = {
    id: harnessId(id),
    kind: harnessKind("fake-kind"),
    machine: machineId("machine-1"),
    home: "/tmp/fake-home",
    sides: {
      control: {
        start: true,
        resume: true,
        send: true,
        interrupt: false,
        ask: true,
        structuredOutput: true,
        launch: { model: false, effort: [], modes: [] },
        tools: { niwaOnly: false, allow: false },
      },
    },
  };
  return { instance, control, binding: { instance, control } };
}
