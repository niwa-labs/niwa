/** Where Codex reads skills from: the root shared by the agents that read `.agents/skills`. */

import { SHARED_AGENTS_SKILLS } from "@niwa-labs/harness";
import type { KindSkills } from "@niwa-labs/harness";

export const codexSkills: KindSkills = { kind: "codex", roots: SHARED_AGENTS_SKILLS };
