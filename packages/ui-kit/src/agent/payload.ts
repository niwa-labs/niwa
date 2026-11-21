/** The text of a tool's input or output: strings as they are, anything else as indented JSON. */
export function formatPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A duration in milliseconds, short: `850ms`, `4.2s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How long ago a moment was, short: `just now`, `5m ago`, `3h ago`, `2d ago`, and past a month the date. The moment is
 * milliseconds since the epoch or an ISO time; a moment that is not one gives an empty text.
 */
export function formatAgo(at: number | string, now: number = Date.now()): string {
  const moment = typeof at === "number" ? at : Date.parse(at);
  // A number can be finite and still outside the range a date holds.
  if (Number.isNaN(new Date(moment).getTime())) return "";
  const seconds = Math.round((now - moment) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${String(days)}d ago`;
  return new Date(moment).toISOString().slice(0, 10);
}
