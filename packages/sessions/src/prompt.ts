/**
 * The prompt as sections.
 *
 * A prompt is sections with an id and a tier — `constant`, `stable`, `volatile` — so several
 * plugins can contribute without breaking each other's cache. The shape is the harness's
 * (`@niwa-labs/harness`); this module turns what an action's input takes into it.
 */

import { z } from "zod";

import { PromptSchema, promptFromText } from "@niwa-labs/harness";
import type { Prompt } from "@niwa-labs/harness";

/** What an action's input takes: plain text, or sections. It leaves the schema as sections. */
export const PromptInputSchema = z
  .union([z.string(), PromptSchema])
  .transform((input, ctx): Prompt => {
    if (typeof input === "string") return promptFromText(input);
    const ids = new Set<string>();
    for (const section of input.sections) {
      if (ids.has(section.id)) {
        ctx.addIssue({
          code: "custom",
          message: `the prompt has two sections with the id "${section.id}"`,
        });
        return z.NEVER;
      }
      ids.add(section.id);
    }
    return input;
  });

export type PromptInput = z.input<typeof PromptInputSchema>;

/**
 * The prompt of whatever the caller gave.
 *
 * Plain text becomes one volatile section in the input schema, before any intercept sees it, so everything
 * downstream deals with sections only. Sections must have distinct ids: an intercept that
 * replaces a section has to be able to say which one it means.
 */
export function promptFrom(input: PromptInput): Prompt {
  if (typeof input === "string") return promptFromText(input);
  const ids = new Set<string>();
  for (const section of input.sections) {
    if (ids.has(section.id)) throw new TypeError(`the prompt has two sections with the id "${section.id}"`);
    ids.add(section.id);
  }
  return input;
}
