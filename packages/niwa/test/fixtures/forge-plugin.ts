// A forge plugin of actions on pull requests: a merge, which cannot be taken back, and a comment
// and an opening, which can. The merge and the comment name the pull request as their target.

import { z } from "zod";

import { action, actionName, record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/testing";

const Pr = z.object({ repo: z.string(), pr: z.number() });
const Done = z.object({ ok: z.boolean() });

/** A pull request was opened: what a workflow may start on. */
export const PrOpened = record("forge.pr.opened", z.object({ repo: z.object({ host: z.string(), path: z.string() }), pr: z.number() }), { open: true });

export const forge = plugin("forge", (api) => {
  api.declare(PrOpened);
  api.action(action("forge.pr.open", {
    description: "Opens a pull request.",
    input: PrOpened.schema,
    output: Done,
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    run: async (input, ctx) => {
      await ctx.emit(PrOpened, input);
      return { ok: true };
    },
  }));
  api.action(action("forge.pr.merge", {
    description: "Merges a pull request.",
    input: Pr,
    output: Done,
    recovery: "do-not-repeat",
    effect: "irreversible",
    world: "external",
    target: (input) => `git.example.com/${input.repo}/pr/${String(input.pr)}`,
    run: () => ({ ok: true }),
  }));
  api.action(action("forge.comment.create", {
    description: "Comments on a pull request.",
    input: Pr,
    output: Done,
    recovery: "do-not-repeat",
    effect: "write",
    world: "external",
    target: (input) => `git.example.com/${input.repo}/pr/${String(input.pr)}`,
    run: () => ({ ok: true }),
  }));
});

export const MERGE = actionName("forge.pr.merge");
export const COMMENT = actionName("forge.comment.create");
export const OPEN = actionName("forge.pr.open");
