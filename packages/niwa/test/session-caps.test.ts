// The ceiling of a harness: no more sessions of it run a turn at once than the host allows. A start
// or a send over it waits for a turn to end; a session whose turn ended, or that sleeps, holds nothing.

import { afterEach, expect, test } from "bun:test";

import type { ActionName } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { AskAnswer, DeliveryReceipt, Harness, LifeEvent, SessionControl, SessionId, SessionState, StartedSession } from "@niwa-labs/harness";
import { sessions } from "@niwa-labs/sessions";
import { eventually, tempHome } from "@niwa-labs/testing";

const HARNESS = "capped";

/** A side whose every prompt starts a turn that runs until the test ends it. */
class Turns implements SessionControl {
  starts = 0;
  readonly sends: string[] = [];
  readonly #lives = new Map<string, { queue: LifeEvent[]; wake?: () => void }>();
  readonly #turns = new Map<string, number>();

  #life(native: string) {
    let life = this.#lives.get(native);
    if (life === undefined) {
      life = { queue: [] };
      this.#lives.set(native, life);
    }
    return life;
  }
  #push(native: string, event: LifeEvent): void {
    const life = this.#life(native);
    life.queue.push(event);
    life.wake?.();
  }
  #begin(native: string): DeliveryReceipt {
    const turn = (this.#turns.get(native) ?? 0) + 1;
    this.#turns.set(native, turn);
    this.#push(native, { kind: "turn-started", turn });
    return { status: "started", turn };
  }
  /** Ends the turn the session runs. */
  end(native: string): void {
    this.#push(native, { kind: "turn-ended", turn: this.#turns.get(native) ?? 1 });
  }

  async start(): Promise<StartedSession> {
    this.starts += 1;
    const native = `s${String(this.starts)}`;
    return { session: sessionId(harnessId(HARNESS), native), first: this.#begin(native) };
  }
  async resume(): Promise<void> {}
  async send(id: SessionId, message: string): Promise<DeliveryReceipt> {
    this.sends.push(message);
    return this.#begin(id.native);
  }
  async interrupt(): Promise<void> {}
  async ask<T>(): Promise<AskAnswer<T>> {
    throw new Error("not asked");
  }
  async *life(id: SessionId): AsyncIterable<LifeEvent> {
    const life = this.#life(id.native);
    for (;;) {
      const next = life.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        life.wake = resolve;
      });
    }
  }
  async state(): Promise<SessionState> {
    return "idle";
  }
}

const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: { control: { start: true, resume: true, send: true, interrupt: false, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } } },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function serve(control: SessionControl, caps: Record<string, number>, at?: string): Promise<Host> {
  const home = at === undefined ? await tempHome() : undefined;
  const niwa = createNiwa({ home: at ?? home!.path });
  niwa.use(sessions({ harnesses: [{ instance: installation, control }], caps }));
  await niwa.serve();
  open.push(async () => {
    await niwa.close();
    await home?.cleanup();
  });
  return niwa;
}

const call = <O>(niwa: Host, name: string, input: unknown): Promise<O> => niwa.call(name as ActionName, input) as Promise<O>;
const start = (niwa: Host) => call<{ session: string; ref: string }>(niwa, "session.start", { harness: HARNESS, prompt: "go" });

test("a start over the ceiling of its harness waits until a running turn ends", async () => {
  const control = new Turns();
  const niwa = await serve(control, { [HARNESS]: 1 });
  await start(niwa);
  let second = false;
  const waiting = start(niwa).then((answer) => {
    second = true;
    return answer;
  });
  await Bun.sleep(300);
  expect(second).toBe(false);
  expect(control.starts).toBe(1);
  control.end("s1");
  await waiting;
  expect(control.starts).toBe(2);
});

test("a session whose turn ended holds no slot: a send into another runs, and one into a busy harness waits", async () => {
  const control = new Turns();
  const niwa = await serve(control, { [HARNESS]: 1 });
  const first = await start(niwa);
  control.end("s1");
  await eventually(async () => (await niwa.records.read()).some((row) => row.type === "session.turn-ended"), 5_000, "the turn should end");
  const second = await start(niwa);
  let sent = false;
  const sending = call(niwa, "session.send", { session: first.session, message: "again" }).then(() => {
    sent = true;
  });
  await Bun.sleep(300);
  expect(sent).toBe(false);
  control.end("s2");
  await sending;
  expect(control.sends).toEqual(["again"]);
  expect(second.ref).toBe(`${HARNESS} s2`);
});

test("a harness with no ceiling, or a higher one, runs its sessions at once", async () => {
  const control = new Turns();
  const niwa = await serve(control, { [HARNESS]: 2 });
  await start(niwa);
  await start(niwa);
  expect(control.starts).toBe(2);
});

test("a turn a host before this one left open holds no slot, even once its session is taken on again", async () => {
  const home = await tempHome();
  open.push(home.cleanup);
  const before = await serve(new Turns(), { [HARNESS]: 1 }, home.path);
  const { session } = await start(before);
  await eventually(async () => (await before.records.read()).some((row) => row.type === "session.turn-started"), 5_000, "the turn should begin");
  await before.close();

  const control = new Turns();
  const after = await serve(control, { [HARNESS]: 1 }, home.path);
  await call(after, "session.resume", { session });
  await start(after);
  expect(control.starts).toBe(1);
});
