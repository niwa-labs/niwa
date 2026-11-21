import { lstatSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { z } from "zod";

import { recordId } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import { CheckoutVerified, WorktreeCoordinates, WorktreeCreated, WorktreeId, WorktreeRemoved } from "./record-types.ts";
import type { Worktree } from "./record-types.ts";

type Coordinates = z.infer<typeof WorktreeCoordinates>;

const receiptId = (id: string) => recordId(`git/worktree/${id}/verified`);

function identities({id, repo, path}: Coordinates): string[] | undefined {
  const common = join(repo, ".git");
  try {
    return [path, common, join(common, "worktrees", id)].map(dir => {
      if (realpathSync(dir) !== dir) throw new Error("noncanonical directory");
      const stat = lstatSync(dir, {bigint: true});
      if (!stat.isDirectory()) throw new Error("missing directory");
      return `${stat.dev}:${stat.ino}`;
    });
  } catch {
    return undefined;
  }
}

export async function verifyCheckout(api: PluginApi, tree: Worktree, creation: string): Promise<void> {
  const coordinates = WorktreeCoordinates.parse(tree);
  const directories = identities(coordinates);
  if (directories) {
    await api.emit(CheckoutVerified, {...coordinates, creation, directories}, {id: receiptId(tree.id)});
  }
}

/** Resolve only a still-live checkout in this host's own managed store. */
export function registeredWorktree(api: Pick<PluginApi, "home" | "journal">, cwd: string): Coordinates | undefined {
  const journal = api.journal?.();
  if (!journal) return undefined;
  let store: string, dir: string;
  try {
    store = join(realpathSync(api.home()), "worktrees");
    dir = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const id = WorktreeId.safeParse(relative(store, dir).split(sep)[0]);
  if (!id.success) return undefined;
  const stamp = journal.get(receiptId(id.data));
  if (stamp?.actor.kind !== "host" || stamp.type !== CheckoutVerified.name) return undefined;
  const proof = CheckoutVerified.schema.safeParse(stamp.data);
  if (!proof.success || proof.data.id !== id.data || proof.data.path !== join(store, id.data)) return undefined;
  const created = journal.get(recordId(proof.data.creation));
  if (created?.type !== WorktreeCreated.name || created.seq <= stamp.seq) return undefined;
  const tree = WorktreeCreated.schema.safeParse(created.data);
  if (!tree.success || tree.data.id !== id.data || tree.data.path !== proof.data.path || tree.data.repo !== proof.data.repo) return undefined;
  if (journal.find({type: WorktreeRemoved.name, field: "id", equals: id.data}).length) return undefined;
  const current = identities(proof.data);
  if (!current?.every((identity, i) => identity === proof.data.directories[i])) return undefined;
  return WorktreeCoordinates.parse(tree.data);
}
