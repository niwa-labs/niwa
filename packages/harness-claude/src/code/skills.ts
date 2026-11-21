/** Where Claude Code reads skills from. */

import { join } from "node:path";

import type { KindSkills } from "@niwa-labs/harness";

export const claudeCodeSkills: KindSkills = {
  kind: "claude-code",
  roots: {
    user: (home) => join(home, ".claude", "skills"),
    project: join(".claude", "skills"),
  },
};
