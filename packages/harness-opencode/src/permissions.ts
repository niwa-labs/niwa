import { Unsupported } from "@niwa-labs/harness";
import type { HarnessId, SessionMode } from "@niwa-labs/harness";
import type { PermissionRule } from "@opencode/client";

export const OPENCODE_MODES = ["auto", "full"] as const;
export type OpenCodeMode = (typeof OPENCODE_MODES)[number];

/**
 * OpenCode uses the last matching rule in the combined agent and session rules, then applies
 * saved project approvals to requests that those rules did not deny. Auto allows the built-in
 * file tools and leaves other requests to OpenCode's permission system, including external
 * directory access.
 */
export const MODE_PERMISSIONS: Record<OpenCodeMode, readonly PermissionRule[]> = {
  auto: [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
  ],
  full: [{ action: "*", resource: "*", effect: "allow" }],
};

export function requireOpenCodeMode(
  harness: HarnessId,
  operation: "start" | "resume",
  mode: SessionMode | undefined,
): asserts mode is OpenCodeMode | undefined {
  if (mode === "ask") {
    throw new Unsupported(
      harness,
      "control",
      operation,
      'mode "ask" requires approval before file changes, but OpenCode v2 can reuse saved project approvals before contacting Niwa',
    );
  }
}

/** Check the stored session rules in order. OpenCode applies project approvals separately. */
export function hasModePermissions(mode: OpenCodeMode, actual: readonly PermissionRule[] | undefined): boolean {
  const expected = MODE_PERMISSIONS[mode];
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((rule, index) => {
    const stored: PermissionRule | undefined = actual[index];
    return stored?.action === rule.action && stored.resource === rule.resource && stored.effect === rule.effect;
  });
}
