// A host with the agents module over a harness that serves no process: what the checks of the module share.

import { InputNotSent, harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { AskAnswer, DeliveryReceipt, Harness, LifeEvent, SessionControl, SessionId, SessionReading, SessionRecord, SessionState, StartedSession, StartOptions } from "@niwa-labs/harness";
import { history } from "@niwa-labs/history";
import { messages } from "@niwa-labs/messages";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import type { HarnessBinding } from "@niwa-labs/sessions";
import { tasks } from "@niwa-labs/tasks";
import { createNiwa, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import type { StoredRecord } from "@niwa-labs/core";

import { agents as agentsModule } from "@niwa-labs/agent";
import type { AgentOptions } from "@niwa-labs/agent";

export const HARNESS = "fake-agent-harness";
export const KIND = "fake-agent-kind";

/** Sessions are numbered across every control of a check, so a host started again names new ones apart. */
let numbered = 0;

/** A control side that records what it is asked and names a new session for every start. */
export class ScriptedControl implements SessionControl {
  readonly starts: StartOptions[] = [];
  readonly sends: Array<{ session: string; message: string }> = [];
  readonly resumes: string[] = [];
  /** Whether a resume fails: the session cannot be taken on again. */
  resumable = true;
  /** How many sends to refuse as never sent: the process is gone. */
  lostSends = 0;

  async start(options: StartOptions): Promise<StartedSession> {
    this.starts.push(options);
    numbered += 1;
    return { session: sessionId(harnessId(HARNESS), `native-${String(numbered)}`), first: { status: "started", turn: 1 } };
  }
  async resume(id: SessionId): Promise<void> {
    if (!this.resumable) throw new Error("the session is gone");
    this.resumes.push(id.native);
  }
  async send(id: SessionId, message: string): Promise<DeliveryReceipt> {
    if (this.lostSends > 0) {
      this.lostSends -= 1;
      throw new InputNotSent(id.harness, "send", "the process is gone");
    }
    this.sends.push({ session: id.native, message });
    return { status: "queued" };
  }
  async interrupt(): Promise<void> {}
  async ask<T>(): Promise<AskAnswer<T>> {
    throw new Error("not asked");
  }
  /** A session's signs of life end only with the session: these sessions never end by themselves. */
  async *life(): AsyncIterable<LifeEvent> {
    await new Promise<void>(() => {});
  }
  async state(): Promise<SessionState> {
    return "idle";
  }
  /** The text of the sections of the n-th start. */
  prompt(n: number): string {
    return this.starts[n]?.prompt.sections.map((section) => section.text).join("\n") ?? "";
  }
}

export const installation: Harness = {
  id: harnessId(HARNESS),
  kind: harnessKind(KIND),
  machine: machineId("machine-1"),
  home: "/tmp/fake-agent-home",
  sides: {
    reading: { list: true, read: true, watch: false },
    control: {
      start: true,
      resume: true,
      send: true,
      interrupt: false,
      ask: false,
      structuredOutput: false,
      launch: { model: false, effort: [], modes: [] },
      tools: { niwaOnly: false, allow: false },
    },
  },
};

/** A reading side over transcripts the check grows, by native id. */
export function transcripts(byNative: Map<string, SessionRecord[]>): SessionReading {
  return {
    async *list(query) {
      for (const native of query?.natives ?? [...byNative.keys()]) yield { id: sessionId(harnessId(HARNESS), native), cwd: "/work" };
    },
    async *read(id, from) {
      const records = byNative.get(id.native) ?? [];
      const found = from === undefined ? -1 : records.findIndex((record) => record.locator === from);
      // A position that belongs to another source starts the read over, and the first record says so.
      const restarted = from !== undefined && found === -1;
      for (const [index, record] of records.slice(found + 1).entries()) yield restarted && index === 0 ? ({ ...record, reanchored: true } as SessionRecord) : record;
    },
    raw: async () => undefined,
    rawSchema: { parse: (value: unknown) => value } as never,
    coverage: async () => ({ status: "not-scanned" }),
  };
}

export interface AgentHost {
  readonly host: Host;
  readonly home: string;
  readonly control: ScriptedControl;
  /** The binding the host's modules were given. */
  readonly bind: CallerBinding;
  readonly records: () => Promise<StoredRecord[]>;
  readonly close: () => Promise<void>;
}

/** The data of the records of a type, in order. */
export const dataOf = (records: readonly StoredRecord[], type: string): unknown[] => records.filter((record) => record.type === type).map((record) => record.data);

/** Wait until the journal holds as many records of a type. */
export async function until(read: () => Promise<StoredRecord[]>, type: string, count = 1, ms = 10_000): Promise<StoredRecord[]> {
  for (let waited = 0; waited < ms; waited += 20) {
    const all = await read();
    if (all.filter((record) => record.type === type).length >= count) return all;
    await Bun.sleep(20);
  }
  throw new Error(`fewer than ${String(count)} ${type} were written`);
}

/**
 * A host with messages, requests, tasks, sessions over the scripted control, history over the
 * transcripts, the agents module and what else a check adds after it; the sessions an agent starts
 * speak as the agent.
 */
export async function agentHost(
  options: AgentOptions,
  more: {
    home?: string;
    control?: ScriptedControl;
    transcripts?: Map<string, SessionRecord[]>;
    /** More installations for the sessions module. */
    harnesses?: HarnessBinding[];
    after?: Plugin[];
    timing?: { pollMs: number; pauseMs: number; endMs: number };
  } = {},
): Promise<AgentHost> {
  const fresh = more.home === undefined ? await tempHome() : undefined;
  const home = more.home ?? fresh!.path;
  const control = more.control ?? new ScriptedControl();
  const reading = transcripts(more.transcripts ?? new Map());
  const made = sessions({ harnesses: [{ instance: installation, control, reading }, ...(more.harnesses ?? [])], niwaMcp: { command: "true", args: [] } });
  const agents = agentsModule({ digests: false, ...options });
  const bind = agents.bind(made.bind());
  const host = createNiwa({ home });
  host.use(
    messages({ bind }),
    requests({ bind }),
    tasks({ messages: { bind } }),
    history({ harnesses: [{ instance: installation, reading }], timing: more.timing ?? { pollMs: 10, pauseMs: 60_000, endMs: 120_000 } }),
    made,
    agents,
    ...(more.after ?? []),
  );
  await host.serve();
  let closed = false;
  return {
    host,
    home,
    control,
    bind,
    records: () => host.records.read(),
    close: async () => {
      if (closed) return;
      closed = true;
      await host.close();
      await fresh?.cleanup();
    },
  };
}
