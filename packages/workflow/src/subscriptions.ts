/**
 * The installations of the workflow module as the journal holds them.
 *
 * An installation is a `workflow.subscription.installed` record, and it lasts until a
 * `workflow.subscription.uninstalled` record of the same id that comes after it. Nothing is kept
 * outside the journal, so a restart of the host loses nothing.
 */

import { CORE_TYPES, RuleSpecSchema, grant } from "@niwa-labs/core";
import type { EntityDescription, Grant, IssuedId, JournalReader, Principal, StoredRecord } from "@niwa-labs/core";
import { z } from "zod";

import { holds } from "@niwa-labs/core";
import { RunRequested, SubscriptionInstalled, SubscriptionUninstalled } from "./records.ts";
import type { Builtin, ContractHash, InstallationId, JsonSchemaValue, Subscription, WorkflowId, WorkflowVersion } from "./records.ts";

/** One installation, with the places in the journal where it began and where it ended. */
export interface Installation {
  id: InstallationId;
  description: EntityDescription;
  /** The registered workflow that was installed, and its version, when it was installed by its id. */
  workflow?: WorkflowId;
  version?: WorkflowVersion;
  /** The record that made it: the seed of its id. */
  record: StoredRecord["id"];
  file: string;
  hash: string;
  on: Subscription[];
  uses: string[];
  /** What the script declared at the installation: its schemas as JSON Schema, and their hash. */
  input?: JsonSchemaValue;
  output?: JsonSchemaValue;
  contract: ContractHash;
  /** Absent when nothing limited the installer. */
  installer?: Principal;
  /** Whether its runs are boxed. */
  box?: boolean;
  /** The built-in it is, when the workflow module made it for a plugin. */
  builtin?: Builtin;
  /** The position of the record that installed it: only records after it start runs. */
  seq: number;
  /** The position of the record that ended it, when it has ended. */
  removed?: number;
}

/** The profile the runs of an installation are held to. */
export const profileOf = (id: InstallationId): string => `wf:${id}`;

/** Every installation the journal holds, the ended ones too, in the order they were made. */
export function installationsOf(journal: JournalReader): Installation[] {
  const ends = journal.find({ type: SubscriptionUninstalled.name }).map((row) => ({
    seq: row.seq,
    id: SubscriptionUninstalled.schema.parse(row.data).installation,
  }));
  return journal.find({ type: SubscriptionInstalled.name }).map((row): Installation => {
    const data = SubscriptionInstalled.schema.parse(row.data);
    const removed = ends.find((end) => end.id === data.installation && end.seq > row.seq)?.seq;
    return {
      id: data.installation,
      description: data.description,
      ...(data.workflow === undefined ? {} : { workflow: data.workflow }),
      ...(data.version === undefined ? {} : { version: data.version }),
      record: row.id,
      file: data.file,
      hash: data.hash,
      on: data.on,
      uses: data.uses,
      ...(data.input === undefined ? {} : { input: data.input }),
      ...(data.output === undefined ? {} : { output: data.output }),
      contract: data.contract,
      ...(data.installer === undefined ? {} : { installer: data.installer }),
      ...(data.box === undefined ? {} : { box: data.box }),
      ...(data.builtin === undefined ? {} : { builtin: data.builtin }),
      seq: row.seq,
      ...(removed === undefined ? {} : { removed }),
    };
  });
}

/** The installations that stood at a position of the journal: made before it, not ended before it. */
export function standingAt(installations: readonly Installation[], at: number): Installation[] {
  return installations.filter((one) => one.seq < at && (one.removed === undefined || one.removed > at));
}

/** The installations that stand now. */
export const standing = (journal: JournalReader): Installation[] => standingAt(installationsOf(journal), journal.last() + 1);

/** The subscriptions of an installation that a record of this type and data starts it by. */
export function startedBy(installation: Installation, type: string, data: unknown): boolean {
  return installation.on.some((one) => one.type === type && holds(data, one.filter));
}

/** The installation ids that were issued, each with the record it was born in. */
export const installationIdsOf = (journal: JournalReader): IssuedId[] =>
  installationsOf(journal).map((one) => ({ id: one.id, seed: one.record }));

const ProfileData = z.object({ name: z.string(), rules: z.array(RuleSpecSchema) });

/** The rules the profile has now, as its latest `niwa.access.profile` record says; none when it was never set. */
export function profileRulesOf(journal: JournalReader, id: InstallationId): Grant | undefined {
  const last = journal.find({ type: CORE_TYPES.accessProfile, field: "name", equals: profileOf(id) }).at(-1);
  if (last === undefined) return undefined;
  return grant(ProfileData.parse(last.data).rules);
}

/**
 * The installations whose runs this record grew from: the installations of the starts of runs on its chain of causes.
 *
 * An installation does not start on a record of a script that its own run caused, however long the way:
 * a script that emits what it starts on, or two that start on each other, would otherwise go on for ever.
 */
export function causedByRunsOf(journal: JournalReader, record: StoredRecord): Set<InstallationId> {
  const installations = new Set<InstallationId>();
  for (let cause = record.cause; cause !== null; ) {
    const row = journal.get(cause);
    if (row === undefined) break;
    if (row.type === RunRequested.name) {
      const installation = RunRequested.schema.parse(row.data).installation;
      if (installation !== undefined) installations.add(installation);
    }
    cause = row.cause;
  }
  return installations;
}
