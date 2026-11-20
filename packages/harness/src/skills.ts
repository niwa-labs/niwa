/**
 * Where a harness kind reads agent skills from.
 *
 * A skill is a directory `<skills-root>/<name>/SKILL.md`. Each kind declares the roots it reads,
 * next to the kind's own code; the `niwa skill` command installs into them and keeps no table of
 * its own. A kind that has no skill mechanism declares nothing and is refused by name.
 */

import { join } from "node:path";

/** The directories of skills a kind reads: the user's, and the project's. */
export interface SkillRoots {
  /** The user's skills root, given the home of the user. */
  readonly user: (home: string) => string;
  /** The project's skills root, relative to the project directory. */
  readonly project: string;
}

/** The roots of one kind, named by the kind. */
export interface KindSkills {
  readonly kind: string;
  readonly roots: SkillRoots;
}

/**
 * The roots shared by the agents that read `.agents/skills`: Codex, ZCode, pi and MiniMax Code.
 * Codex also reads `$CODEX_HOME/skills`; the shared root is the one every one of them reads.
 */
export const SHARED_AGENTS_SKILLS: SkillRoots = {
  user: (home) => join(home, ".agents", "skills"),
  project: join(".agents", "skills"),
};
