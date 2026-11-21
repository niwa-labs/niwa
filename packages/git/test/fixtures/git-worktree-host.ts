// The host program of the replay of a cut-off worktree create (test/git-worktree-replay.test.ts).
//
// The plugin declares the record Start { repo }. Its handler makes a worktree of the repository as one
// step. The test parks the step inside `git worktree add` (a hook of the repository waits on a gate),
// kills the host, and starts it again: the step is made again under the same identity.
//
// The home directory comes from argv[2]. The test imports this file for the Start record type, so
// the host only starts when the file is run directly.

import { EntityDescription, record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa } from "@niwa-labs/testing";
import { git, gitWorktreeCreate, gitWorktreeRemove } from "../../src/index.ts";
import { z } from "zod";

export const Remove = record("git-replay.remove", gitWorktreeRemove.input, { open: true });
export const Start = record("git-replay.start", z.object({ repo: z.string() }), { open: true });

const replay = plugin("git-replay", (api) => {
  api.declare(Start, Remove);
  api.on(Remove, async (data, step) => {
    await step(gitWorktreeRemove, data);
  });
  api.on(Start, async (data, step) => {
    await step(gitWorktreeCreate, { repo: data.repo, description: EntityDescription.parse("made once") });
  });
});

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun git-worktree-host.ts <home>");
    process.exit(2);
  }
  const gitPath = process.argv[3];
  if (gitPath !== undefined) process.env.PATH = `${gitPath}:${process.env.PATH}`;
  const niwa = createNiwa({ home });
  niwa.use(git({ cleanup: false }), replay);
  await niwa.serve();
  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
