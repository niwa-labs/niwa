/**
 * The catalog: what niwa knows about the sessions there are, without copying any of them.
 *
 * It holds a pointer and an index per session. The harness's own transcript is never in here: a
 * reader asks the reading side for it. Whom a session serves is not a field of the session: the
 * attachments are kept apart, each with its source.
 */

import type { z } from "zod";

import { Address } from "@niwa-labs/core";
import type { StoredRecord, Timestamp } from "@niwa-labs/core";

import { SessionRefSchema } from "./identity.ts";
import type { NiwaSessionId, SessionRef } from "./identity.ts";
import { LIFE_TYPES, lifeOf } from "./life.ts";
import type { LifeState } from "./life.ts";
import { SessionActivity, SessionBelongs, SessionModel, SessionStarted } from "./records.ts";
import type { BelongingSource } from "./records.ts";

/** What niwa knows about one session. Every field but the pointer may be absent. */
export interface SessionEntry {
  readonly ref: SessionRef;
  /** The id niwa gave the session; absent for a session niwa did not start. */
  readonly id?: NiwaSessionId;
  /** A readable title, as the reading side gives it. */
  readonly title?: string;
  readonly cwd?: string;
  /** The model the harness named for the session; absent until it names one. */
  readonly model?: string;
  readonly startedAt?: number;
  /** The last sign of life, when one is known. */
  readonly lastActivityAt?: number;
  readonly state: LifeState;
}

/** One attachment of a session, from a record of its own. */
export interface Belonging {
  readonly session: SessionRef;
  /** The address the session serves, as a tagged value. */
  readonly to: Address;
  readonly source: BelongingSource;
}

/** The sessions niwa knows: from its own records, and from what the reading sides list. */
export class SessionCatalog {
  private readonly entries = new Map<SessionRef, SessionEntry>();
  private readonly attachments: Belonging[] = [];

  /** Every session, in the order of the pointer. */
  all(): SessionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  }

  get(ref: SessionRef): SessionEntry | undefined {
    return this.entries.get(ref);
  }

  /** The attachments of the given sessions. */
  belongings(refs: ReadonlySet<SessionRef>): Belonging[] {
    return this.attachments.filter((belonging) => refs.has(belonging.session));
  }

  /** Put a session in. What is already known is kept: an absent fact never replaces a known one. */
  remember(entry: SessionEntry): void {
    const known = this.entries.get(entry.ref);
    if (known === undefined) {
      this.entries.set(entry.ref, entry);
      return;
    }
    this.entries.set(entry.ref, {
      ref: known.ref,
      id: known.id ?? entry.id,
      title: known.title ?? entry.title,
      cwd: known.cwd ?? entry.cwd,
      model: known.model ?? entry.model,
      startedAt: known.startedAt ?? entry.startedAt,
      lastActivityAt: known.lastActivityAt ?? entry.lastActivityAt,
      state: known.state === "unknown" ? entry.state : known.state,
    });
  }

  /**
   * Build the catalog from niwa's own session records, given in journal order.
   *
   * `bootedAt` is when this process began: a turn left open by an earlier process is `unknown`.
   */
  static fromRecords(records: readonly StoredRecord[], bootedAt: Timestamp): SessionCatalog {
    const catalog = new SessionCatalog();
    const life = new Map<SessionRef, StoredRecord[]>();
    const starts = new Map<SessionRef, z.output<typeof SessionStarted.schema> & { at: Timestamp }>();
    const activity = new Map<SessionRef, Timestamp>();
    const models = new Map<SessionRef, string>();

    for (const record of records) {
      const ref = refOf(record);
      if (ref === undefined) continue;
      if (LIFE_TYPES.includes(record.type)) life.set(ref, [...(life.get(ref) ?? []), record]);
      if (record.type === SessionStarted.name && !starts.has(ref)) {
        const started = SessionStarted.schema.safeParse(record.data);
        if (started.success) starts.set(ref, { ...started.data, at: record.at });
      }
      if (record.type === SessionActivity.name) activity.set(ref, record.at);
      if (record.type === SessionModel.name) {
        const named = SessionModel.schema.safeParse(record.data);
        if (named.success) models.set(ref, named.data.model);
      }
      if (record.type === SessionBelongs.name) {
        const attachment = belongingOf(ref, record);
        if (attachment !== undefined) catalog.attachments.push(attachment);
      }
    }

    for (const [ref, start] of starts) {
      catalog.remember({
        ref,
        id: start.id,
        cwd: start.cwd,
        model: models.get(ref),
        startedAt: start.at,
        lastActivityAt: activity.get(ref),
        state: lifeOf(life.get(ref) ?? [], bootedAt),
      });
    }
    return catalog;
  }
}

function dataOf(record: StoredRecord): { session?: unknown; to?: { kind?: unknown; id?: unknown }; source?: unknown } {
  return record.data as ReturnType<typeof dataOf>;
}

/** The pointer a session record names, when it names one. */
function refOf(record: StoredRecord): SessionRef | undefined {
  const parsed = SessionRefSchema.safeParse(dataOf(record).session);
  return parsed.success ? parsed.data : undefined;
}

function belongingOf(session: SessionRef, record: StoredRecord): Belonging | undefined {
  const parsed = SessionBelongs.schema.safeParse(record.data);
  if (!parsed.success) return undefined;
  return { session, to: parsed.data.to, source: parsed.data.source };
}
