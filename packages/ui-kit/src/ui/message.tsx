/** One turn of a conversation: who spoke, what they said, and what the agent did inside the turn. */

import type { ComponentProps } from "react";

import { cn } from "../lib/cn.ts";

export function MessageGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-group" className={cn("flex min-w-0 flex-col gap-2", className)} {...props} />;
}

/** `end` puts the turn on the right: the owner's own messages. */
export function Message({ className, align = "start", ...props }: ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn("group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse", className)}
      {...props}
    />
  );
}

export function MessageAvatar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn("flex w-fit min-w-8 shrink-0 items-center justify-center self-start overflow-hidden rounded-full bg-muted", className)}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    />
  );
}

/** The text of a turn in a bubble; the owner's bubble is filled, the agent's is plain. */
export function MessageBubble({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-bubble"
      className={cn(
        "max-w-full min-w-0 rounded-xl group-data-[align=end]/message:bg-secondary group-data-[align=end]/message:px-3 group-data-[align=end]/message:py-2",
        className,
      )}
      {...props}
    />
  );
}

export function MessageHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn("flex max-w-full min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function MessageFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-full min-w-0 items-center gap-2 text-xs text-muted-foreground group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  );
}
