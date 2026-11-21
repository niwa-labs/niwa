// The history plugin over a reading side the test grows: history.watch writes what it learns of a
// session as records, and history.unwatch stops it.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { LocatorSchema, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading, SessionRecord } from "@niwa-labs/harness";
import { history } from "@niwa-labs/history";
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
  const read = () => niwa.records.read(seq(0));
  for (let waited = 0; !typesOf(await read()).includes("history.session.ended") && waited < 5_000; waited += 20) await Bun.sleep(20);
  const written = await read();
  expect(typesOf(written)).toEqual(["history.session.seen", "session.progress", "history.session.paused", "history.session.ended"]);
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
  for (let waited = 0; !typesOf(await first.records.read(seq(0))).includes("history.session.paused") && waited < 5_000; waited += 20) await Bun.sleep(20);
  await first.close();

  records.push(checklist(2, 2, 2));
  const second = await serve({ pollMs: 10, pauseMs: 30, endMs: 100 });
  open.unshift(() => second.close());
  for (let waited = 0; !typesOf(await second.records.read(seq(0))).includes("history.session.ended") && waited < 5_000; waited += 20) await Bun.sleep(20);
  const progress = (await second.records.read(seq(0))).filter((record) => record.type === "session.progress").map((record) => record.data);
  expect(progress).toEqual([
    { session: ID, done: 1, total: 2 },
    { session: ID, done: 2, total: 2 },
  ]);
});
