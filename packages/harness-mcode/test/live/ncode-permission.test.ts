// Live: the `ncode` kind (the owner's fork of MiniMax Code) takes the permission mode per session.
//
// A session started in mode `auto` runs `echo $NIWA_ID` in its shell, and what it answers is the
// id the session was started with. niwa refuses every permission request the fork sends
// (`permissions: "deny"`), so the command runs only when the mode itself lets it through. A
// resume in a new process (session/load) names the mode again and succeeds; the fork would open
// the session in `default` otherwise. The permission marks of the fork, when its build puts them
// on tool calls, must all name `auto`.
//
// The prompt that follows a cold resume is not asserted: the installed build (0.7.2) ends it
// at once with no answer, for the `mcode` kind too and with no `_meta` on the load, so it says
// nothing about the mode.
//
// Both sides run in the working directory of this process: a resume in a new process has no
// directory of its own and loads the session where the process stands.
//
// The test is skipped unless NIWA_LIVE=1 and the "mcode" launcher is on the PATH. If the fork's
// auth needs another region, run it with `MAVIS_REGION=en`: the test passes the variable on from
// its own environment and sets none.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { promptFromText, type SessionControl } from "@niwa-labs/harness";
import { ncode } from "../../src/ncode/index.ts";
import { live } from "@niwa-labs/testing";

let control: SessionControl | undefined;

afterEach(async () => {
  await control?.dispose?.();
  control = undefined;
});

/** The environment the fork's own auth needs: the region, when the caller's environment names one. */
const region: Record<string, string> = {};
if (process.env["MAVIS_REGION"] !== undefined) region["MAVIS_REGION"] = process.env["MAVIS_REGION"];

/** The control side of a fresh instance of the kind. */
function controlOfKind(): SessionControl {
  const side = ncode({ control: { turnTimeoutMs: 180_000, permissions: "deny" } }).control;
  if (side === undefined) throw new Error("the ncode kind has no control side");
  return side;
}

test.skipIf(!(live && Bun.which("mcode")))(
  "ncode in mode auto answers the NIWA_ID of its session, and a resume in a new process takes the mode again",
  async () => {
    const first = controlOfKind();
    control = first;
    const niwaId = "niwa-live-session-id";
    const { session: id } = await first.start({
      prompt: promptFromText(""),
      mode: "auto",
      env: { NIWA_ID: niwaId, ...region },
    });

    const marks: Array<string | undefined> = [];
    const watcher = (async () => {
      for await (const event of first.life(id)) {
        if (event.kind === "activity" && event.permission !== undefined) marks.push(event.permission.mode);
      }
    })().catch(() => undefined);
    const reply = await first.ask(id, {
      schema: z.object({ id: z.string() }),
      prompt: promptFromText(
        'Run `echo $NIWA_ID` in your shell. Answer with the exact output of that command, nothing else, in the field "id".',
      ),
    });
    expect(reply.value.id.trim()).toBe(niwaId);
    await first.dispose?.();
    await watcher;
    expect(marks.every((mark) => mark === "auto")).toBe(true);

    // A new process loads the session and names the mode again.
    const second = controlOfKind();
    control = second;
    await second.resume(id, { mode: "auto", env: { NIWA_ID: niwaId, ...region } });
    expect(await second.state(id)).toBe("idle");
  },
  300_000,
);
