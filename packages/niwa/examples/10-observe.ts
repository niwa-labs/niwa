// A client: it needs a live host serving `~/.niwa` (see 01-my-harness.ts).
//
// Everything is visible: what happened, who did it, and what it grew from.
//
// This program is a client. It connects to the host that is already running
// and uses the same actions and the same observation API.
//
// The host must be serving on that home (see 01-my-harness.ts). With no host,
// `connect` fails because the socket is not there. Start the host first.

import { connect } from "@niwa-labs/client";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { MessageReceived } from "@niwa-labs/messages";
import { owner } from "@niwa-labs/core";
import { requestOpen } from "@niwa-labs/requests";
import { sessionRunning } from "@niwa-labs/sessions";
import { TaskDone } from "@niwa-labs/tasks";

const niwa = await connect({ home: "~/.niwa" });
const render = (rec: StoredRecord) => console.log(rec.seq, rec.type, rec.actor);

// Read from the start of the journal; a real reader keeps the position it stopped at.
const position = seq(0);

// The last message that came in, and the last task that ended: ids are taken from the records.
const [message] = (await niwa.records.read(position, { types: [MessageReceived] })).slice(-1);
const [result] = (await niwa.records.read(position, { types: [TaskDone] })).slice(-1);
if (message === undefined || result === undefined) throw new Error("nothing has happened yet");
const messageId = message.id;
const resultId = result.id;

// Everything that grew from one message.
for (const rec of await niwa.trace(messageId)) {
  console.log("  ".repeat(rec.depth) + rec.type, "·", rec.actor);
}
// message.received · owner
//   task.created · agent
//     session.started · codex
//       tool.called · codex
//     task.done · codex
//   message.sent · agent

// Where did this result come from? Walk up the causes and links.
for (const rec of await niwa.causes(resultId)) console.log(rec.type);

// Read the history after a position. This read ends: it answers with the
// records that are committed now, and nothing that comes later.
for (const rec of await niwa.records.read(position)) render(rec);

// Narrow it down.
for (const rec of await niwa.records.read(position, { types: [TaskDone] })) render(rec);

// Follow everything from where you stopped. The position is a journal position,
// so nothing is missed across a restart, and there is no gap between history and live.
// This one never ends by itself: it is history and then live, so a script that
// only wants to print the journal must stop it itself.
for await (const rec of niwa.records.since(position)) render(rec);

// Is a turn running right now, in any session of any harness?
// A session whose state cannot be known right now is reported as "unknown".
// Actions are called with `niwa.call(typedAction, input)`; the typed action carries the
// input and output types, so a client needs nothing of the module but its import.
const live = await niwa.call(sessionRunning, {});

// What is waiting for the owner, across everything:
// questions, approvals, paused work.
const waiting = await niwa.call(requestOpen, { to: owner });
