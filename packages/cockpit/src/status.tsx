/** The state of the record feed, for the status bar. */

import { useStreamStatus } from "@niwa-labs/cockpit-sdk";

export function useStatus(): string {
  const { status, seq } = useStreamStatus();
  switch (status) {
    case "live":
      return `live · ${String(seq)}`;
    case "connecting":
      return "connecting…";
    case "retrying":
      return "reconnecting…";
    case "failed":
      return "feed lost";
    case "idle":
      return "idle";
  }
}
