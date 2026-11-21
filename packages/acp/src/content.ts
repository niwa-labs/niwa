/** The content blocks of an ACP message, as every snapshot niwa has (0.14.1, 1.3.0) names them. */

import { assertNever } from "@niwa-labs/core";

/** A content block, by the fields the answer needs. */
export type AcpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image" | "audio" | "resource_link" | "resource" };

/** The text a content block adds to the answer: only a text block adds any. */
export function answerText(content: AcpContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    // An image, a sound or a resource is not text of the answer.
    case "image":
    case "audio":
    case "resource_link":
    case "resource":
      return "";
    default:
      return assertNever(content, "ACP content block");
  }
}
