/**
 * The profile check of a kind: a session of one installation, in a box closed to reading, with
 * nothing but the installation's own profile.
 *
 * The box is nono's: everything it may read or write is named, so a path the profile leaves out is
 * a path the harness cannot reach. The session is given one turn that asks for a word back; the
 * turn has to end, and the word has to be in what the reading side reads from the installation's
 * home, which the harness wrote from inside the box. A kind whose installations pass may declare
 * its profile verified.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admit, boxManifest, nono, requireSandbox, sandbox } from "@niwa-labs/sandbox";
import type { BoxManifest } from "@niwa-labs/sandbox";

import type { HarnessBinding } from "../index.ts";
import { promptFromText } from "../control.ts";
import type { LifeEvent } from "../control.ts";

/** What the check saw. */
export interface ProfileConformanceResult {
  /** The turn ended within the time it was given. */
  readonly ended: boolean;
  /** The word asked for is in the session as the reading side reads it. */
  readonly answered: boolean;
  /** The box the session ran in. */
  readonly box: BoxManifest;
}

export interface ProfileConformanceOptions {
  /** The working directory of the session: read, never written. */
  readonly cwd: string;
  /** How long the turn may take. Default: three minutes. */
  readonly turnMs?: number;
}

const WORD = "PONG";

/** Runs one installation's session in a nono box with only its own profile. */
export async function profileConformance(binding: HarnessBinding, options: ProfileConformanceOptions): Promise<ProfileConformanceResult> {
  const { control, reading, profile, instance } = binding;
  if (control === undefined || reading === undefined) throw new Error(`the installation ${instance.id} needs a control and a reading side to be checked`);
  if (profile === undefined) throw new Error(`the installation ${instance.id} has no profile`);
  const host = sandbox();
  host.install(instance.id, profile);
  // A temp directory of the session's own, as every box has: the shared temp areas are closed.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "niwa-profile-")));
  const plan = host.plan({ cwd: options.cwd, defaults: { allow: [] }, owner: instance.id, writes: [{ path: temp, from: "temp" }], network: true });
  const adapter = await requireSandbox(nono());
  const admitted = admit(plan, adapter, () => undefined);
  const env = { TMPDIR: temp };
  const { session } = await control.start({ prompt: promptFromText(""), cwd: options.cwd, env, box: { sandbox: adapter, spec: admitted.spec } });
  const seen: LifeEvent[] = [];
  const turnMs = options.turnMs ?? 180_000;
  try {
    const watcher = (async () => {
      for await (const event of control.life(session)) {
        seen.push(event);
        if (event.kind === "turn-ended") break;
      }
    })().catch(() => undefined);
    await control.send(session, `Reply with the single word ${WORD} and nothing else.`);
    const deadline = Date.now() + turnMs;
    while (!seen.some((event) => event.kind === "turn-ended") && Date.now() < deadline) await Bun.sleep(100);
    const ended = seen.some((event) => event.kind === "turn-ended");
    if (ended) await watcher;
    let answered = false;
    for (let attempt = 0; attempt < 20 && !answered; attempt += 1) {
      const records: unknown[] = [];
      try {
        for await (const record of reading.read(session)) records.push(record);
      } catch {
        // The log may not be written yet.
      }
      answered = JSON.stringify(records).includes(WORD);
      if (!answered) await Bun.sleep(250);
    }
    return { ended, answered, box: boxManifest(plan, admitted.rules, admitted.manifest) };
  } finally {
    await control.dispose?.();
    rmSync(temp, { recursive: true, force: true });
  }
}
