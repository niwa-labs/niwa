// A forge plugin of two actions on pull requests: a merge, which cannot be taken back, and a
// comment, which can. Both name the pull request as their target.

import { z } from "zod";

import { action, actionName } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/testing";

const Pr = z.object({ repo: z.string(), pr: z.number() });
const Done = z.object({ ok: z.boolean() });

export const forge = plugin("forge", (api) => {
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
