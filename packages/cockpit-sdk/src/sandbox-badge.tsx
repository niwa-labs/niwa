import { useCall } from "./hooks.ts";
import { useViewer } from "./runtime.tsx";
import { z } from "zod";

const lastRecord = {
  name: "niwa.records.read",
  input: z.object({ types: z.array(z.string()), filter: z.record(z.string(), z.string()), tail: z.number() }),
  output: z.object({ records: z.array(z.object({ data: z.object({ mark: z.string(), sandbox: z.string().optional() }) })) }),
};

/** Use the manifest of this launch; a resumed session may have a different box. */
export function SessionSandboxBadge({ session }: { session: string }) {
  const viewer = useViewer();
  const marks = useCall(lastRecord, { types: ["session.marked"], filter: { session }, tail: 1 }, {
    enabled: viewer.can(lastRecord.name),
    staleTime: Infinity,
    refreshOn: { types: ["session.marked"], where: row => (row.data as {session?: string}).session === session },
  });
  const mark = marks.data?.records[0]?.data.mark;
  const manifest = useCall(lastRecord, { types: ["session.box.manifest"], filter: { mark: mark ?? "" }, tail: 1 }, {
    enabled: !!mark && viewer.can(lastRecord.name), staleTime: Infinity,
  });
  const name = manifest.data?.records[0]?.data.sandbox;
  if (!name) return null;
  return <span data-slot="sandbox-badge" className="inline-flex w-fit items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs text-foreground">
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="m8 1.5 6 3.25v6.5L8 14.5l-6-3.25v-6.5zM2 4.75 8 8l6-3.25M8 8v6.5"/>
    </svg>
    <span className="text-muted-foreground">Песочница</span>
    <strong className="font-mono font-semibold">{name}</strong>
  </span>;
}
