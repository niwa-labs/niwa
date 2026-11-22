import { CORE_TYPES } from "@niwa-labs/core";
import type { JournalReader, RecordId, RecordTypeName, Seq, StoredRecord } from "@niwa-labs/core";
import { requestAsk } from "@niwa-labs/requests/records";
import { z } from "zod";

const Intent = z.object({
  key: z.string(),
  action: z.string(),
  operationId: z.string(),
  input: z.unknown().optional(),
  recovery: z.enum(["repeat", "repeat-with-key", "do-not-repeat"]).optional(),
});
const Resolution = z.object({ key: z.string(), choice: z.enum(["retry", "skip", "cancel"]), attempt: z.number().int() });
const AskEnd = z.object({ outcome: z.object({ status: z.literal("completed"), value: z.object({ ended: z.enum(["cancelled", "expired"]) }) }) });

// Nested actions and waits use the parent attempt's key as their namespace.
export const nestedKey = /^(.+)\.(?:step|wait)-\d+$/;

export interface InvocationAttempt {
  row: StoredRecord;
  data: z.infer<typeof Intent>;
  namespace: string;
  parent?: InvocationAttempt;
  outcome?: StoredRecord;
  askEnd?: StoredRecord;
  askStatus?: "cancelled" | "expired";
  resolution?: { row: StoredRecord; choice: z.infer<typeof Resolution>["choice"] };
  replaced: boolean;
  superseded: boolean;
  open: boolean;
}

export function readAttempts(journal: JournalReader, invocation: string) {
  const rows = (type: RecordTypeName) => journal.find({ type, field: "invocation", equals: invocation });
  const resolutions = new Map(rows(CORE_TYPES.invocationResolved).map((row) => {
    const { key, choice, attempt } = Resolution.parse(row.data);
    const suffix = attempt > 0 ? "#" + (attempt + 1) : "";
    return [invocation + "/" + key + suffix, { row, choice }] as const;
  }));
  const outcomes = new Map(rows(CORE_TYPES.stepOutcome).map((row) => [String(row.id), row]));
  const intents = rows(CORE_TYPES.stepIntent).map((row) => ({ row, data: Intent.parse(row.data) }));
  const latest = new Map<string, RecordId>();
  const next = new Map<RecordId, Seq>();
  for (const { row, data } of intents) {
    const previous = latest.get(data.key);
    if (previous !== undefined) next.set(previous, row.seq);
    latest.set(data.key, row.id);
  }
  const authorized = new Set(intents.filter(({ data }) => data.action === "workflow.authorize").map(({ data }) => data.key));
  const owners = new Map<string, InvocationAttempt>();
  const attempts = intents.map(({ row, data }): InvocationAttempt => {
    const { key, operationId, action } = data;
    const suffix = operationId.slice(invocation.length + key.length + 1);
    const namespace = suffix.startsWith("#") ? key + "." + suffix.slice(1) : key;
    const parentKey = nestedKey.exec(key)?.[1];
    // An explicit script label can look like a nested key. Its authorization identifies it.
    const parent = parentKey === undefined || authorized.has(key + "~auth") ? undefined : owners.get(parentKey);
    const outcome = outcomes.get(row.id.replace(/\/intent$/, "/outcome"));
    const askEnd = action === requestAsk.name ? outcomes.get(invocation + "/step/" + key + "~ended/outcome") : undefined;
    const nextIntent = next.get(row.id);
    const askStatus = askEnd !== undefined && askEnd.seq > row.seq && (nextIntent === undefined || askEnd.seq < nextIntent)
      ? AskEnd.safeParse(askEnd.data).data?.outcome.value.ended : undefined;
    const resolution = resolutions.get(operationId);
    const replaced = nextIntent !== undefined || resolution?.choice === "retry";
    const superseded = replaced || parent?.superseded === true;
    const open = !superseded && outcome === undefined && askStatus === undefined && resolution === undefined
      && (parent === undefined || parent.open);
    const attempt = { row, data, namespace, parent, outcome, askEnd, askStatus, resolution, replaced, superseded, open };
    owners.set(namespace, attempt);
    return attempt;
  });
  return { attempts, outcomes, authorized };
}
