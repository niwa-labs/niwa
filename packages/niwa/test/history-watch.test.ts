// The history plugin over a reading side the test grows: history.watch writes what it learns of a
// session as records, and history.unwatch stops it.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { LocatorSchema, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { AskAnswer, DeliveryReceipt, Harness, LifeEvent, SessionControl, SessionReading, SessionRecord, SessionState, StartedSession } from "@niwa-labs/harness";
import { history } from "@niwa-labs/history";
import type { Plugin } from "@niwa-labs/plugin";
import { insertPlugin, sessions } from "@niwa-labs/sessions";
import { tempHome } from "@niwa-labs/testing";

const ID = sessionId(harnessId("h"), "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const checklist = (n: number, done: number, total: number): SessionRecord => ({
  kind: "checklist",
  items: Array.from({ length: total }, (_, index) => ({ text: `item ${String(index)}`, state: index < done ? "done" : "pending" })),
  locator: at(n),
  incomplete: false,
});

function growing(records: SessionRecord[]): SessionReading {
  return {
    async *list() {
      yield { id: ID, cwd: "/work" };
    },
    async *read(_id, from) {
      const start = from === undefined ? 0 : records.findIndex((record) => record.locator === from) + 1;
      yield* records.slice(start);
    },
    raw: async () => undefined,
    rawSchema: { parse: (value: unknown) => value } as never,
    coverage: async () => ({ status: "not-scanned" }),
  };
}

const instance: Harness = {
  id: harnessId("h"),
  kind: harnessKind("fake-kind"),
  machine: machineId("m"),
  home: "/tmp/h",
  sides: { reading: { list: true, read: true, watch: false } },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const typesOf = (records: readonly StoredRecord[]): string[] =>
  records.map((record): string => record.type).filter((type) => type.startsWith("history.") || type === "session.progress");

test("history.watch writes that it saw the session, its progress, its pause and its end; unwatch stops it", async () => {
  const home = await tempHome();
  const records: SessionRecord[] = [checklist(1, 1, 3)];
  const niwa = createNiwa({ home: home.path });
  niwa.use(history({ harnesses: [{ instance, reading: growing(records) }], timing: { pollMs: 10, pauseMs: 40, endMs: 120 } }));
  await niwa.serve();
  open.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  const call = (name: string, input: unknown) => niwa.call(name as ActionName, input);

  expect(await call("history.watch", { session: ID })).toEqual({ watching: true });
  expect(await call("history.watch", { session: ID })).toEqual({ watching: true });
  const read = () => niwa.records.read();
  for (let waited = 0; !typesOf(await read()).includes("history.session.ended") && waited < 5_000; waited += 20) await Bun.sleep(20);
  const written = await read();
  expect(typesOf(written)).toEqual(["history.session.seen", "session.progress", "history.session.paused", "history.session.ended"]);
  expect(written.find((record) => record.type === "history.session.ended")?.data).toEqual({ session: ID, certainty: "guessed", why: "idle" });
  expect(written.find((record) => record.type === "history.session.seen")?.data).toEqual({ session: ID, harness: "h", cwd: "/work" });
  expect(written.find((record) => record.type === "session.progress")?.data).toEqual({ session: ID, done: 1, total: 3 });

  // Watched again and stopped by hand.
  await call("history.watch", { session: ID });
  expect(await call("history.unwatch", { session: ID })).toEqual({ stopped: true });
  expect(typesOf(await read()).slice(-2)).toEqual(["history.session.seen", "history.session.unwatched"]);
});

test("a watch that was on when the host stopped goes on after a restart, from its last pause", async () => {
  const home = await tempHome();
  open.push(() => home.cleanup());
  const records: SessionRecord[] = [checklist(1, 1, 2)];
  const serve = async (timing: { pollMs: number; pauseMs: number; endMs: number }) => {
    const niwa = createNiwa({ home: home.path });
    niwa.use(history({ harnesses: [{ instance, reading: growing(records) }], timing }));
    await niwa.serve();
    return niwa;
  };
  const first = await serve({ pollMs: 10, pauseMs: 30, endMs: 60_000 });
  await first.call("history.watch" as ActionName, { session: ID });
  for (let waited = 0; !typesOf(await first.records.read()).includes("history.session.paused") && waited < 5_000; waited += 20) await Bun.sleep(20);
  await first.close();

  records.push(checklist(2, 2, 2));
  const second = await serve({ pollMs: 10, pauseMs: 30, endMs: 100 });
  open.unshift(() => second.close());
  for (let waited = 0; !typesOf(await second.records.read()).includes("history.session.ended") && waited < 5_000; waited += 20) await Bun.sleep(20);
  const progress = (await second.records.read()).filter((record) => record.type === "session.progress").map((record) => record.data);
  expect(progress).toEqual([
    { session: ID, done: 1, total: 2 },
    { session: ID, done: 2, total: 2 },
  ]);
});

/** A control side of "h" that names the session `s1` and ends its signs of life when told to. */
class EndingControl implements SessionControl {
  #end: () => void = () => {};
  readonly #ended = new Promise<void>((resolve) => (this.#end = resolve));
  async start(): Promise<StartedSession> {
    return { session: ID };
  }
  async resume(): Promise<void> {}
  async send(): Promise<DeliveryReceipt> {
    return { status: "started", turn: 1 };
  }
  async interrupt(): Promise<void> {}
  async ask<T>(): Promise<AskAnswer<T>> {
    throw new Error("not asked");
  }
  async *life(): AsyncIterable<LifeEvent> {
    await this.#ended;
  }
  async state(): Promise<SessionState> {
    return "idle";
  }
  end(): void {
    this.#end();
  }
}

const controlled: Harness = {
  ...instance,
  sides: { ...instance.sides, control: { start: true, resume: true, send: true, interrupt: false, ask: false, structuredOutput: false, launch: { model: false, effort: [], modes: [] } } },
};

async function hosted(plugins: (reading: SessionReading) => Plugin[], records: SessionRecord[]): Promise<{ call: (name: string, input: unknown) => Promise<unknown>; read: () => Promise<StoredRecord[]> }> {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(...plugins(growing(records)));
  await niwa.serve();
  open.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return { call: (name, input) => niwa.call(name as ActionName, input), read: () => niwa.records.read() };
}

async function until(read: () => Promise<StoredRecord[]>, type: string): Promise<StoredRecord[]> {
  for (let waited = 0; waited < 5_000; waited += 20) {
    const all = await read();
    if (all.some((record) => record.type === type)) return all;
    await Bun.sleep(20);
  }
  throw new Error(`no ${type} was written`);
}

const ended = (records: readonly StoredRecord[]) => records.filter((record) => record.type === "history.session.ended").map((record) => record.data);

test("a session niwa starts is watched by itself, is never guessed to have ended, and ends exactly when it ends", async () => {
  const control = new EndingControl();
  const timing = { pollMs: 10, pauseMs: 30, endMs: 60 };
  const host = await hosted((reading) => [sessions({ harnesses: [{ instance: controlled, control }] }), history({ harnesses: [{ instance: controlled, reading }], timing })], [checklist(1, 1, 2)]);
  await host.call("session.start", { harness: "h", prompt: "go" });
  await until(host.read, "history.session.paused");
  // Quiet for longer than a guess waits: a session niwa runs is asleep, not over.
  await Bun.sleep(200);
  expect(ended(await host.read())).toEqual([]);
  expect((await host.read()).filter((record) => record.type === "session.progress").map((record) => record.data)).toEqual([{ session: ID, done: 1, total: 2 }]);

  control.end();
  expect(ended(await until(host.read, "history.session.ended"))).toEqual([{ session: ID, certainty: "exact", why: "session-ended" }]);
});

test("a signal ends a watched session: the harness's own end exactly, a process gone or a new binding as a guess", async () => {
  for (const [signal, certainty] of [["end-hook", "exact"], ["process-gone", "guessed"], ["new-binding", "guessed"]] as const) {
    const host = await hosted((reading) => [history({ harnesses: [{ instance, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], [checklist(1, 0, 1)]);
    // A session nobody watches has no end to say.
    expect(await host.call("history.signal", { session: ID, signal })).toEqual({ ended: false });
    await host.call("history.watch", { session: ID });
    expect(await host.call("history.signal", { session: ID, signal })).toEqual({ ended: true });
    expect(ended(await host.read())).toEqual([{ session: ID, certainty, why: signal }]);
  }
});

test("a watch given the process of its harness guesses the session ended once the process is gone", async () => {
  const process = Bun.spawn(["sleep", "30"]);
  const host = await hosted((reading) => [history({ harnesses: [{ instance, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], [checklist(1, 0, 1)]);
  await host.call("history.watch", { session: ID, pid: process.pid });
  await until(host.read, "session.progress");
  expect(ended(await host.read())).toEqual([]);
  process.kill();
  await process.exited;
  expect(ended(await until(host.read, "history.session.ended"))).toEqual([{ session: ID, certainty: "guessed", why: "process-gone" }]);
});

test("the end the harness reports through its insert ends the watch of the session exactly", async () => {
  const host = await hosted((reading) => [insertPlugin(), history({ harnesses: [{ instance, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], [checklist(1, 0, 1)]);
  await host.call("history.watch", { session: ID });
  await host.call("insert.report", { kind: "session-ended", session: ID, reason: "quit" });
  expect(ended(await until(host.read, "history.session.ended"))).toEqual([{ session: ID, certainty: "exact", why: "end-hook" }]);
});

test("a session watched again without its process is not ended by the process it was watched with before", async () => {
  const process = Bun.spawn(["sleep", "30"]);
  const records: SessionRecord[] = [checklist(1, 0, 1)];
  const host = await hosted((reading) => [history({ harnesses: [{ instance, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], records);
  await host.call("history.watch", { session: ID, pid: process.pid });
  await until(host.read, "session.progress");
  process.kill();
  await process.exited;
  expect(ended(await until(host.read, "history.session.ended"))).toHaveLength(1);

  await host.call("history.watch", { session: ID });
  records.push(checklist(2, 1, 1));
  for (let waited = 0; (await host.read()).filter((record) => record.type === "session.progress").length < 2 && waited < 5_000; waited += 20) await Bun.sleep(20);
  // A few polls with nothing new: a process that is gone would end the watch by now.
  await Bun.sleep(150);
  expect(ended(await host.read())).toHaveLength(1);
});

test("watch calls made at once for one session start one watch", async () => {
  const host = await hosted((reading) => [history({ harnesses: [{ instance, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], [checklist(1, 0, 1)]);
  const answers = await Promise.all([host.call("history.watch", { session: ID }), host.call("history.watch", { session: ID }), host.call("history.watch", { session: ID })]);
  expect(answers).toEqual([{ watching: true }, { watching: true }, { watching: true }]);
  await until(host.read, "session.progress");
  expect((await host.read()).filter((record) => record.type === "history.session.seen")).toHaveLength(1);
});

test("a sign that only suggests an end does not end a session niwa runs, whose own end is still written", async () => {
  const control = new EndingControl();
  const host = await hosted((reading) => [sessions({ harnesses: [{ instance: controlled, control }] }), history({ harnesses: [{ instance: controlled, reading }], timing: { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } })], [checklist(1, 1, 2)]);
  await host.call("session.start", { harness: "h", prompt: "go" });
  await until(host.read, "session.progress");
  expect(await host.call("history.signal", { session: ID, signal: "new-binding" })).toEqual({ ended: false });
  expect(await host.call("history.signal", { session: ID, signal: "process-gone" })).toEqual({ ended: false });
  expect(ended(await host.read())).toEqual([]);

  control.end();
  expect(ended(await until(host.read, "history.session.ended"))).toEqual([{ session: ID, certainty: "exact", why: "session-ended" }]);
});
