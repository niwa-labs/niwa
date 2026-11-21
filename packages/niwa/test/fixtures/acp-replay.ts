/**
 * A fake ACP agent that replays recorded frames: it answers `initialize` with `initialize` (the
 * recorded reply, when there is one), `session/new` with a session id, every other request with an
 * empty result, and on a prompt whose text is "go" writes the frames, then ends the turn. The agent
 * writes what the client answered to its requests into `replies.log`.
 */

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LifeEvent } from "@niwa-labs/harness";

export const REPLAY_SESSION = "replay-session";

export async function replayAgent(dir: string, frames: readonly unknown[], initialize: unknown = {}): Promise<string> {
  const path = join(dir, "replay-acp");
  await writeFile(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const frames = ${JSON.stringify(frames)};
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.method === undefined) { appendFileSync(${JSON.stringify(join(dir, "replies.log"))}, JSON.stringify(message) + "\\n"); continue; }
    if (message.id === undefined) continue;
    if (message.method === "initialize") out({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(initialize)} });
    else if (message.method === "session/new") out({ jsonrpc: "2.0", id: message.id, result: { sessionId: "${REPLAY_SESSION}" } });
    else if (message.method === "session/prompt") {
      if (message.params.prompt[0]?.text === "go") for (const frame of frames) out(frame);
      setTimeout(() => out({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), 300);
    } else out({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

/** The signs of life of one turn, from its start to its end. */
export async function untilTurnEnds(stream: AsyncIterable<LifeEvent>, turn: number): Promise<LifeEvent[]> {
  const events: LifeEvent[] = [];
  let started = false;
  for await (const event of stream) {
    if (event.kind === "turn-started" && event.turn === turn) started = true;
    if (started) events.push(event);
    if (event.kind === "turn-ended" && event.turn === turn) break;
  }
  return events;
}

/** What the signs of life say: `detail` of an activity, `unknown:<variant>` of an unknown. */
export function signsOf(events: readonly LifeEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.kind) {
      case "activity":
        return [event.detail ?? ""];
      case "unknown-variant":
        return [`unknown:${event.variant}`];
      case "turn-started":
      case "turn-ended":
      case "model":
      case "advisor":
        return [];
    }
  });
}

/** A `session/update` notification of the replay session. */
export function update(body: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: REPLAY_SESSION, update: body } };
}
