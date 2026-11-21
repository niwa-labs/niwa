/**
 * The live proof of the Codex control side.
 *
 * This test runs the real `codex` CLI against the cheapest model it offers and proves the
 * things the control contract asks for:
 *
 *  1. a session starts, and Codex names it — the native session id is Codex's own thread id,
 *     not niwa's;
 *  2. the turn ends: the `turn-ended` sign of life arrives with Codex's own turn;
 *  3. a message into an idle session starts a turn, and the signs of life report it;
 *  4. a question asked with a schema comes back as a value that passed that schema.
 *
 * The test runs only with `NIWA_LIVE=1` and the `codex` binary on PATH.
 */

import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { promptFromText } from "@niwa-labs/harness";
import type { LifeEvent, SessionId } from "@niwa-labs/harness";

import { codexControl, type CodexSessionControl } from "../src/control.ts";
import { tempDir, live } from "@niwa-labs/testing";

/**
 * The cheapest model Codex offers.
 *
 * `codex debug models` lists it as "fast and affordable model for easier tasks".
 */
const MODEL = "gpt-6-luna";

/** How long the whole proof may take. */
const PROOF_TIMEOUT_MS = 300_000;

/** How long a turn may take before the proof gives up on it. */
const TURN_TIMEOUT_MS = 180_000;

/** Collect the signs of life of a session, without blocking the test on them. */
function watchLife(
  control: CodexSessionControl,
  id: SessionId,
): { events: LifeEvent[]; stop: () => void } {
  const events: LifeEvent[] = [];
  const iterator = control.life(id)[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      events.push(next.value);
    }
  })();
  return { events, stop: () => void iterator.return?.() };
}

/** Whether a sign of life is the given turn sign of the given turn. */
function ofTurn(
  event: LifeEvent,
  kind: "turn-started" | "turn-ended",
  turn: number | undefined,
): event is Extract<LifeEvent, { kind: "turn-started" | "turn-ended" }> {
  return event.kind === kind && event.turn === turn;
}

/** Wait until the session is idle again: the turn ran and ended. */
async function waitForIdle(control: CodexSessionControl, id: SessionId): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while ((await control.state(id)) === "running") {
    if (Date.now() > deadline) throw new Error("the turn did not end in time");
    await Bun.sleep(100);
  }
}

test.skipIf(!(live && Bun.which("codex")))(
  "the Codex control side starts, resumes and answers by schema",
  async () => {
    const dir = await tempDir("codex-proof");
    const control = codexControl({
      harness: "codex-proof",
      model: MODEL,
    });

    try {
      // 1. A session starts in a temp dir, and Codex names it.
      const { session: id } = await control.start({
        prompt: promptFromText("reply with the word ok"),
        cwd: dir,
      });

      expect(typeof id.native).toBe("string");
      expect(id.native.length).toBeGreaterThan(0);

      // The native id is Codex's own thread id: a UUID it chose, not one niwa minted.
      expect(id.native).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(String(id.harness)).toBe("codex-proof");

      // 2. The turn ends: the sign of life says so.
      //
      // The watcher starts after the first turn, because the session only exists once Codex
      // has named it, and naming it takes the first turn.
      const watched = watchLife(control, id);
      await waitForIdle(control, id);
      expect(await control.state(id)).toBe("idle");

      // 3. A message into an idle session begins a turn of its own.
      const receipt = await control.send(id, "reply with the word two");
      expect(receipt.status).toBe("started");
      expect(receipt.turn).toBeGreaterThan(0);

      // The signs of life of that turn: it started, and it ended.
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      // The first watcher is also given the signs of the first turn, so pick by this receipt.
      while (
        !watched.events.some((event) => ofTurn(event, "turn-ended", receipt.turn))
      ) {
        if (Date.now() > deadline) throw new Error("the turn did not end in time");
        await Bun.sleep(100);
      }
      const started = watched.events.find((event) => ofTurn(event, "turn-started", receipt.turn));
      expect(started?.kind).toBe("turn-started");
      expect(started && "turn" in started ? started.turn : undefined).toBe(receipt.turn);

      const ended = watched.events.find((event) => ofTurn(event, "turn-ended", receipt.turn));
      expect(ended?.kind).toBe("turn-ended");
      expect(ended && "turn" in ended ? ended.turn : undefined).toBe(receipt.turn);

      await waitForIdle(control, id);
      expect(await control.state(id)).toBe("idle");

      // 4. The session resumes: the same thread, the same native id.
      const resumed = await control.resume(id, {
        prompt: promptFromText("reply with the word three"),
      });
      expect(resumed).toBeUndefined();
      await waitForIdle(control, id);
      expect(await control.state(id)).toBe("idle");

      // The resumed session is the same session: the id did not change.
      const afterResume = await control.send(id, "reply with the word four");
      expect(afterResume.status).toBe("started");

      await waitForIdle(control, id);
      expect(await control.state(id)).toBe("idle");

      // 5. A question with a schema comes back as a value that passed the schema.
      const Answer = z.object({ answer: z.string() });
      const answer = await control.ask(id, {
        schema: Answer,
        prompt: promptFromText("reply with the word ok"),
      });

      expect(answer.session).toEqual(id);
      expect(answer.value.answer).toBe("ok");
      expect(answer.at).toBeGreaterThan(0);

      // The schema is the gate: a value that does not pass it is not an answer.
      expect(() => z.object({ answer: z.number() }).parse(answer.value)).toThrow();

      watched.stop();
    } finally {
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  PROOF_TIMEOUT_MS,
);

test.skipIf(!(live && Bun.which("codex")))(
  "a schema given as JSON, with an optional property, is answered by real Codex in OpenAI's strict mode",
  async () => {
    const control = codexControl({ harness: "codex-proof", model: MODEL, turnTimeoutMs: 120_000 });
    try {
      const { session: id } = await control.start({ prompt: promptFromText(""), cwd: tmpdir() });
      const schema = z.fromJSONSchema({
        type: "object",
        properties: {
          answer: { type: "integer" },
          note: { type: "string" },
          inner: { type: "object", properties: { n: { type: "integer" } } },
        },
        required: ["answer"],
      });
      const answer = await control.ask(id, { schema, prompt: promptFromText("What is 21+21? Put it in answer.") });
      expect((answer.value as { answer: number }).answer).toBe(42);
    } finally {
      await control.dispose();
    }
  },
  PROOF_TIMEOUT_MS,
);

test.skipIf(!(live && Bun.which("codex")))(
  "schemas strict mode cannot take as written are still answered by real Codex: formats, maps, tuples, roots that are not objects",
  async () => {
    const control = codexControl({ harness: "codex-proof", model: MODEL, turnTimeoutMs: 120_000 });
    const forms: Array<[z.ZodType, string, unknown]> = [
      [z.object({ site: z.url() }), "Give site https://example.com", { site: "https://example.com" }],
      [z.object({ scores: z.record(z.string(), z.number()) }), "Give scores with a=1 and b=2", { scores: { a: 1, b: 2 } }],
      [z.object({ pair: z.tuple([z.string(), z.number()]) }), 'Give pair ["x", 1]', { pair: ["x", 1] }],
      [z.array(z.number()), "Give the list 1, 2, 3", [1, 2, 3]],
    ];
    try {
      const { session: id } = await control.start({ prompt: promptFromText(""), cwd: tmpdir() });
      for (const [schema, question, expected] of forms) {
        const answer = await control.ask(id, { schema, prompt: promptFromText(question) });
        expect(answer.value).toEqual(expected);
      }
    } finally {
      await control.dispose();
    }
  },
  PROOF_TIMEOUT_MS,
);
