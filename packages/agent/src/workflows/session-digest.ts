// The digest of an attached session, a built-in workflow of the agents module: when a native session
// attached to an agent pauses or ends, the module makes its digest due, and this reads what the session did
// since the last digest (or since it was attached) as a digest, a window at a time, and tells the agent as a
// fact. The agent learns what the owner did without being told it again. One run reads a bounded number of
// windows: what is left of a long stretch is read at the next pause.
//
// The workflow module registers and installs it when the host starts; its runs hold `uses` and nothing more.

import type { ScriptApi } from "@niwa-labs/script";

declare const niwa: ScriptApi["niwa"];
declare const workflow: ScriptApi["workflow"];

/** One entry of a digest, as far as this script writes it out. */
interface Entry {
  kind: string;
  text?: string;
  summary?: string;
  name?: string;
  target?: string;
  status?: string;
  result?: string;
  done?: number;
  total?: number;
  tool?: string;
  outcome?: string;
}

/** About how many tokens one window holds, and how many windows one run reads at most. */
const BUDGET = 8_000;
const WINDOWS = 6;

/** A window of a digest read. */
interface Window {
  view: { mode: string; entries?: Entry[] };
  next: string | null;
  upto: string | null;
  files: unknown;
  /** The read started over: the position it was given belonged to another source, so this is the session from its top. */
  restarted?: boolean;
}

/** The line an entry is told as; a thought or a sealed record says nothing to the agent. */
function line(entry: Entry): string | undefined {
  switch (entry.kind) {
    case "user":
      return `The owner: ${entry.text ?? ""}`;
    case "assistant":
      return `The session: ${entry.text ?? ""}`;
    case "tool":
      return `- ${entry.name ?? "a tool"}${entry.target === undefined ? "" : ` ${entry.target}`}: ${entry.status ?? ""}`;
    case "compaction":
      return `The session compacted its context: ${entry.summary ?? ""}`;
    case "checklist":
      return `Checklist: ${String(entry.done ?? 0)} of ${String(entry.total ?? 0)} done`;
    case "permission":
      return `Permission for ${entry.tool ?? "a tool"}: ${entry.outcome ?? ""}`;
    default:
      return undefined;
  }
}

export default workflow(
  {
    on: ["agent.digest.due"],
    uses: ["agent.attachment", "session.read", "agent.notify"],
  },
  async (trigger: { data: { agent: string; session: string; ended: boolean } }) => {
    const { session, ended } = trigger.data;
    // Read now, not when the digest was made due: a digest written since then is not read again.
    const { agent, upto: last } = (await niwa.agent.attachment({ session }, { label: "attachment" })) as { agent?: string; upto?: string };
    if (agent === undefined) return;

    const lines: string[] = [];
    let from = last;
    let files: unknown;
    let upto = last;
    let more = false;
    // The history started over: what the agent was told before is in the window again, and nothing
    // says which of it is new. It is not told again; the agent is told that, and the position moves on.
    let restarted = false;
    for (let window = 0; window < WINDOWS; window += 1) {
      const read = (await niwa.session.read(
        { session, mode: "digest", budget: BUDGET, ...(from === undefined ? {} : { from }), ...(files === undefined ? {} : { files }) },
        { label: `read-${String(window)}` },
      )) as { digest?: Window };
      const digest = read.digest;
      if (digest === undefined) break;
      if (digest.restarted === true) {
        restarted = true;
        lines.length = 0;
      }
      if (!restarted) {
        for (const entry of digest.view.entries ?? []) {
          const said = line(entry);
          if (said !== undefined) lines.push(said);
        }
      }
      upto = digest.upto ?? upto;
      files = digest.files;
      more = digest.next !== null;
      if (!more) break;
      from = digest.next ?? undefined;
    }
    // Nothing new since the last digest: the agent is told nothing.
    if (upto === undefined || upto === last || (lines.length === 0 && !restarted)) return;
    const said = ended ? "The session ended." : "The session paused.";
    await niwa.agent.notify(
      {
        agent,
        text: [
          ...(restarted
            ? [`${said} Its history started over: the position of the last digest is no longer in it, so what it did since cannot be told apart from what came before.`]
            : [`${said} What it did${last === undefined ? "" : " since the last digest"}:`, ...lines]),
          ...(restarted ? [`Read it with session.read of ${session}; the next digest goes on from ${upto}.`] : []),
          ...(!more ? [] : ended ? [`(It did more after this: read it with session.read of ${session} from ${upto}.)`] : ["(It did more after this: the rest comes with the next digest.)"]),
        ].join("\n"),
        source: { kind: "session-digest", session, ...(last === undefined ? {} : { from: last }), upto },
      },
      { label: "notify" },
    );
  },
);
