/**
 * Where OpenCode reads skills from: the root shared by the agents that read `.agents/skills` at
 * the user's, and `.opencode/skills` inside the project.
 */

import { join } from "node:path";

import { SHARED_AGENTS_SKILLS } from "@niwa-labs/harness";
import type { KindSkills } from "@niwa-labs/harness";

export const opencodeSkills: KindSkills = {
  kind: "opencode",
  roots: { user: SHARED_AGENTS_SKILLS.user, project: join(".opencode", "skills") },
};
