/**
 * An id as a chip: monospace, short, copyable, and a link when the caller knows where the id
 * leads. The chip does not decide the target; the cockpit resolves ids to pages and passes the
 * link in.
 */

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps, type MouseEvent } from "react";

import { cn } from "../lib/cn.ts";

/** The prefix of an id such as `run-1f3a9c`, or undefined when the id has none. */
export function idPrefix(id: string): string | undefined {
  const match = /^([a-z][a-z0-9]*)-[0-9a-z]/.exec(id);
  return match?.[1];
}

/** The id cut to its prefix and the last characters, for places with little room. */
export function shortId(id: string, keep = 8): string {
  const prefix = idPrefix(id);
  const rest = prefix === undefined ? id : id.slice(prefix.length + 1);
  if (rest.length <= keep + 1) return id;
  const tail = rest.slice(-keep);
  return prefix === undefined ? `…${tail}` : `${prefix}-…${tail}`;
}

export type IdChipProps = Omit<ComponentProps<"span">, "children" | "onClick"> & {
  id: string;
  /** Where the id leads. Without it the chip is plain text. */
  href?: string | undefined;
  /** Called on a plain click of the link, to navigate inside the app instead of loading the page. */
  onNavigate?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  /** A label shown in place of the id; the id stays in the tooltip and is what gets copied. */
  label?: string | undefined;
  /** Shorten long ids. */
  short?: boolean | undefined;
  /** Show a copy button. */
  copyable?: boolean | undefined;
};

/** A plain left click without modifiers: one the app may handle itself. */
export function isPlainClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function IdChip({ id, href, onNavigate, label, short = false, copyable = true, className, ...props }: IdChipProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const text = label ?? (short ? shortId(id) : id);
  const body =
    href === undefined ? (
      <span className="truncate">{text}</span>
    ) : (
      <a
        href={href}
        className="truncate underline-offset-2 hover:underline"
        onClick={(event) => {
          if (onNavigate !== undefined && isPlainClick(event)) {
            event.preventDefault();
            onNavigate(event);
          }
        }}
      >
        {text}
      </a>
    );

  return (
    <span
      data-slot="id-chip"
      data-prefix={idPrefix(id)}
      title={id}
      className={cn(
        "group/id-chip inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-xs text-foreground/80",
        className,
      )}
      {...props}
    >
      {body}
      {copyable ? (
        <button
          type="button"
          aria-label={`Copy ${id}`}
          className="inline-flex shrink-0 text-muted-foreground opacity-0 group-hover/id-chip:opacity-100 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3"
          onClick={() => {
            void navigator.clipboard?.writeText(id).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      ) : null}
    </span>
  );
}
