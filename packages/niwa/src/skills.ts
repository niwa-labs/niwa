/**
 * The kinds that read agent skills, and where: what `niwa skill install` writes to. Each kind
 * declares its own roots in its own directory; this only lists them.
 */

import type { KindSkills } from "@niwa-labs/harness";
import { claudeCodeSkills } from "@niwa-labs/harness-claude";
import { codexSkills } from "@niwa-labs/harness-codex";
import { mcodeSkills, ncodeSkills } from "@niwa-labs/harness-mcode";
import { opencodeSkills } from "@niwa-labs/harness-opencode";
import { piSkills } from "@niwa-labs/harness-pi";
import { zcodeSkills } from "@niwa-labs/harness-zcode";

export const KINDS_WITH_SKILLS: readonly KindSkills[] = [
  claudeCodeSkills,
  codexSkills,
  mcodeSkills,
  ncodeSkills,
  opencodeSkills,
  piSkills,
  zcodeSkills,
];
