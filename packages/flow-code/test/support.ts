// What the flow-code tests share: a real git repository, a host with the git module, a proc.run
// that runs the command where it is asked to, stub agents that work in the directory they are
// started in, and a way to run a script that imports the helpers by name.

import { realpathSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { procRun } from "@niwa-labs/proc/records";
import { connect, createNiwa, eventually, git, ownerTokenOf, plugin, requests, stubAction, tempDir, tempHome, timers, workflow } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "niwa test";
process.env.GIT_AUTHOR_EMAIL = "test@niwa.invalid";
process.env.GIT_COMMITTER_NAME = "niwa test";
process.env.GIT_COMMITTER_EMAIL = "test@niwa.invalid";

/** Run git in a directory; its output, trimmed. */
export function gitIn(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository on `main` with one commit. */
export async function makeRepo(): Promise<string> {
  const repo = realpathSync(await tempDir("flow-repo"));
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "a repository\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "start");
  return repo;
}

/** Write a file in a checkout and commit it: the new commit. */
export function commitFile(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  gitIn(dir, "add", file);
  gitIn(dir, "commit", "-q", "-m", `add ${file}`);
  return gitIn(dir, "rev-parse", "HEAD");
}

/** What an agent call reaches a stub with. */
export interface AgentCall {
  prompt: string;
  harness?: string;
  cwd?: string;
}

export type Reply = (call: AgentCall) => unknown;

export interface CodeHost {
  host: Host;
  home: string;
  repo: string;
  calls: Record<string, AgentCall[]>;
  /** Run a script once and answer how it ended. */
  run(source: string, args?: unknown): Promise<{ state: string; outcome?: { status: string; result?: unknown }; reason?: string }>;
  start(source: string, args?: unknown): Promise<string>;
  /** Answer the owner's open question with an option id. */
  answer(id: string): Promise<void>;
  close(): Promise<void>;
}

const PACKAGES = join(import.meta.dir, "..", "..");

/** `proc.run` as a test needs it: the command runs in its cwd, with no box, on the input the real action takes. */
function fakeProc(home: string) {
  return plugin("fake-proc", (api) =>
    api.action(
      stubAction("proc.run", {
        home,
        // Held to the input of the real action: a helper that calls it another way fails here as it would there.
        input: procRun.input,
        output: z.any(),
        recovery: "repeat",
        result: ({ cmd, cwd }) => {
          const ran = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
          const tail = (ran.stdout.toString() + ran.stderr.toString()).slice(-4096);
          return {
            outcome: "exited",
            exit: ran.exitCode,
            durationMs: 1,
            tail,
            truncated: false,
            output: { digest: `sha256:${"0".repeat(64)}`, size: tail.length, type: "text/plain" },
            box: { sandbox: "none", write: [cwd], net: [] },
          };
        },
      }),
    ),
  );
}

/** A host with git, a proc.run, the workflow module and an agent per harness of `agents`. */
export async function codeHost(agents: Record<string, Reply>, packages: readonly string[] = ["flow", "flow-code"]): Promise<CodeHost> {
  const temp = await tempHome();
  const home = realpathSync(temp.path);
  const repo = await makeRepo();
  const calls: Record<string, AgentCall[]> = {};
  const actions = Object.entries(agents).map(([harness, reply]) => {
    calls[harness] = [];
    const seen = calls[harness] as AgentCall[];
    return [
      harness,
      stubAction(`session.start.${harness}`, {
        home,
        input: z.looseObject({ prompt: z.string(), harness: z.string().optional(), cwd: z.string().optional() }),
        output: z.any(),
        recovery: "repeat",
        result: (input) => {
          const call: AgentCall = { prompt: input.prompt, ...(input.harness === undefined ? {} : { harness: input.harness }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) };
          seen.push(call);
          return reply(call);
        },
      }),
    ] as const;
  });
  const host = createNiwa({ home });
  host.use(
    requests(),
    timers([]),
    git({ cleanup: false }),
    fakeProc(home),
    plugin("stub-agents", (api) => {
      for (const [, one] of actions) api.action(one);
    }),
    workflow({ agents: Object.fromEntries(actions) }),
  );
  await host.serve();
  const src = join(home, "src");
  await mkdir(join(src, "node_modules", "@niwa-labs"), { recursive: true });
  for (const name of packages) await symlink(realpathSync(join(PACKAGES, name)), join(src, "node_modules", "@niwa-labs", name), "dir");
  const owner = await connect({ home, id: "owner:flow-code", token: ownerTokenOf(home) });
  let scripts = 0;
  const start = async (source: string, args?: unknown): Promise<string> => {
    scripts += 1;
    const file = join(src, `script-${String(scripts)}.ts`);
    await writeFile(file, source.replaceAll("$REPO", repo));
    return ((await host.call("workflow.start" as never, { file, ...(args === undefined ? {} : { args }) } as never)) as { run: string }).run;
  };
  return {
    host,
    home,
    repo,
    calls,
    start,
    run: async (source, args) => (await host.call("workflow.wait" as never, { run: await start(source, args), timeoutMs: 30_000 } as never)) as never,
    answer: async (choice) => {
      let id: string | undefined;
      await eventually(async () => {
        const open = (await owner.call("request.open" as never, {} as never)) as { requests?: Array<{ id: string }>; items?: Array<{ id: string }> };
        id = (open.requests ?? open.items ?? [])[0]?.id;
        return id !== undefined;
      }, 15_000, "the owner should be asked");
      await owner.call("request.answer" as never, { id, answer: { ids: [choice] } } as never);
    },
    close: async () => {
      await owner.close?.();
      await host.close().catch(() => {});
      await temp.cleanup();
    },
  };
}

/** The result of a run that finished, or a failure that says how it ended. */
export function resultOf(ended: { state: string; outcome?: { status: string; result?: unknown } }): unknown {
  if (ended.state !== "finished" || ended.outcome?.status !== "done") throw new Error(`the run did not finish: ${JSON.stringify(ended).slice(0, 2000)}`);
  return ended.outcome.result;
}
