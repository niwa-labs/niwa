// The evaluation helpers in a real script: a blind set hides the names behind labels it can reveal;
// a grade is made only by graders independent of the candidate; a suite picks the best variant;
// a transcript check finds what a session opened, and refuses to answer for an unreadable one.

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createNiwa, historyRead, plugin, requests, stubAction, tempHome, timers, workflow } from "@niwa-labs/testing";

import { bestOf, itemPasses } from "../src/index.ts";

type Reply = (call: { prompt: string }) => unknown;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 30_000);

const PACKAGES = join(import.meta.dir, "..", "..");

/** Run a script that imports the evaluation helpers, with stub agents and a stub `history.read`, and answer its result. */
async function run(source: string, agents: Record<string, Reply>, transcript: unknown = { records: [], coverage: { status: "complete" } }): Promise<{ result: unknown; prompts: Record<string, string[]> }> {
  const temp = await tempHome();
  const home = realpathSync(temp.path);
  const prompts: Record<string, string[]> = {};
  const actions = Object.entries(agents).map(([harness, reply]) => {
    const seen: string[] = [];
    prompts[harness] = seen;
    return [
      harness,
      stubAction(`session.start.${harness}`, {
        home,
        input: z.looseObject({ prompt: z.string() }),
        output: z.any(),
        recovery: "repeat",
        result: (input) => {
          seen.push(input.prompt);
          return reply(input);
        },
      }),
    ] as const;
  });
  // The stub takes what the real action takes: a script that names a session another way fails here as it would there.
  const history = stubAction("history.read", { home, input: historyRead.input, output: z.any(), recovery: "repeat", effect: "read", result: () => transcript });
  const host = createNiwa({ home });
  host.use(
    requests(),
    timers([]),
    plugin("stubs", (api) => {
      for (const [, one] of actions) api.action(one);
      api.action(history);
    }),
    workflow({ agents: Object.fromEntries(actions) }),
  );
  await host.serve();
  cleanups.push(async () => {
    await host.close().catch(() => {});
    await temp.cleanup();
  });
  const src = join(home, "src");
  await mkdir(join(src, "node_modules", "@niwa-labs"), { recursive: true });
  for (const name of ["flow", "flow-eval"]) await symlink(realpathSync(join(PACKAGES, name)), join(src, "node_modules", "@niwa-labs", name), "dir");
  await writeFile(join(src, "eval.ts"), source);
  const ended = (await host.call("workflow.start" as never, { file: join(src, "eval.ts"), wait: true, timeoutMs: 30_000 } as never)) as { state: string; outcome?: { status: string; result?: unknown } };
  if (ended.outcome?.status !== "done") throw new Error(`the run did not finish: ${JSON.stringify(ended).slice(0, 1500)}`);
  return { result: ended.outcome.result, prompts };
}

test("a blind set labels every candidate and reveals the name behind each label", async () => {
  const { result } = await run(
    `
    import { blindSet } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const set = await blindSet("blind", { alpha: "a", beta: "b", gamma: "g" });
      return Object.keys(set.labeled).map((label) => ({ label, value: set.labeled[label], name: set.reveal(label) }));
    });`,
    {},
  );
  const rows = result as Array<{ label: string; value: string; name: string }>;
  expect(rows.map((row) => row.label)).toEqual(["A", "B", "C"]);
  expect(rows.map((row) => row.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  for (const row of rows) expect(row.value).toBe(row.name[0]);
}, 30_000);

test("a grade is made only by graders of another vendor, and passes an item by the rule", async () => {
  const { result, prompts } = await run(
    `
    import { gradeCase } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const rubric = [{ id: "correct", text: "the answer is right" }, { id: "short", text: "the answer is short" }];
      const graded = await gradeCase("grade", {
        subject: "42",
        rubric,
        graders: [{ harness: "own", vendor: "acme" }, { harness: "g1", vendor: "v1" }, { harness: "g2", vendor: "v2" }, { harness: "g3", vendor: "v3" }],
        candidateVendor: "acme",
      });
      const alone = await gradeCase("alone", { subject: "42", rubric, graders: [{ harness: "own", vendor: "acme" }], candidateVendor: "acme" });
      return { verdict: graded.verdict, scores: graded.scores, legs: graded.legs.length, alone: alone.verdict };
    });`,
    {
      own: () => ({ scores: { correct: 1, short: 1 } }),
      g1: () => ({ scores: { correct: 1, short: 0 } }),
      g2: () => ({ scores: { correct: 1, short: 1 } }),
      g3: () => ({ scores: { correct: 0.5, short: 0 } }),
    },
  );
  expect(result).toEqual({ verdict: "FAIL", scores: { correct: 2.5 / 3, short: 1 / 3 }, legs: 3, alone: "INCONCLUSIVE" });
  expect(prompts.own).toHaveLength(0);
}, 30_000);

test("a suite runs every case on every variant and recommends the best variant", async () => {
  const { result } = await run(
    `
    import { evalSuite } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      evalSuite("suite", {
        cases: [{ id: "c1", prompt: "one" }, { id: "c2", prompt: "two" }],
        variants: { terse: "terse", wordy: "wordy" },
        run: async (variant, c, dir) => variant + ":" + c.prompt + "@" + dir,
        rubric: [{ id: "good", text: "it is good" }],
        graders: ["grader"],
      }));`,
    { grader: (call) => ({ scores: { good: call.prompt.includes("terse:two") ? 0.1 : call.prompt.includes("terse") ? 1 : 0.6 } }) },
  );
  expect(result).toEqual({ table: { terse: { c1: 1, c2: 0.1 }, wordy: { c1: 0.6, c2: 0.6 } }, perCase: { c1: "terse", c2: "wordy" }, recommend: "wordy" });
}, 30_000);

test("a transcript check finds what the session opened, in the order it met them", async () => {
  const records = [
    { kind: "user", text: "fix it" },
    { kind: "tool", name: "read", input: { path: "src/b.ts" } },
    { kind: "tool", name: "read", input: { path: "src/a.ts" } },
  ];
  const { result } = await run(
    `
    import { chainFromTranscript } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => chainFromTranscript("chain", { harness: "claude", native: "s-1" }, { opened: ["src/a.ts", "src/b.ts", "docs/plan.md"] }));`,
    {},
    { records, coverage: { status: "complete" } },
  );
  expect(result).toEqual({ opened: ["src/b.ts", "src/a.ts"], missing: ["docs/plan.md"] });
}, 30_000);

test("an item passes on more than half of the graders, or all of them; a tie at the top has no best", () => {
  expect(itemPasses([1, 0.6, 0], "majority")).toBe(true);
  expect(itemPasses([1, 0], "majority")).toBe(false);
  expect(itemPasses([1, 0.6, 0], "unanimous")).toBe(false);
  expect(itemPasses([], "majority")).toBe(false);
  expect(bestOf({ a: 1, b: 2 })).toBe("b");
  expect(bestOf({ a: 2, b: 2 })).toBeNull();
});

test("a transcript that could not be read is an error, not a session that opened nothing", async () => {
  const { result } = await run(
    `
    import { chainFromTranscript } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      try {
        return await chainFromTranscript("chain", { harness: "claude", native: "s-1" }, { opened: ["src/a.ts"] });
      } catch (error) {
        return (error as Error).message;
      }
    });`,
    {},
    { records: [], coverage: { status: "unavailable", reason: "no reading side" } },
  );
  expect(result).toBe("the session claude:s-1 could not be read (unavailable): no reading side");
}, 30_000);
