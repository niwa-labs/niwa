/**
 * Coverage: how much of a session was actually read.
 *
 * Only `empty` says there is nothing there; every other status says the answer is not known.
 */

import type { Coverage } from "@niwa-labs/harness";

/** Whether the coverage says there is nothing there. */
export function isEmpty(coverage: Coverage): boolean {
  return coverage.status === "empty";
}

/** A one-line description of the coverage. It says "nothing" only for `empty`. */
export function describeCoverage(coverage: Coverage): string {
  switch (coverage.status) {
    case "empty":
      return "scanned and empty";
    case "not-scanned":
      return "not scanned";
    case "failed":
      return `scan failed: ${coverage.reason}`;
    case "unavailable":
      return `unavailable: ${coverage.reason}`;
  }
}
