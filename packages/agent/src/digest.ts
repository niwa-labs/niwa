import { RECORD_DATA_LIMIT } from "@niwa-labs/core";
import type { ActionContext, ArtifactStore } from "@niwa-labs/core";
import { sessionRead } from "@niwa-labs/sessions/records";
import type { agentDigestRead } from "./records.ts";

type Input = ReturnType<typeof agentDigestRead.input.parse>;
type Read = ReturnType<typeof sessionRead.output.parse>;
type Part = { upto?: string; text?: string; more: boolean };

type Entry = Extract<NonNullable<Read["digest"]>["view"], { mode: "digest" }>["entries"][number];

/** About how many tokens one window holds, and how many windows one part reads at most. */
const BUDGET = 8_000;
const WINDOWS = 6;

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

function readable(read: Read): boolean {
  return read.coverage.status !== "failed" && read.coverage.status !== "unavailable";
}

/** A complete tail read can set a fresh boundary even when its transcript is empty. */
async function boundary(session: string, ctx: ActionContext): Promise<Part | undefined> {
  const read = await ctx.step(sessionRead, { session, window: { limit: 1 } });
  if (!readable(read)) return undefined;
  const upto = read.records.at(-1)?.locator;
  if (upto === undefined && read.coverage.status !== "empty") return undefined;
  return { ...(upto === undefined ? {} : { upto }), more: false };
}

/** Read one part. A fact leaves room for its envelope and the session prompt that will carry it. */
export async function readDigest(input: Input, ctx: ActionContext, artifacts: ArtifactStore): Promise<Part | undefined> {
  const { session, from, ended } = input;
  if (input.pending === true) return boundary(session, ctx);
  const event = ended ? "The session ended." : "The session paused.";
  const lines: string[] = [];
  let upto = from;
  let files: NonNullable<Read["digest"]>["files"] | undefined;
  let more = false;
  let bytes = 0;
  const limit = RECORD_DATA_LIMIT / 2;
  for (let window = 0; window < WINDOWS; window++) {
    const read = await ctx.step(sessionRead, { session, mode: "digest", budget: BUDGET, ...(upto === undefined ? {} : { from: upto }), ...(files === undefined ? {} : { files }) });
    const digest = read.digest;
    if (!readable(read) || digest?.view.mode !== "digest") break;
    if (digest.restarted === true) {
      const tail = await boundary(session, ctx);
      if (tail === undefined) return undefined;
      return { ...tail, text: `${event} Its history started over. Read the transcript with session.read of ${session}.` };
    }
    if (digest.upto === null || digest.upto === upto) break;
    const words = digest.view.entries.map(line).filter((value): value is string => value !== undefined).join("\n");
    const size = Buffer.byteLength(JSON.stringify(words));
    if (words && bytes + size > limit && lines.length > 0) {
      more = true;
      break;
    }
    if (words && size > limit) {
      const artifact = artifacts.put(words, "text/plain;charset=utf-8");
      lines.push(`The transcript excerpt is in artifact ${artifact.digest} (${artifact.size} bytes).`);
    } else if (words) {
      lines.push(words);
    }
    bytes += size;
    upto = digest.upto;
    files = digest.files;
    more = digest.next !== null;
    if (!more) break;
  }
  if (upto === from || upto === undefined) return undefined;
  if (lines.length === 0) return { upto, more };
  const head = `${event} What it did${from === undefined ? "" : " since the last digest"}:`;
  if (more) lines.push("(It did more after this: the rest comes with the next digest.)");
  return { upto, text: [head, ...lines].join("\n"), more };
}
