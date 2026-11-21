// The pi insert: which installation its sessions belong to, and whether a session is niwa's.

import { expect, test } from "bun:test";

import { NIWA_SESSION_ENV, harnessId, sessionId } from "@niwa-labs/harness";
import type { InsertEvent } from "@niwa-labs/harness";
import { PI_INSTANCE_ENV, PiInsert, insertOf, piSession } from "../src/insert/index.ts";

const info = { id: "native-1", cwd: "/work" };

test("a session is named by the installation it belongs to, and by `pi` when none is named", () => {
  expect(piSession("native-1")).toEqual(sessionId(harnessId("pi"), "native-1"));
  expect(piSession("native-1", "pi-work")).toEqual(sessionId(harnessId("pi-work"), "native-1"));
});

test("the events of an insert carry the id of its installation, the one the reading and control sides use", async () => {
  const reported: InsertEvent[] = [];
  const insert = new PiInsert({ report: async (event) => void reported.push(event), harness: "pi-work" });
  await insert.onSessionStart({ reason: "startup" }, info);
  await insert.onSessionCompact({ compactionEntry: { summary: "so far" } }, info);
  await insert.onUiPromptStart({ kind: "confirm", title: "Run it?" }, info);
  expect(reported.map((event) => event.kind)).toEqual(["opened-by-hand", "compacted", "permission-asked"]);
  for (const event of reported) expect(event).toMatchObject({ session: piSession("native-1", "pi-work") });
});

test("a pi that niwa started says so in its environment: it reports no hand-opened session, and names its installation", async () => {
  const reported: InsertEvent[] = [];
  const report = async (event: InsertEvent): Promise<void> => void reported.push(event);
  const owned = insertOf({ [NIWA_SESSION_ENV]: "1", [PI_INSTANCE_ENV]: "pi-work" }, report);
  await owned.onSessionStart({ reason: "startup" }, info);
  await owned.onSessionCompact({ compactionEntry: { summary: "so far" } }, info);
  expect(reported).toMatchObject([{ kind: "compacted", session: piSession("native-1", "pi-work") }]);

  // The same extension in a pi the owner opened in a terminal: no marker, so it is a hand-opened session.
  reported.length = 0;
  const byHand = insertOf({}, report);
  await byHand.onSessionStart({ reason: "startup" }, info);
  expect(reported).toMatchObject([{ kind: "opened-by-hand", session: piSession("native-1") }]);
});

test("the end of a session is reported under the installation the insert belongs to", async () => {
  const reported: InsertEvent[] = [];
  const insert = new PiInsert({ report: async (event) => void reported.push(event), harness: "pi-work" });
  await insert.onSessionShutdown({ reason: "quit" }, info);
  expect(reported).toMatchObject([{ kind: "session-ended", session: piSession("native-1", "pi-work"), reason: "quit" }]);
});
