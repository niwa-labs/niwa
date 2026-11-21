/** The journal: the records the feed brought, newest first, each drawn by the view a module gave its type. */

import { recordList, SlotItem, useProjection, type StoredRecord } from "@niwa-labs/cockpit-sdk";

/** How many of the latest records the page keeps. */
export const JOURNAL_LIMIT = 200;

const RECENT = recordList({}, JOURNAL_LIMIT);

/** A record as the journal shows it when no module gave its type a view. */
function RecordRow({ record }: { record: StoredRecord }) {
  const data = JSON.stringify(record.data) ?? "";
  return (
    <div data-slot="record" className="flex min-w-0 items-baseline gap-3 text-sm">
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{record.seq}</span>
      <span className="shrink-0 font-medium">{record.type}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={data}>
        {data}
      </span>
    </div>
  );
}

export function Journal() {
  const records = useProjection(RECENT);
  return (
    <div data-slot="journal" className="flex min-w-0 flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Journal</h1>
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records have arrived yet.</p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-1.5">
          {[...records].reverse().map((record) => (
            <li key={record.id} className="min-w-0 border-b pb-1.5">
              <SlotItem name="record.view" itemKey={record.type} props={{ record }} fallback={<RecordRow record={record} />} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
