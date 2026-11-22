import { stepPause } from "@niwa-labs/ui-kit";
import type { RunEntry } from "./actions.ts";

/** The CLI's "about" text can contain truncated serialised output. Full results belong to the run detail. */
export function runSummary(entry: RunEntry): string {
  if (entry.state === "finished") {
    if (entry.about.startsWith("failed: ")) return "Ошибка · " + entry.about.slice(8);
    if (entry.about === "cancelled") return "Остановлен";
    return "Выполнен";
  }
  if (entry.requests) return "Ждёт ответа";
  if (entry.manualPause) return "Приостановлен владельцем";
  if (entry.state === "paused") {
    const pause = stepPause(entry.about);
    return pause ? pause.title + " · " + pause.label : entry.about || "На паузе";
  }
  if (entry.waiting?.startsWith("sleep ")) return "Ждёт таймер";
  if (entry.waiting?.startsWith("wait ")) return "Ждёт события";
  return entry.phases?.find(phase => phase.state === "current")?.title ?? "Выполняется";
}
