/** A transcript as the page draws it: turns, tool calls with their results, and the notes between. */

import type { TranscriptRecord } from "./actions.ts";

export type TranscriptItem =
  | { kind: "turn"; key: string; role: "user" | "assistant"; text: string; model?: string | undefined }
  | { kind: "tool"; key: string; name: string; input: unknown; output: unknown; state: "running" | "done" | "failed" }
  | { kind: "note"; key: string; label: string; text: string };

/**
 * The items of a transcript, in order. A tool result joins the call it answers by the call's id, wherever it lies after it; a
 * call with no result yet is running; a result whose call is not in the page (it lies before the window) stands alone.
 */
export function itemsOf(records: readonly TranscriptRecord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const open = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  records.forEach((record, index) => {
    const key = record.locator ?? `#${String(index)}`;
    switch (record.kind) {
      case "user":
      case "assistant":
        items.push({ kind: "turn", key, role: record.kind, text: record.text, ...(record.kind === "assistant" ? { model: record.model } : {}) });
        return;
      case "thinking":
        items.push({ kind: "note", key, label: "Thinking", text: record.redacted ? "Kept sealed by the harness." : record.text });
        return;
      case "tool-call": {
        const tool: Extract<TranscriptItem, { kind: "tool" }> = { kind: "tool", key, name: record.name, input: record.input, output: undefined, state: "running" };
        open.set(record.callId, tool);
        items.push(tool);
        return;
      }
      case "tool-result": {
        const call = open.get(record.callId);
        const state = record.ok === false ? "failed" : "done";
        if (call === undefined) {
          items.push({ kind: "tool", key, name: record.name ?? "tool", input: undefined, output: record.output, state });
          return;
        }
        call.output = record.output;
        call.state = state;
        return;
      }
      case "compaction":
        items.push({ kind: "note", key, label: "Compacted", text: record.summary });
        return;
      case "nested":
        items.push({ kind: "note", key, label: "Nested session", text: `${record.child.harness}/${record.child.native}` });
        return;
      case "unknown":
        items.push({ kind: "note", key, label: "Unrecognised record", text: "" });
        return;
    }
  });
  return items;
}
