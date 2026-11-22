/** The state of the record feed, for the status bar. */

import { useStreamStatus } from "@niwa-labs/cockpit-sdk";

export function useStatus(): string {
  const { status, seq } = useStreamStatus();
  switch (status) {
    case "live":
      return `онлайн · ${String(seq)}`;
    case "connecting":
      return "подключение…";
    case "retrying":
      return "переподключение…";
    case "failed":
      return "связь прервана";
    case "idle":
      return "нет соединения";
  }
}
