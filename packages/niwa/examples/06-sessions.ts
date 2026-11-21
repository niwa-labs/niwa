// A client: it needs a live host serving `~/.niwa` (see 01-my-harness.ts) with the harnesses
// `claude-personal` and `codex` installed.
//
// Sessions of any harness are read the same way: old ones, running ones,
// and ones started without niwa.
//
// Every call here is `niwa.call(typedAction, input)`. The typed actions are imported
// from the module that owns them; the type checker knows the input and the output of
// each, on the host and on a client. `niwa` is the host (`createNiwa`) or a client
// (`connect`): there is no `niwa.sessions` and no `niwa.harness(...)`.

import { connect } from "@niwa-labs/client";
import { harnessSupports } from "@niwa-labs/sessions";
import { sessionAsk, sessionList, sessionRead, sessionSend, sessionStart } from "@niwa-labs/sessions";
import { z } from "zod";

// Stand-in: not part of niwa. Where the lines of the transcript are shown.
function print(...parts: string[]): void {
  console.log(parts.join(" "));
}

const niwa = await connect({ home: "~/.niwa" });

// The sessions niwa knows about, of one harness.
const { sessions, unreadable } = await niwa.call(sessionList, { harness: "claude-personal" });
for (const s of sessions) {
  console.log(s.ref, s.cwd, s.state);
}
// A harness whose sessions could not be listed is named, not skipped silently.
for (const u of unreadable) console.log("could not read", u.harness, u.reason);

// The transcript of one session, through the harness's reading side.
const [first] = sessions;
if (first === undefined) throw new Error("no sessions of claude-personal yet");
const { records, coverage } = await niwa.call(sessionRead, { session: first.ref });
for (const rec of records) {
  if (rec.kind === "assistant") print(rec.text);
  if (rec.kind === "tool-call") print("tool:", rec.name);
  if (rec.kind === "compaction") print("the harness compacted its context:", rec.summary);
  if (rec.kind === "nested") print("nested session:", rec.child.harness, rec.child.native);
  // The harness's own record, whole, is asked for separately; nothing is lost.
}
// `coverage` says how much was read: only "empty" says there is nothing.

// Starting a session and asking for an answer that must match a schema.
// The schema is one zod value: the session is given it as a JSON schema, and the answer,
// which comes back as `unknown`, is parsed with it before its fields are read.
const Verdict = z.object({ safe: z.boolean(), why: z.string() });

const { session } = await niwa.call(sessionStart, {
  harness: "codex",
  cwd: "~/projects/niwa",
  prompt: "Find where the input hash is computed.",
});

const { value } = await niwa.call(sessionAsk, {
  session,
  prompt: "Is it safe to change?",
  // The schema the answer must pass, as a JSON schema.
  schema: z.toJSONSchema(Verdict),
});
const verdict = Verdict.parse(value);

if (!verdict.safe) console.log(verdict.why);

// Sending to a session that is busy returns an honest receipt.
const { receipt } = await niwa.call(sessionSend, { session, message: "Also check the tests." });
// receipt.status is "delivered" | "queued" | "started" | "handled"

// What a harness cannot do is refused explicitly, never silently ignored.
// "Can harness X do Y" is an action too: `harness.supports`.
const { supported } = await niwa.call(harnessSupports, {
  harness: "codex",
  side: "control",
  ability: "interrupt",
});
if (!supported) {
  // do not offer an interrupt, or choose another harness
}
