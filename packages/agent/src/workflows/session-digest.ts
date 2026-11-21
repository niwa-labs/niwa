// Each step commits one bounded part against the attachment's current cursor. A final event drains
// the remaining parts, and a pause skips silent windows until it can report what the session did.
import type { ScriptApi } from "@niwa-labs/script";

declare const niwa: ScriptApi["niwa"];
declare const workflow: ScriptApi["workflow"];

export default workflow(
  { on: ["agent.digest.due"], uses: ["agent.attachment", "agent.digest.read"] },
  async (trigger: { data: { session: string; attachment: string; ended: boolean } }) => {
    const { session, attachment, ended } = trigger.data;
    for (let part = 0; ; part++) {
      const current = await niwa.agent.attachment({ session }, { label: `attachment-${part}` }) as { attachment?: string; upto?: string; pending?: boolean };
      if (current.attachment !== attachment) return;
      const next = await niwa.agent.digest.read(
        { session, attachment, ended, ...(current.upto === undefined ? {} : { from: current.upto }), ...(current.pending ? { pending: true } : {}) },
        { label: `part-${part}` },
      ) as { more: boolean; stale?: boolean };
      if (!next.more && !(ended && next.stale)) return;
    }
  },
);
