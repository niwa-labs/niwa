/**
 * The plugin that finds the installed harnesses.
 *
 * The finding itself, `discover()`, is the harness module's: it looks at the machine and says what
 * it found. This is the niwa side of it: the record of a proposal, and the action
 * `harness.discover` that makes the finding and writes the proposals.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { action, actionRef, record, recordId, stableJson } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { HarnessMissingSchema, HarnessProposalSchema, discover } from "@niwa-labs/harness";
import type { DiscoverEnv, HarnessKindDefinition, HarnessProposal } from "@niwa-labs/harness";

/** An installation was found. The owner confirms it, and the instance it becomes is the owner's. */
export const HarnessProposed = record("harness.proposed", HarnessProposalSchema);

/**
 * The id of the record of a proposal.
 *
 * It follows the installation: the same kind, the same binary, the same version and the same
 * home are one proposal, so a second finding finds the record that is already there and writes
 * nothing new. The home is part of the id because the record carries it: an installation whose
 * home has moved is another proposal, not a contradiction of the first one.
 */
export function proposalIdOf(proposal: HarnessProposal): string {
  const hash = createHash("sha256")
    .update(
      stableJson({
        kind: proposal.kind,
        path: proposal.binary?.path ?? "",
        version: proposal.binary?.version ?? "",
        home: proposal.home,
      }),
    )
    .digest("hex");
  return recordId(`prop_${hash.slice(0, 32)}`);
}

/** The name of the action the finding is called by. */
export const HARNESS_DISCOVER_ACTION = "harness.discover";

/** What the action answers: the installations that are there, and the kinds that are not. */
export const HarnessDiscoverOutputSchema = z.object({
  proposals: z.array(HarnessProposalSchema),
  missing: z.array(HarnessMissingSchema),
});
export type HarnessDiscoverOutput = z.output<typeof HarnessDiscoverOutputSchema>;

/** The finding, as a typed reference: what a caller imports to call `harness.discover`. */
export const harnessDiscover = actionRef(HARNESS_DISCOVER_ACTION, {
  description:
    "Finds the harnesses installed on this machine and proposes instances of them. A proposal is not an instance: the id and the machine are the owner's to give.",
  input: z.object({
    /** Only these kinds. Every kind of the plugin when it is absent. */
    kinds: z.array(z.string().min(1)).optional(),
  }),
  output: HarnessDiscoverOutputSchema,
});

/** What the finding is given. */
export interface HarnessDiscoveryOptions {
  /** The kinds to look for. Each of them says how it is found. */
  readonly kinds: readonly HarnessKindDefinition[];
  /** The environment to look in. The environment of the process when it is absent. */
  readonly env?: DiscoverEnv;
}

/**
 * The plugin that finds the installed harnesses.
 *
 * It declares the record of a proposal and the action that makes the finding. The proposals
 * are written by the plugin and not by the call: their ids follow the installations, so a
 * second finding of the same installations writes nothing new.
 */
export function harnessDiscovery(options: HarnessDiscoveryOptions): Plugin {
  const env = options.env ?? process.env;
  return plugin("harness-discovery", (api) => {
    api.declare(HarnessProposed);

    api.action(
      action(harnessDiscover, {
        // The finding changes nothing that cannot be made again: the proposals are written
        // under ids that follow the installations.
        recovery: "repeat",
        run: async (input): Promise<HarnessDiscoverOutput> => {
          const wanted = input.kinds;
          const kinds =
            wanted === undefined
              ? options.kinds
              : options.kinds.filter((kind) => wanted.includes(String(kind.kind)));
          const { proposals, missing } = await discover(kinds, env);
          for (const proposal of proposals) {
            await api.emit(HarnessProposed, proposal, { id: proposalIdOf(proposal) });
          }
          return { proposals: [...proposals], missing: [...missing] };
        },
      }),
    );
  });
}
