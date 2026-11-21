/**
 * A tool call inside a turn: what was called, with what, and what came back. Closed it is one
 * line; open it shows the input and the output.
 */

import { WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.ts";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "../ui/trace.tsx";
import { formatDuration, formatPayload } from "./payload.ts";
import { StateRing, type WorkState } from "./state.tsx";

export type ToolCallState = Extract<WorkState, "pending" | "running" | "waiting" | "done" | "failed" | "stopped">;

export type ToolCallProps = {
  /** The tool's name. */
  name: string;
  /** What the call did, in words; the name when absent. */
  title?: ReactNode;
  state: ToolCallState;
  /** The input as sent: a string is shown as is, anything else as JSON. */
  input?: unknown;
  /** The output as received. */
  output?: unknown;
  /** Why the call failed. */
  error?: string | undefined;
  durationMs?: number | undefined;
  /** Open at first. Failed calls start open. */
  defaultOpen?: boolean | undefined;
  /** Shown in place of the icon, e.g. the tool's own icon. */
  icon?: ReactNode;
  className?: string | undefined;
};

function traceStatus(state: ToolCallState): TraceStatus | undefined {
  if (state === "running") return "running";
  if (state === "failed") return "error";
  if (state === "pending") return "pending";
  return undefined;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text = formatPayload(value);
  if (text === "") return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">{label}</span>
      <pre className="max-h-80 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground/90">
        {text}
      </pre>
    </div>
  );
}

export function ToolCall({
  name,
  title,
  state,
  input,
  output,
  error,
  durationMs,
  defaultOpen,
  icon,
  className,
}: ToolCallProps) {
  const hasBody = input !== undefined || output !== undefined || error !== undefined;
  const line = (
    <TraceLine status={traceStatus(state)}>
      <TraceIcon>{icon ?? <WrenchIcon />}</TraceIcon>
      <TraceTitle>{title ?? name}</TraceTitle>
      {durationMs === undefined ? null : <TraceDescription>{formatDuration(durationMs)}</TraceDescription>}
      <StateRing state={state} className="size-2.5" />
    </TraceLine>
  );

  return (
    <Trace data-slot="tool-call" data-tool={name} data-state={state} className={cn("min-w-0", className)}>
      {hasBody ? (
        <TraceCollapsible defaultOpen={defaultOpen ?? state === "failed"}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="flex flex-col gap-2">
            <Payload label="Input" value={input} />
            {error === undefined ? <Payload label="Output" value={output} /> : null}
            {error === undefined ? null : (
              <pre className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-destructive">
                {error}
              </pre>
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </Trace>
  );
}
