// history.read over the reading side of a harness, called through a host: the transcript whole or in
// windows, with the same rules session.read has, and the same answer.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import type { ActionName } from "@niwa-labs/core";
import { LocatorSchema, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading, SessionRecord } from "@niwa-labs/harness";
import { history } from "@niwa-labs/history";
import { tempHome } from "@niwa-labs/testing";

const ID = sessionId(harnessId("h"), "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);
const base = (n: number) => ({ locator: at(n), incomplete: false });

const RECORDS: SessionRecord[] = [
  { kind: "user", text: "fix it", ...base(1) },
  { kind: "assistant", text: "done", ...base(2) },
  { kind: "tool-call", callId: "c1", name: "apply_patch", category: "edit", target: "/r/a.ts", paths: ["/r/a.ts", "/r/b.ts"], ...base(3) },
];

const reading: SessionReading = {
  async *list() {
    yield { id: ID };
  },
  async *read(_id, from) {
    const start = from === undefined ? 0 : RECORDS.findIndex((record) => record.locator === from) + 1;
    yield* RECORDS.slice(start);
  },
  raw: async () => undefined,
  rawSchema: { parse: (value: unknown) => value } as never,
  coverage: async () => ({ status: "not-scanned" }),
};

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

async function host() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(history({ harnesses: [{ instance, reading }] }));
  await niwa.serve();
  open.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  return (name: string, input: unknown) => niwa.call(name as ActionName, input) as Promise<any>;
}

test("history.read gives the records whole, every field of them, from a locator on", async () => {
  const call = await host();
  const all = await call("history.read", { session: ID });
  expect(all.records).toEqual(RECORDS);
  expect(all.coverage).toEqual({ status: "not-scanned" });
  const rest = await call("history.read", { session: ID, from: "L2" });
  expect(rest.records.map((record: SessionRecord) => record.locator)).toEqual(["L3"]);
});

test("history.read gives a window of a digest or a brief, and the files an edit named", async () => {
  const call = await host();
  const digest = await call("history.read", { session: ID, mode: "digest" });
  expect(digest.records).toEqual([]);
  expect(digest.digest.next).toBeNull();
  expect(digest.digest.restarted).toBe(false);
  expect(digest.digest.view.entries.map((entry: { kind: string }) => entry.kind)).toEqual(["user", "assistant", "tool"]);
  expect(digest.digest.view.entries[2].target).toBe("[F1] /r/a.ts, [F2] /r/b.ts");
  const brief = await call("history.read", { session: ID, mode: "brief" });
  expect(brief.digest.view.brief.changed).toEqual(["/r/a.ts", "/r/b.ts"]);
});

test("history.read takes a window of the last records, and refuses what cannot go together", async () => {
  const call = await host();
  const tail = await call("history.read", { session: ID, window: { limit: 2 } });
  expect(tail.records.map((record: SessionRecord) => record.locator)).toEqual(["L2", "L3"]);
  expect(tail.page).toEqual({ hasEarlier: true });
  await expect(call("history.read", { session: ID, from: "L1", window: { limit: 1 } })).rejects.toThrow("from and window cannot be combined");
  await expect(call("history.read", { session: ID, window: { limit: 1 }, mode: "digest" })).rejects.toThrow("window reads records");
});

test("history.read of a session of a harness that is not served says so in its coverage", async () => {
  const call = await host();
  const none = await call("history.read", { session: { harness: "elsewhere", native: "x" } });
  expect(none.records).toEqual([]);
  expect(none.coverage.status).toBe("unavailable");
});
