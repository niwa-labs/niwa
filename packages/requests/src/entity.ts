/**
 * What `request.list` and `request.get` answer, built from the state of a request.
 */

import { DESCRIPTION_MAX, DESCRIPTION_MIN, EntityDescription } from "@niwa-labs/core";

import type { z } from "zod";

import type { RequestEntity, requestList } from "./actions.ts";
import type { Created, RequestState } from "./state.ts";

/** A request's title cut to what a list shows: one line, at most `DESCRIPTION_MAX` characters, an ellipsis where it was cut. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > max - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The description of a request: the title the asker gave its question, on one line. A title too
 * short to read is put after the name of the question; when that is too short as well, the id of
 * the request is what is shown, so that a request already written never fails to be read.
 */
export function descriptionOf(created: Pick<Created, "id" | "question" | "input">): EntityDescription {
  const title = created.input.title.replace(/\s+/g, " ").trim();
  const named = `${created.question} ${title}`.trim();
  const shown = title.length >= DESCRIPTION_MIN ? title : named.length >= DESCRIPTION_MIN ? named : created.id;
  return EntityDescription.parse(cutTo(shown, DESCRIPTION_MAX));
}

/** What `request.list` shows of a request at a glance. */
export function itemOf(state: RequestState): z.infer<typeof requestList.output>["items"][number] {
  const { created } = state;
  return {
    id: created.id,
    description: descriptionOf(created),
    status: state.status,
    question: created.question,
    to: created.to,
    ...(created.from === undefined ? {} : { from: created.from }),
    ...(created.deadline === undefined ? {} : { deadline: created.deadline }),
  };
}

/** The whole request: what was asked, to whom, and how it stands. */
export function entityOf(state: RequestState): z.infer<typeof RequestEntity> {
  return {
    ...itemOf(state),
    input: state.created.input,
    ...(state.status === "answered" ? { answer: state.answer } : {}),
    ...(state.status === "answered" || state.status === "cancelled" ? (state.by === undefined ? {} : { by: state.by }) : {}),
  };
}
