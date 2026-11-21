// The evaluation helpers in a real script: a blind set hides the names behind labels it can reveal;
// a grade is made only by graders independent of the candidate; a suite picks the best variant;
// a transcript check finds what a session opened, and refuses to answer for an unreadable one.

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createNiwa, historyRead, plugin, requests, stubAction, tempHome, timers, workflow } from "@niwa-labs/testing";

import { bestOf, blindSet, itemPasses } from "../src/index.ts";

type Reply = (call: { prompt: string }) => unknown;

/** The answer of a judge: a score for each item, by its id. */
const sheet = (scores: Record<string, number>) => ({ scores: Object.entries(scores).map(([id, score]) => ({ id, score })) });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 30_000);

const readCall = (callId: string, target: string) => ({ kind: "tool-call", callId, name: "Read", category: "read", target });
const readResult = (callId: string, ok?: boolean) => ({ kind: "tool-result", callId, ...(ok === undefined ? {} : { ok }) });

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
      own: () => sheet({ correct: 1, short: 1 }),
      g1: () => sheet({ correct: 1, short: 0 }),
      g2: () => sheet({ correct: 1, short: 1 }),
      g3: () => sheet({ correct: 0.5, short: 0 }),
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
        vendorOf: () => "acme",
      }));`,
    { grader: (call) => sheet({ good: call.prompt.includes("terse:two") ? 0.1 : call.prompt.includes("terse") ? 1 : 0.6 }) },
  );
  expect(result).toEqual({ table: { terse: { c1: 1, c2: 0.1 }, wordy: { c1: 0.6, c2: 0.6 } }, perCase: { c1: "terse", c2: "wordy" }, recommend: "wordy", failures: [] });
}, 30_000);

test("a transcript check finds what the session opened, in the order it met them", async () => {
  const records = [
    { kind: "user", text: "fix it" },
    readCall("c1", "src/b.ts"),
    readResult("c1"),
    readCall("c2", "src/a.ts"),
    readResult("c2"),
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

/** Run a script that grades with three independent judges by the unanimous or the majority rule, and answer the verdict. */
async function verdictOf(rule: string, replies: Record<string, Reply>): Promise<{ verdict: string; scores: Record<string, number>; legs: number }> {
  const { result } = await run(
    `
    import { gradeCase } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const graded = await gradeCase("grade", {
        subject: "42",
        rubric: [{ id: "correct", text: "right" }, { id: "short", text: "short" }],
        graders: [{ harness: "g1", vendor: "v1" }, { harness: "g2", vendor: "v2" }, { harness: "g3", vendor: "v3" }],
        candidateVendor: "acme",
        rule: "${rule}",
      });
      return { verdict: graded.verdict, scores: graded.scores, legs: graded.legs.length };
    });`,
    replies,
  );
  return result as { verdict: string; scores: Record<string, number>; legs: number };
}

/** A judge whose answer does not fit the schema: its call fails and the grade goes on without it. */
const down: Reply = () => ({ nothing: true });

test("graders that gave no complete answer keep their place in the threshold", async () => {
  // One judge scores both items, one skips an item and one fails: a single vote cannot pass the item by consensus.
  const partial = await verdictOf("unanimous", { g1: () => sheet({ correct: 1, short: 1 }), g2: () => sheet({ correct: 1 }), g3: down });
  expect(partial.verdict).toBe("INCONCLUSIVE");
  expect(partial.legs).toBe(1);
  // By majority one vote of three does not settle it either way.
  expect((await verdictOf("majority", { g1: () => sheet({ correct: 1, short: 1 }), g2: down, g3: down })).verdict).toBe("INCONCLUSIVE");
  // Two passes of three carry the majority whatever the third would say; two fails of three sink it.
  expect((await verdictOf("majority", { g1: () => sheet({ correct: 1, short: 1 }), g2: () => sheet({ correct: 1, short: 1 }), g3: down })).verdict).toBe("PASS");
  expect((await verdictOf("majority", { g1: () => sheet({ correct: 1, short: 0 }), g2: () => sheet({ correct: 1, short: 0 }), g3: down })).verdict).toBe("FAIL");
  // A failing vote is a fail by unanimity whoever is missing.
  expect((await verdictOf("unanimous", { g1: () => sheet({ correct: 1, short: 0 }), g2: down, g3: down })).verdict).toBe("FAIL");
  // Every answer in: the verdict is the rule's.
  expect((await verdictOf("unanimous", { g1: () => sheet({ correct: 1, short: 1 }), g2: () => sheet({ correct: 1, short: 1 }), g3: () => sheet({ correct: 1, short: 1 }) })).verdict).toBe("PASS");
}, 60_000);

const SUITE = (extra: string, cases = '[{ id: "c1", prompt: "one" }]', graders = '["grader"]', variants = '{ solo: "solo" }') => `
    import { evalSuite } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      evalSuite("suite", {
        cases: ${cases},
        variants: ${variants},
        run: async (variant, c) => variant + ":" + c.prompt,
        rubric: [{ id: "good", text: "it is good" }],
        graders: ${graders},
        vendorOf: () => "acme",
        ${extra}
      }));`;

test("a suite with no independent grader scores nothing and recommends no variant", async () => {
  const none = await run(SUITE("", undefined, "[]"), {});
  expect(none.result).toEqual({ table: { solo: { c1: null } }, perCase: { c1: null }, recommend: null, failures: [] });
  // The only grader is of the candidate's vendor.
  const own = await run(SUITE("", undefined, '[{ harness: "grader", vendor: "acme" }]'), { grader: () => sheet({ good: 1 }) });
  expect(own.result).toEqual({ table: { solo: { c1: null } }, perCase: { c1: null }, recommend: null, failures: [] });
  expect(own.prompts.grader).toHaveLength(0);
  // A variant that is not the work of a model is graded by any grader.
  const free = await run(SUITE("").replace("vendorOf: () => \"acme\"", "vendorOf: () => null"), { grader: () => sheet({ good: 1 }) });
  expect(free.result).toEqual({ table: { solo: { c1: 1 } }, perCase: { c1: "solo" }, recommend: "solo", failures: [] });
}, 60_000);

test("a suite with no case recommends no variant", async () => {
  const { result } = await run(SUITE("", "[]"), { grader: () => sheet({ good: 1 }) });
  expect(result).toEqual({ table: { solo: {} }, perCase: {}, recommend: null, failures: [] });
}, 30_000);

test("a cell whose run fails has no score and is listed, and no comparison rests on it", async () => {
  const { result } = await run(
    `
    import { evalSuite } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      evalSuite("suite", {
        cases: [{ id: "c1", prompt: "one" }],
        variants: { fine: 1, broken: 2 },
        run: async (variant) => { if (variant === 2) throw new Error("it crashed"); return "ok"; },
        rubric: [{ id: "good", text: "it is good" }],
        graders: ["grader"],
        vendorOf: () => "acme",
      }));`,
    { grader: () => sheet({ good: 1 }) },
  );
  expect(result).toEqual({
    table: { fine: { c1: 1 }, broken: { c1: null } },
    perCase: { c1: null },
    recommend: null,
    failures: [{ variant: "broken", case: "c1", error: "it crashed" }],
  });
}, 30_000);

test("variants and cases whose names join to the same text are separate cells", async () => {
  const { result } = await run(
    SUITE("", '[{ id: "c", prompt: "one" }, { id: "b-c", prompt: "two" }]', undefined, '{ "a-b": "x", a: "y" }'),
    { grader: () => sheet({ good: 1 }) },
  );
  expect((result as { table: unknown }).table).toEqual({ "a-b": { c: 1, "b-c": 1 }, a: { c: 1, "b-c": 1 } });
}, 30_000);

test("a rubric given a duplicate id fails the suite before any run", async () => {
  const { result } = await run(
    `
    import { evalSuite } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      let runs = 0;
      try {
        await evalSuite("suite", {
          cases: [{ id: "c1", prompt: "one" }],
          variants: { solo: "solo" },
          run: async () => { runs += 1; return "out"; },
          rubric: [{ id: "good", text: "a" }, { id: "good", text: "b" }],
          graders: ["grader"],
          vendorOf: () => "acme",
        });
      } catch (error) {
        return { runs, message: (error as Error).message };
      }
      return { runs, message: "no error" };
    });`,
    { grader: () => sheet({ good: 1 }) },
  );
  expect((result as { runs: number }).runs).toBe(0);
  expect((result as { message: string }).message).toContain('"good" is given twice');
}, 30_000);

test("a case or an item named __proto__ keeps its score", async () => {
  const { result } = await run(
    `
    import { evalSuite } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const suite = await evalSuite("suite", {
        cases: [{ id: "__proto__", prompt: "one" }],
        variants: { solo: "solo" },
        run: async () => "out",
        rubric: [{ id: "__proto__", text: "it is good" }],
        graders: ["grader"],
        vendorOf: () => "acme",
      });
      return { own: Object.hasOwn(suite.table.solo, "__proto__"), score: suite.table.solo["__proto__"] };
    });`,
    { grader: () => sheet({ ["__proto__"]: 0.75 }) },
  );
  expect(result).toEqual({ own: true, score: 0.75 });
}, 30_000);

test("scores that are the same up to the order of the sums are a tie", () => {
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  expect(sum([0.1, 0.2, 0.3])).not.toBe(sum([0.3, 0.2, 0.1]));
  expect(bestOf({ a: sum([0.1, 0.2, 0.3]), b: sum([0.3, 0.2, 0.1]) })).toBeNull();
  expect(bestOf({ a: 0.2, b: 0.2000001 })).toBe("b");
});

test("a blind set labels the same candidates the same whatever order they are given in", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const names = ["z", "a", "m", "k"];
  const none = () => Promise.resolve(undefined);
  const saved = Object.fromEntries(["agent", "call", "scope", "parallel", "stream", "wait", "sleep", "now", "random", "z", "ask", "read"].map((name) => [name, globals[name]]));
  try {
    for (const name of ["agent", "call", "parallel", "stream", "wait", "sleep", "now"]) globals[name] = none;
    for (const name of ["z", "ask", "read"]) globals[name] = {};
    globals.scope = (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn();
    const labelling = async (order: string[]) => {
      const draws = [0.9, 0.1, 0.5];
      globals.random = () => Promise.resolve(draws.shift());
      const set = await blindSet("blind", Object.fromEntries(order.map((name) => [name, name.toUpperCase()])));
      expect(Object.values(set.labeled).sort()).toEqual(["A", "K", "M", "Z"].sort());
      return Object.keys(set.labeled).map((label) => [label, set.reveal(label)]);
    };
    expect(await labelling([...names].reverse())).toEqual(await labelling(names));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[name];
      else globals[name] = value;
    }
  }
});

test("a transcript check counts a call that opened the file, not a message that names it", async () => {
  const records = [
    { kind: "user", text: "open src/a.ts and src/b.ts" },
    { kind: "assistant", text: "I will read src/a.ts" },
    readCall("c1", "src/b.ts"),
    readResult("c1"),
    readCall("c2", "src/a.tsx"),
    readResult("c2"),
  ];
  const { result } = await run(
    `
    import { chainFromTranscript } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> => chainFromTranscript("chain", { harness: "claude", native: "s-1" }, { opened: ["src/a.ts", "src/b.ts"] }));`,
    {},
    { records, coverage: { status: "complete" } },
  );
  expect(result).toEqual({ opened: ["src/b.ts"], missing: ["src/a.ts"] });
}, 30_000);

test("a read that failed or has no result did not open the file; any other call opens what it names", async () => {
  const records = [
    readCall("c1", "src/failed.ts"),
    readResult("c1", false),
    readCall("c2", "src/pending.ts"),
    { kind: "tool-call", callId: "c3", name: "Edit", category: "edit", target: "src/one.ts", paths: ["src/one.ts", "src/two.ts"] },
    { kind: "tool-call", callId: "c4", name: "Skill", category: "other", target: "review" },
  ];
  const { result } = await run(
    `
    import { chainFromTranscript } from "@niwa-labs/flow-eval";
    export default workflow({ output: z.json() }, async (): Promise<any> =>
      chainFromTranscript("chain", { harness: "claude", native: "s-1" }, { opened: ["src/failed.ts", "src/pending.ts", "src/two.ts", "review", "Skill"] }));`,
    {},
    { records, coverage: { status: "complete" } },
  );
  expect(result).toEqual({ opened: ["src/two.ts", "review", "Skill"], missing: ["src/failed.ts", "src/pending.ts"] });
}, 30_000);
