import { AccessGranted, principalOf, recordId, recordTypeName, runIdOfPrincipal } from "@niwa-labs/core";
import type { JournalReader, Principal, StoredRecord } from "@niwa-labs/core";
import { z } from "zod";

import { SessionMarked, SessionStarted } from "./records.ts";

// Sessions can run without the workflow plugin. Read the protected record's isolation
// fields without introducing a dependency cycle between the two plugins.
const RUN_REQUESTED = recordTypeName("workflow.run.requested");
const Isolation = z.object({
  run: z.string(),
  execution: z.string().optional(),
  box: z.boolean().optional(),
  parent: z.object({ run: z.string() }).optional(),
});

/** A plain child needs a real plain workflow execution and plain execution ancestors. */
export function plainWorkflow(journal: JournalReader, principal: Principal): boolean {
  if (principal.kind !== "run") return false;
  let grant = birthGrant(journal, principal);
  if (grant === undefined) return false;
  const visited = new Set<string>();
  while (principal.kind === "run" || principal.kind === "session") {
    const key = `${principal.kind}:${principal.id}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const request = principal.kind === "run" ? runRequest(journal, principal.id) : undefined;
    if (principal.kind === "run" ? request === undefined || Isolation.parse(request.data).box === true :
      !plainSession(journal, principal.id)) return false;

    // The original request keeps the host-attributed caller across revisions, including
    // starts by an unlimited caller whose grant has no parent link.
    const run = runIdOfPrincipal(principal.id);
    const origin = request === undefined || principal.id === run ? request : runRequest(journal, run);
    const namedParent = origin === undefined ? undefined : Isolation.parse(origin.data).parent;
    if (origin !== undefined && namedParent !== undefined) {
      const cause = origin.cause === null ? undefined : journal.get(origin.cause);
      const parentRun = cause === undefined ? undefined : isolationOf(cause);
      if (parentRun?.run !== namedParent.run) return false;
      principal = principalOf("run", parentRun.execution ?? parentRun.run);
      grant = birthGrant(journal, principal);
      continue;
    }
    const starter = origin?.actor.kind === "client" ? origin.actor.principal : undefined;
    if (starter?.kind === "run" || starter?.kind === "session") {
      principal = starter;
      grant = birthGrant(journal, principal);
      continue;
    }

    const parent = grant === undefined ? undefined : AccessGranted.schema.parse(grant.data).parent;
    if (parent === undefined) return true;
    principal = parent.principal;
    grant = journal.get(recordId(parent.grant));
    if (grant === undefined || !isGrantOf(grant, principal)) return false;
  }
  return true;
}

function isGrantOf(row: StoredRecord, principal: Principal): boolean {
  if (row.type !== AccessGranted.name) return false;
  const data = AccessGranted.schema.parse(row.data);
  return data.principal.kind === principal.kind && data.principal.id === principal.id;
}

function birthGrant(journal: JournalReader, principal: Principal): StoredRecord | undefined {
  return journal.find({ type: AccessGranted.name, field: "principal.id", equals: principal.id })
    .find((row) => row.actor.kind === "host" && isGrantOf(row, principal));
}

function runRequest(journal: JournalReader, execution: string): StoredRecord | undefined {
  const run = runIdOfPrincipal(execution);
  return journal.find({ type: RUN_REQUESTED, field: "run", equals: run }).findLast((row) => {
    const info = isolationOf(row);
    return info !== undefined && (info.execution ?? run) === execution;
  });
}

function isolationOf(row: StoredRecord): z.output<typeof Isolation> | undefined {
  const trusted = row.actor.issuedBy === "workflow" ||
    (row.actor.kind === "handler" && row.actor.handler.startsWith("workflow/"));
  if (row.type !== RUN_REQUESTED || !trusted) return undefined;
  const parsed = Isolation.safeParse(row.data);
  return parsed.success ? parsed.data : undefined;
}

function plainSession(journal: JournalReader, mark: string): boolean {
  const marked = journal.find({ type: SessionMarked.name, field: "mark", equals: mark })
    .findLast((row) => row.actor.issuedBy === "sessions");
  if (marked === undefined) return false;
  const { session } = SessionMarked.schema.parse(marked.data);
  const started = journal.find({ type: SessionStarted.name, field: "session", equals: session })
    .findLast((row) => row.actor.issuedBy === "sessions");
  return started !== undefined && SessionStarted.schema.parse(started.data).box === false;
}
