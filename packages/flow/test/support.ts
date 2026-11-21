// What the flow tests share: a host with the workflow module and stub agents, and a way to run a
// script that imports the helpers as a package, the way an owner's script does.

import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createNiwa, connect, eventually, ownerTokenOf, plugin, requests, stubAction, tempHome, timers, workflow } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";

/** What an agent call reaches a stub with. */
export interface AgentCall {
  prompt: string;
  harness?: string;
}

/** A stub agent: its answer to a call. Throwing fails the call. */
export type Reply = (call: AgentCall) => unknown;

/** What a run ended as. */
export interface Ended {
  run: string;
  state: string;
  outcome?: { status: string; result?: unknown; error?: string; name?: string };
  requests: unknown[];
}

export interface FlowHost {
  host: Host;
  home: string;
  /** The calls each stub agent got, by harness. */
  calls: Record<string, AgentCall[]>;
  /** Run a script once and wait for it to end; `packages` are linked beside it by name. */
  run(source: string, args?: unknown): Promise<Ended>;
  /** Start a script once and answer with its run, without waiting. */
  start(source: string, args?: unknown): Promise<string>;
  wait(run: string): Promise<Ended>;
  /** Answer the owner's open question (the first one) with an option id. */
  answer(id: string): Promise<void>;
  /** Cancel the owner's open question. */
  cancelAsk(): Promise<void>;
  close(): Promise<void>;
}

const PACKAGES = join(import.meta.dir, "..", "..");

/** A plugin a test adds to the host. */
export type Extra = Parameters<Host["use"]>[number];

/** What a test host has besides the stub agents: the packages a script finds by name, and more plugins. */
export interface FlowHostOptions {
  /** The clock of the host, when the test moves it by hand. */
  clock?: TestClock;
  packages?: readonly string[];
  plugins?: (home: string) => Extra[];
}

/** A host with the workflow module and an agent per harness of `agents`. */
export async function flowHost(agents: Record<string, Reply>, opts: FlowHostOptions = {}): Promise<FlowHost> {
  const packages = opts.packages ?? ["flow"];
  const temp = await tempHome();
  const home = realpathSync(temp.path);
  const calls: Record<string, AgentCall[]> = {};
  const actions = Object.entries(agents).map(([harness, reply]) => {
    calls[harness] = [];
    const seen = calls[harness] as AgentCall[];
    return [
      harness,
      stubAction(`session.start.${harness}`, {
        home,
        input: z.looseObject({ prompt: z.string(), harness: z.string().optional() }),
        output: z.any(),
        recovery: "repeat",
        result: (input) => {
          const call = { prompt: input.prompt, ...(input.harness === undefined ? {} : { harness: input.harness }) };
          seen.push(call);
          return reply(call);
        },
      }),
    ] as const;
  });
  const host = createNiwa({ home, ...(opts.clock === undefined ? {} : { clock: opts.clock }) });
  host.use(
    requests(),
    timers([]),
    plugin("stub-agents", (api) => {
      for (const [, one] of actions) api.action(one);
    }),
    workflow({ agents: Object.fromEntries(actions) }),
    ...(opts.plugins?.(home) ?? []),
  );
  await host.serve();

  const src = join(home, "src");
  await mkdir(join(src, "node_modules", "@niwa-labs"), { recursive: true });
  for (const name of packages) await symlink(realpathSync(join(PACKAGES, name)), join(src, "node_modules", "@niwa-labs", name), "dir");
  let scripts = 0;
  const owner = await connect({ home, id: "owner:flow", token: ownerTokenOf(home) });

  const start = async (source: string, args?: unknown): Promise<string> => {
    scripts += 1;
    const file = join(src, `script-${String(scripts)}.ts`);
    await writeFile(file, source);
    const started = (await host.call("workflow.start" as never, { file, ...(args === undefined ? {} : { args }) } as never)) as { run: string };
    return started.run;
  };
  const wait = async (run: string): Promise<Ended> => (await host.call("workflow.wait" as never, { run, timeoutMs: 30_000 } as never)) as Ended;
  const openId = async (): Promise<string> => {
    let id: string | undefined;
    await eventually(async () => {
      const open = (await owner.call("request.open" as never, {} as never)) as { requests?: Array<{ id: string }>; items?: Array<{ id: string }> };
      id = (open.requests ?? open.items ?? [])[0]?.id;
      return id !== undefined;
    }, 15_000, "the owner should be asked");
    return id as string;
  };
  return {
    host,
    home,
    calls,
    start,
    wait,
    run: async (source, args) => wait(await start(source, args)),
    answer: async (choice) => {
      const id = await openId();
      await owner.call("request.answer" as never, { id, answer: { ids: [choice] } } as never);
    },
    cancelAsk: async () => {
      const id = await openId();
      await owner.call("request.cancel" as never, { id } as never);
    },
    close: async () => {
      await owner.close?.();
      await host.close().catch(() => {});
      await temp.cleanup();
    },
  };
}

/** The result of a run that finished, or a failure that says how it ended. */
export function resultOf(ended: Ended): unknown {
  if (ended.state !== "finished" || ended.outcome?.status !== "done") throw new Error(`the run did not finish: ${JSON.stringify(ended).slice(0, 2000)}`);
  return ended.outcome.result;
}
