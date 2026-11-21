// The git module's actions run by hand on a journal in memory, so a call can be cut off at a chosen record and made
// again under the same operation, as the host makes it again after a crash. The records are numbered as the host
// numbers them (`<operation>/emit/<n>`); a record written again must say what it said, as the journal demands.

import { stableJson } from "@niwa-labs/core";
import type { Action, ActionContext, JournalReader, RecordType, StoredRecord } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";

import { git } from "../src/index.ts";

/** The records written so far, as the module reads and the host keeps them. */
export class MemoryJournal {
  readonly records: StoredRecord[] = [];

  reader(): JournalReader {
    const view = {
      get: (id: string) => this.records.find((row) => row.id === id),
      since: (_from: unknown, types?: string[]) => this.records.filter((row) => types === undefined || types.includes(row.type)),
      last: () => this.records.length,
    };
    return view as unknown as JournalReader;
  }

  of(type: string): StoredRecord[] {
    return this.records.filter((row) => row.type === type);
  }
}

/** A call cut off: what an action throws when the host stops under it. */
export class CutOff extends Error {}

/** The actions of the git module over a journal in memory, in a home. */
export function module(journal: MemoryJournal, home: string): ReadonlyMap<string, Action<any, any>> {
  const actions = new Map<string, Action<any, any>>();
  const api = {
    home: () => home,
    emit: async (type: RecordType<any>, data: unknown, opts: {id: string}) => {
      const existing = journal.reader().get(opts.id as StoredRecord["id"]);
      if (existing) return existing;
      const row = {id: opts.id, data, type: type.name, actor: {kind: "host"}, seq: journal.records.length + 1} as StoredRecord;
      journal.records.push(row);
      return row;
    },
    journal: () => journal.reader(),
    action: (made: Action<any, any>) => void actions.set(made.name, made),
    offer: () => {},
    declare: () => {},
    subscribers: () => {},
  } as unknown as PluginApi;
  git({ cleanup: false }).setup(api);
  return actions;
}

/**
 * Run an action under an operation. `cutAt` is the number of the record whose write the host is cut off at: the
 * records before it are written, it and the ones after are not, and the call ends with `CutOff`.
 */
export async function run<O>(
  actions: ReadonlyMap<string, Action<any, any>>,
  journal: MemoryJournal,
  name: string,
  input: unknown,
  operation: string,
  cutAt?: number,
): Promise<O> {
  const found = actions.get(name);
  if (found === undefined) throw new Error(`no action ${name}`);
  let ordinal = 0;
  const ctx = {
    operationId: operation,
    caller: { kind: "owner" },
    emit: async <T>(type: RecordType<T>, data: T): Promise<StoredRecord> => {
      ordinal += 1;
      if (ordinal === cutAt) throw new CutOff(`cut off before record ${String(ordinal)}`);
      const id = `${operation}/emit/${String(ordinal)}`;
      const earlier = journal.records.find((row) => row.id === id);
      if (earlier !== undefined) {
        if (earlier.type !== type.name || stableJson(earlier.data) !== stableJson(data)) {
          throw new Error(`replay mismatch at ${id}: it was ${earlier.type}, and is ${type.name} now`);
        }
        return earlier;
      }
      const stored = { id, seq: journal.records.length + 1, type: type.name, data, at: Date.now() } as unknown as StoredRecord;
      journal.records.push(stored);
      return stored;
    },
  } as unknown as ActionContext;
  return (await found.run(found.input.parse(input), ctx)) as O;
}
