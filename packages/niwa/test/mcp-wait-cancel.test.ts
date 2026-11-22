// An ordinary MCP tools/call — one that carries no operation id of its own, as the tools of a
// session never do — is stopped on the host when the caller cancels it: the host lets go of the
// waiter the wait holds at once, well before the poll would look again, while another caller
// waiting on the same turn is left alone. The turn settles when it settles, and the same handle
// is waited for again over the same session.
//
// The host runs in this process, on its real socket, so the wire is the production one; the MCP
// server is the production one too, with its regular core client over that wire, and the second
// caller holds a wire connection of its own. The host being in this process is what lets the test
// count the waiters it holds: every waiting call holds one between the polls of its wait.

import { expect, test } from "bun:test";

import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  Harness,
  LifeEvent,
  SessionControl,
  SessionId,
  SessionState,
} from "@niwa-labs/harness";
import { sessions, sessionTurnWait } from "@niwa-labs/sessions";
import { connectAsOwner, openBoxes, tempHome } from "@niwa-labs/testing";

import { jsonOf, mcpPair } from "./fixtures/mcp-pair.ts";

/** The harness whose turns move only when the test says so. */
const HELD = "held-harness";

/** The control side of the held harness: a first turn that starts, and signs of life on demand. */
class HeldControl implements SessionControl {
  private readonly queued: LifeEvent[] = [];
  private readonly waking: Array<() => void> = [];
  private turn = 0;

  /** Give the host one sign of life. */
  tell(event: LifeEvent): void {
    this.queued.push(event);
    for (const wake of this.waking.splice(0)) wake();
  }

  async start(options: { prompt: { sections: Array<{ text: string }> } }): Promise<{ session: SessionId; first?: DeliveryReceipt }> {
    const text = options.prompt.sections.map((section) => section.text).join("\n\n").trim();
    if (text === "") return { session: sessionId(harnessId(HELD), "session-1") };
    this.turn = 1;
    return { session: sessionId(harnessId(HELD), "session-1"), first: { status: "started", turn: 1 } };
  }

  async resume(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async send(_id: SessionId, _message: string): Promise<DeliveryReceipt> {
    this.turn += 1;
    return { status: "queued", turn: this.turn };
  }

  async ask<T>(id: SessionId, options: AskOptions<T>): Promise<AskAnswer<T>> {
    return { session: id, value: options.schema.parse({ answer: "legacy" }) as T, at: 0 as never };
  }

  async *life(): AsyncIterable<LifeEvent> {
    for (;;) {
      const event = this.queued.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => this.waking.push(resolve));
    }
  }

  async state(): Promise<SessionState> {
    return "idle";
  }
}

/** The installation the held control side serves. */
const installation: Harness = {
  id: harnessId(HELD),
  kind: harnessKind("fake-kind"),
  machine: machineId("machine-1"),
  home: "/tmp/fake-home",
  sides: {
    control: {
      start: true,
      resume: true,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: true,
      launch: { model: false, effort: [], modes: [] },
    },
  },
};

/** The waiters the host holds between the polls of the waits: one per waiting call. */
function waitersOf(host: Host): number {
  return (host as unknown as { commitWaiters: Set<unknown> }).commitWaiters.size;
}

/** Wait until the host holds this many waiters, saying what it holds instead when it never does. */
async function waitersBecome(host: Host, count: number, what: string, ms: number): Promise<number> {
  const end = Date.now() + ms;
  while (waitersOf(host) !== count) {
    if (Date.now() > end) {
      throw new Error(`the host holds ${String(waitersOf(host))} waiters instead of ${String(count)}: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - (end - ms);
}

test("a cancelled MCP wait with no operation is let go by the host, and the handle waits again", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  const held = new HeldControl();
  host.use(sessions({ sandbox: openBoxes(), harnesses: [{ instance: installation, control: held }] }));
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;
  let observer: NiwaApi | undefined;
  try {
    await host.serve();
    pair = await mcpPair(home.path);
    const mcp = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = await pair!.client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return jsonOf(result) as Record<string, unknown>;
    };

    // The turn both callers wait on: started, settled by nobody yet.
    const started = await mcp("session_start", { harness: HELD, prompt: "hold the line", operation: "held-start" });
    const handle = started.handle as { session: string; operation: string; turn?: number };
    await waitersBecome(host, 0, "the start settled before anybody waits", 5_000);

    // A caller of its own, on a second wire connection, waiting on the same handle with no
    // cancellation to its name.
    observer = await connectAsOwner(home.path, "independent-watcher");
    let observed: unknown;
    let failed: unknown;
    const independent = observer.call(sessionTurnWait, { ...handle, timeoutMs: 9000 });
    void independent.then(
      (value) => {
        observed = value;
      },
      (error) => {
        failed = error;
      },
    );

    // The ordinary MCP group wait: a tools/call with no operation id of its own, far from its
    // deadline and with nothing settling, so only the host letting go of its waiter can end it.
    const controller = new AbortController();
    const cancelled = pair.client.callTool(
      { name: "session_turn_wait_many", arguments: { handles: [handle], until: "all", timeoutMs: 9000 } },
      undefined,
      { signal: controller.signal },
    );
    await waitersBecome(host, 2, "both waits are registered", 5_000);

    // The caller gives up: the host lets go of its waiter at once, well before the next poll, and
    // the caller that never asked to cancel is not disturbed.
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    const took = await waitersBecome(host, 1, "the cancelled wait released its host waiter", 1_000);
    expect(took).toBeLessThan(1_000);
    expect(observed).toBeUndefined();
    expect(failed).toBeUndefined();

    // The turn settles: the independent caller is answered, and no waiter is left.
    held.tell({ kind: "turn-started", turn: 1 });
    held.tell({ kind: "turn-ended", turn: 1, outcome: "completed", answer: "held answer" });
    expect(await independent).toEqual({ status: "completed", value: "held answer" });
    await waitersBecome(host, 0, "the independent wait was answered", 5_000);

    // The handle is still a handle: the same open MCP session waits on it again, with nothing left
    // to wait for, and is answered at once.
    expect(await mcp("session_turn_wait", { ...handle, timeoutMs: 0 })).toEqual({ status: "completed", value: "held answer" });
  } finally {
    await pair?.close();
    await observer?.close();
    await host.close();
    await home.cleanup();
  }
}, 30_000);
