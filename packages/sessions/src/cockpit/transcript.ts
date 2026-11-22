/** A transcript as the page draws it: turns, tool calls with their results, and the notes between. */

import type { TranscriptRecord } from "./actions.ts";

export type TranscriptItem =
  | { kind: "turn"; key: string; role: "user" | "assistant"; text: string; model?: string | undefined }
  | { kind: "tool"; key: string; name: string; category?: string | undefined; target?: string | undefined; paths?: string[] | undefined; input: unknown; output: unknown; state: "running" | "done" | "failed" }
  | { kind: "note"; key: string; label: string; text: string; collapsible?: boolean };

function userText(record: Extract<TranscriptRecord, { kind: "user" }>): string {
  let text = "";
  let cursor = 0;
  for (const { from, to } of [...(record.inserted ?? [])].sort((a, b) => a.from - b.from)) {
    if (from > cursor) text += record.text.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  return text + record.text.slice(cursor);
}

/**
 * The items of a transcript, in order. A tool result joins the call it answers by the call's id, wherever it lies after it; a
 * call with no result yet is running; a result whose call is not in the page (it lies before the window) stands alone.
 */
export function itemsOf(records: readonly TranscriptRecord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const open = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  records.forEach((record, index) => {
    const key = record.kind === "tool-call" || record.kind === "tool-result"
      ? `tool:${record.callId}`
      : record.locator ?? `#${String(index)}`;
    switch (record.kind) {
      case "user": {
        const text = userText(record);
        if (text.trim() !== "" || !record.inserted?.length || record.images?.length) {
          items.push({ kind: "turn", key, role: "user", text: text.trim() === "" && record.images?.length ? "[image]" : text });
        }
        return;
      }
      case "assistant":
        items.push({ kind: "turn", key, role: "assistant", text: record.text, model: record.model });
        return;
      case "thinking":
        items.push({ kind: "note", key, label: "Thinking", collapsible: !record.redacted && !!record.text, text: record.redacted ? "Kept sealed by the harness." : record.text });
        return;
      case "tool-call": {
        const tool: Extract<TranscriptItem, { kind: "tool" }> = { kind: "tool", key, name: record.name, category: record.category, target: record.target, paths: record.paths, input: record.input, output: undefined, state: "running" };
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
      case "checklist": {
        const done = record.items.filter((item) => item.state === "done").length;
        items.push({ kind: "note", key, label: "Checklist", text: `${String(done)} of ${String(record.items.length)} done` });
        return;
      }
      case "permission":
        items.push({ kind: "note", key, label: "Permission", text: `${record.tool ?? "a tool"}: ${record.outcome}` });
        return;
      case "compaction":
        items.push({ kind: "note", key, label: "Compacted", text: record.summary });
        return;
      case "nested":
        items.push({ kind: "note", key, label: "Nested session", text: `${record.child.harness}/${record.child.native}` });
        return;
      case "unknown":
        if (!record.metadata) items.push({ kind: "note", key, label: "Unrecognised record", text: "" });
        return;
    }
  });
  return items;
}
