// A plugin file: a host loads it with `niwa.use(...)`; run on its own it does nothing.
//
// A request: someone waits for a typed answer from someone.
// The one waiting sleeps. It does not hang and it does not poll.

import { OptionIdSchema, actionRef, record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { owner } from "@niwa-labs/core";
import { answeredBy, question, requestAsk } from "@niwa-labs/requests";
import { z } from "zod";

// A question is a name and a question in the one format of the system: a kind (choice, multi,
// confirm, text, form, permission), its wording and its options. The request records it whole,
// so a surface draws it without this code.
export const ReleaseBranch = question("release.branch", {
  kind: "choice",
  title: "Which branch is the release made from?",
  options: [
    { id: OptionIdSchema.parse("main"), label: "main", flavor: "plain" },
    { id: OptionIdSchema.parse("next"), label: "next", flavor: "plain" },
  ],
});

// Stand-ins: not part of niwa. The record that says a release was asked for, and the action
// that starts one from a branch; a release plugin of your own would declare and serve them.
const ReleaseRequested = record("release.requested", z.object({ name: z.string() }));
const startRelease = actionRef("release.start", {
  description: "Starts a release from a branch.",
  input: z.object({ from: z.enum(["main", "next"]) }),
  output: z.object({ started: z.boolean() }),
});

export default plugin("branching", (api) => {
  api.on(ReleaseRequested, async (release, step) => {
    // `requestAsk` is the typed reference of the requests module. One action serves every
    // question; it gives back the id of the request and the answer, an `Answer`, and the kind of the
    // question says which one it is. As a step it waits for the answer; `answeredBy` says so to the
    // type (called directly, outside a step, the action answers at once with the open request).
    const { answer: answered } = answeredBy(
      await step(requestAsk, {
        to: owner,
        ...ReleaseBranch,
        input: { ...ReleaseBranch.input, detail: `Release ${release.name}` },
      }),
    );
    const base = "ids" in answered && answered.ids[0] === "next" ? "next" : "main";

    // Execution continues here when the answer arrives:
    // in a minute or in a week, and across restarts.
    // After a restart the invocation is still waiting; the question is not asked again.
    await step(startRelease, { from: base });
  });
});

// A request addressed to the owner can reach a plugin first: a plugin may register a resolver
// for such requests. If the owner has already decided this, it answers with that decision and
// he never sees the request. Only what is truly new reaches him.
