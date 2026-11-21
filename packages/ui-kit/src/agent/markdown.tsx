/**
 * Markdown that may still be arriving. While a reply streams, unfinished bold, links and code
 * fences are closed for display instead of flashing as raw characters; code is highlighted.
 */

import { code } from "@streamdown/code";
import { memo } from "react";
import { Streamdown } from "streamdown";

import { cn } from "../lib/cn.ts";

export type MarkdownProps = {
  /** The text so far. */
  text: string;
  /** More text is coming. */
  streaming?: boolean | undefined;
  className?: string | undefined;
};

const PLUGINS = { code };

export const Markdown = memo(function Markdown({ text, streaming = false, className }: MarkdownProps) {
  return (
    <Streamdown
      className={cn("min-w-0 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={PLUGINS}
      shikiTheme={["github-light", "github-dark"]}
    >
      {text}
    </Streamdown>
  );
});
