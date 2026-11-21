/**
 * Client helpers of the checks: they speak to a running host through the client of the core, as
 * the owner or as anyone, and read what the host did.
 */

import { z } from "zod";

import { actionName, seq } from "@niwa-labs/core";
import type { StoredRecord, Token } from "@niwa-labs/core";
import { connect, readOwnerToken } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";

/** The type the core writes for every change of an invocation's state. */
export const STATE_TYPE = "niwa.invocation.state";

/** The data of a state record. */
const InvocationState = z.object({
  invocation: z.string(),
  state: z.string(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
  key: z.string().optional(),
});

export type InvocationStateData = z.infer<typeof InvocationState>;

/** Read the journal from the beginning through a client subscription, into `seen`, as the owner does. */
export async function watch(home: string): Promise<{ seen: StoredRecord[]; stop: () => Promise<void> }> {
  const observer = await connectAsOwner(home, "watcher");
  const seen: StoredRecord[] = [];
  const subscription = (async () => {
    for await (const record of observer.records.since()) seen.push(record);
  })().catch(() => {});
  return {
    seen,
    stop: async () => {
      await observer.close();
      await subscription;
    },
  };
}

/** The invocation the journal talks about: the first one that was admitted ("" before that). */
export function invocationOf(seen: StoredRecord[]): string {
  const admitted = seen.find((record) => record.type === "niwa.invocation.admitted");
  return (admitted?.data as { invocation?: string } | undefined)?.invocation ?? "";
}

/** The last state record of an invocation (the first admitted one by default). */
export function lastState(seen: StoredRecord[], invocation = invocationOf(seen)): InvocationStateData | undefined {
  let last: InvocationStateData | undefined;
  for (const record of seen) {
    if (record.type !== STATE_TYPE) continue;
    const parsed = InvocationState.safeParse(record.data);
    if (parsed.success && parsed.data.invocation === invocation) last = parsed.data;
  }
  return last;
}

/** The token of the owner of a home the host serves: the owner's own tools read it the same way. */
export function ownerTokenOf(home: string): Token {
  const token = readOwnerToken(home);
  if (token === undefined) throw new Error(`the host of ${home} has not made the owner's token`);
  return token;
}

/** Connect as the owner: the owner's token, whatever the client calls itself. */
export function connectAsOwner(home: string, id = "owner-test") {
  return connect({ home, id, token: ownerTokenOf(home) });
}

/** Where a run got to, as `workflow.wait` answers. */
const WaitedRun = z.object({
  state: z.enum(["running", "paused", "finished"]),
  reason: z.string().optional(),
  result: z.unknown().optional(),
});
export type WaitedRun = z.infer<typeof WaitedRun>;

/**
 * Wait for a run that must finish: it returns when the run finishes and fails at once when the run
 * pauses, with the reason, instead of waiting out the deadline for a decision nobody gives.
 */
export async function runFinishes(api: NiwaApi, run: string, deadlineMs: number): Promise<WaitedRun> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the run ${run} did not finish within ${String(deadlineMs)} ms`);
    const waited = WaitedRun.parse(await api.call(actionName("workflow.wait"), { run, timeoutMs: Math.min(left, 30_000) }));
    if (waited.state === "paused") throw new Error(`the run ${run} paused: ${waited.reason ?? "no reason given"}`);
    if (waited.state === "finished") return waited;
  }
}
