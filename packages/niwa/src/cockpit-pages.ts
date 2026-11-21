/**
 * cockpit-pages.ts — the pages of the cockpit that reach beyond the generic web surface.
 *
 * The web surface calls the actions every page may call, and knows no module by name. The
 * workflow page calls actions of its own, and only for the owner: those are composed here, in
 * the umbrella, which may import both.
 */

import { scriptOn } from "@niwa-labs/script";
import type { OwnerAction } from "@niwa-labs/web";
import {
  versionOf,
  workflowCheck,
  workflowContinue,
  workflowGet,
  workflowInstall,
  workflowList,
  workflowPause,
  workflowRegister,
  workflowRevise,
  workflowStart,
  workflowStats,
  workflowUninstall,
} from "@niwa-labs/workflow";
import { z } from "zod";

/** A workflow starts from exactly one of a registered id and a file. */
const WorkflowStartTarget = z.union([
  z.object({ id: z.string().trim().min(1), file: z.undefined().optional() }),
  z.object({ file: z.string().trim().min(1), id: z.undefined().optional() }),
]);

/**
 * A version registered before `on` was recorded has none in its registration: the `on` of its script is read from the
 * text of the copy niwa keeps of it, as a check reads it. A version with no copy, or one that cannot be read, stays as it was.
 */
async function withRecordedOn(entity: unknown): Promise<unknown> {
  const got = workflowGet.output.safeParse(entity);
  if (!got.success) return entity;
  const versions = await Promise.all(
    got.data.versions.map(async (one) => {
      if (one.on !== undefined) return one;
      if (one.stored === undefined) return one;
      const file = one.stored;
      try {
        if (versionOf(file) !== one.version) return one;
        const on = await scriptOn({ file, text: await Bun.file(file).text() });
        return on === undefined || "bad" in on ? one : { ...one, on: on.subscriptions.map(({ type, filter }) => ({ type, ...(filter === undefined ? {} : { filter }) })) };
      } catch {
        return one;
      }
    }),
  );
  return { ...got.data, versions };
}

/** The actions only the owner's page calls: the workflow page. */
export const COCKPIT_OWNER_ACTIONS: readonly OwnerAction[] = [
  { ref: workflowCheck },
  { ref: workflowContinue },
  { ref: workflowGet, shape: withRecordedOn },
  { ref: workflowInstall },
  { ref: workflowList },
  { ref: workflowPause },
  { ref: workflowRegister },
  { ref: workflowRevise },
  {
    ref: workflowStart,
    refuse: (input) =>
      WorkflowStartTarget.safeParse(input).success ? undefined : "a workflow start requires exactly one of id or file",
  },
  { ref: workflowStats },
  { ref: workflowUninstall },
];
