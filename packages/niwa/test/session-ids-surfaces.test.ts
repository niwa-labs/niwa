// A session niwa started is named by its id wherever a person reads it: a line of `niwa log`, the
// `--session` filter, and a question of the session on the web feed.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { idSchema, recordId, seq, timestamp, recordTypeName, streamId } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, sessionId } from "@niwa-labs/harness";
import { SESSION_TYPES, SessionStarted, SessionTurnStarted, sessionRef } from "@niwa-labs/sessions";
import { tempHome } from "@niwa-labs/testing";

import { log } from "@niwa-labs/cli";
import { feedOf } from "@niwa-labs/web";

const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

const ONE = sessionRef(sessionId(harnessId("fake"), "0a1b2c3d-1111-2222-3333-444455556666"));
const TWO = sessionRef(sessionId(harnessId("fake"), "9f8e7d6c-1111-2222-3333-444455556666"));
const ONE_ID = idSchema("session").parse("s-a1b2c3");
const TWO_ID = idSchema("session").parse("s-d4e5f6");

async function served(): Promise<Host> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(plugin("sessions", (api) => api.declare(...SESSION_TYPES)));
  await host.serve();
  hosts.push(host);
  await host.emit(SessionStarted, { session: ONE, id: ONE_ID });
  await host.emit(SessionStarted, { session: TWO, id: TWO_ID });
  await host.emit(SessionTurnStarted, { session: ONE, turn: 1 });
  await host.emit(SessionTurnStarted, { session: TWO, turn: 1 });
  return host;
}

test("niwa log names a session by its id, and --session takes the id or its start", async () => {
  const host = await served();
  const lines: string[] = [];
  await log(host, ["--session", "s-a1", "--type", "session.turn-started"], false, 200, (line) => lines.push(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/session\.turn-started +session:s-a1b2c3 +turn=1/);

  // A text that names no id is the pair, or the start of the harness's own id.
  const native: string[] = [];
  await log(host, ["--session", "9f8e7d6c", "--type", "session.turn-started"], false, 200, (line) => native.push(line));
  expect(native.map((line) => line.includes("session:s-d4e5f6"))).toEqual([true]);
});

test("the feed says which session asks the owner", () => {
  const stored = (seqNo: number, type: string, data: object): StoredRecord => ({
    id: recordId(`r${String(seqNo)}`),
    seq: seq(seqNo),
    stream: streamId("s"),
    type: recordTypeName(type),
    schema: 1,
    data,
    actor: { kind: "host" },
    cause: null,
    root: recordId(`r${String(seqNo)}`),
    at: timestamp(1_000),
  });
  const entries = feedOf([
    stored(1, "session.started", { session: ONE, id: ONE_ID }),
    stored(2, "request.created", { id: "req-aaaaaa", to: { kind: "owner" }, from: { kind: "session", harness: "fake", id: "0a1b2c3d-1111-2222-3333-444455556666" }, question: "go on?" }),
    stored(3, "request.created", { id: "req-bbbbbb", to: { kind: "owner" }, question: "and this?" }),
  ]);
  expect(entries.map((entry) => [entry.id, entry.session])).toEqual([
    ["req-aaaaaa", ONE_ID],
    ["req-bbbbbb", undefined],
  ]);
});
