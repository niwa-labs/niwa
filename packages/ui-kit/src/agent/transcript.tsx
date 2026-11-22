/**
 * A long list that grows at the bottom: the turns of a session, the records of a run. Only the
 * rows in view are rendered. While the reader is at the bottom the list follows new rows; once
 * they scroll up it stays where they are, and a button brings them back.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import type { Key, ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";

export type TranscriptProps<T> = {
  items: readonly T[];
  /** A key that stays with an item while the list grows. */
  itemKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  /** A first guess of a row's height in pixels; rows are measured once rendered. */
  estimateSize?: ((index: number) => number) | undefined;
  /** Rows rendered beyond the visible ones on each side. */
  overscan?: number | undefined;
  /** Shown when there are no items. */
  empty?: ReactNode;
  onReachStart?: (() => void) | undefined;
  preserveScrollAnchor?: boolean;
  className?: string | undefined;
};

export function Transcript<T>({
  items,
  itemKey,
  renderItem,
  estimateSize = () => 72,
  overscan = 6,
  empty,
  onReachStart,
  preserveScrollAnchor,
  className,
}: TranscriptProps<T>) {
  const stick = useStickToBottom({ initial: "instant", resize: "smooth" });
  const virtualizer = useVirtualizer({
    count: items.length,
    anchorTo: preserveScrollAnchor ? "end" : "start",
    getScrollElement: () => stick.scrollRef.current,
    estimateSize,
    overscan,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : itemKey(item, index);
    },
  });

  return (
    <div data-slot="transcript" className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div ref={stick.scrollRef}
        onScroll={event => {
          const view = event.currentTarget;
          if (!preserveScrollAnchor) return;
          if (view.scrollTop < 80 && view.scrollHeight - view.clientHeight > 80) onReachStart?.();
        }}
        onWheel={event => {
          if (event.deltaY < 0 && event.currentTarget.scrollTop < 80) onReachStart?.();
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="log" aria-live="polite">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{empty}</div>
        ) : (
          <div ref={stick.contentRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index];
              if (item === undefined) return null;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  data-transcript-key={preserveScrollAnchor ? String(row.key) : undefined}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {renderItem(item, row.index)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {stick.isAtBottom ? null : (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Scroll to the latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-sm"
          onClick={() => void stick.scrollToBottom()}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
