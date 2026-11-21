// Loops and judging in a real script: revise writes again with the last judgement and stops on a
// pass, never on INCONCLUSIVE; verify counts votes as asked and a judge that does not answer is no
// pass; a gate throws on a fail; a panel with no judge independent of the author decides nothing.

import { afterEach, expect, test } from "bun:test";

import { blindLabel, decidePanel, tally } from "../src/index.ts";
import type { Judged } from "../src/index.ts";
import { flowHost, resultOf } from "./support.ts";
import type { FlowHost, Reply } from "./support.ts";

const hosts: FlowHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

async function host(agents: Record<string, Reply> = {}): Promise<FlowHost> {
  const made = await flowHost(agents);
  hosts.push(made);
  return made;
}

const vote = (verdict: Judged["verdict"], notes = 0): Judged => ({
  verdict,
  findings: Array.from({ length: notes }, (_, i) => ({ title: `n${String(i)}`, evidence: "e", severity: "note" as const })),
  method: "m",
});

test("tally passes on enough passing votes, fails when a pass cannot be reached, and is inconclusive otherwise", () => {
  expect(tally([vote("PASS"), vote("PASS")], "all", "m").verdict).toBe("PASS");
  expect(tally([vote("PASS"), vote("PASS", 1)], "all", "m").verdict).toBe("PASS+NOTES");
  expect(tally([vote("PASS"), vote("INCONCLUSIVE")], "all", "m").verdict).toBe("INCONCLUSIVE");
  expect(tally([vote("PASS"), vote("FAIL")], "all", "m").verdict).toBe("FAIL");
  expect(tally([vote("PASS"), vote("PASS"), vote("FAIL")], "majority", "m").verdict).toBe("PASS");
  expect(tally([vote("INCONCLUSIVE"), vote("INCONCLUSIVE"), vote("PASS")], "majority", "m").verdict).toBe("INCONCLUSIVE");
  expect(tally([vote("FAIL"), vote("FAIL"), vote("PASS")], { atLeast: 2 }, "m").verdict).toBe("FAIL");
  expect(tally([], "all", "m").verdict).toBe("INCONCLUSIVE");
});

test("a panel votes for each judge's top score, bands the winner's mean and is split when no rule holds", () => {
  const two = ["x", "y"];
  expect(decidePanel(two, [{ x: 90, y: 10 }, { x: 88, y: 20 }], "majority", { pass: 85, warn: 75 })).toEqual({
    winner: "x",
    scores: { x: [90, 88], y: [10, 20] },
    split: false,
    band: "PASS",
  });
  expect(decidePanel(two, [{ x: 80, y: 10 }, { x: 78, y: 20 }], "unanimous", { pass: 85, warn: 75 }).band).toBe("WARNING");
  expect(decidePanel(two, [{ x: 90, y: 10 }, { x: 10, y: 90 }], "majority", { pass: 85, warn: 75 })).toMatchObject({ winner: null, split: true, band: "INCONCLUSIVE" });
  expect(decidePanel(two, [], "majority", { pass: 85, warn: 75 })).toMatchObject({ winner: null, band: "INCONCLUSIVE" });
  expect([0, 25, 26, 701].map(blindLabel)).toEqual(["A", "Z", "AA", "ZZ"]);
});

test("revise writes again with the judgement it got and stops at the first pass", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { revise } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const seen: Array<string | null> = [];
      const out = await revise("draft", {
        max: 5,
        write: async (feedback, round) => {
          seen.push(feedback === null ? null : feedback.verdict);
          return "v" + String(round);
        },
        judge: async (value) => ({
          verdict: value === "v1" ? "FAIL" : value === "v2" ? "INCONCLUSIVE" : "PASS",
          findings: [],
          method: "test",
        }),
      });
      return { seen, value: out.value, rounds: out.rounds, stopped: out.stopped, history: out.history.map((j) => j.verdict) };
    });`);
  expect(resultOf(ended)).toEqual({ seen: [null, "FAIL", "INCONCLUSIVE"], value: "v3", rounds: 3, stopped: "accepted", history: ["FAIL", "INCONCLUSIVE", "PASS"] });
}, 30_000);

test("revise stops at its most rounds with the last value, and a helper inside each round is keyed by its round", async () => {
  const flow = await host({ critic: () => ({ verdict: "INCONCLUSIVE", findings: [{ title: "unsure", evidence: "no tests", severity: "blocks" }] }) });
  const ended = await flow.run(`
    import { revise, verify } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await revise("draft", {
        max: 2,
        write: async (_feedback, round) => "v" + String(round),
        judge: (value) => verify("check", { subject: value, by: ["critic"] }),
      });
      return { value: out.value, rounds: out.rounds, stopped: out.stopped, verdict: out.judged.verdict };
    });`);
  expect(resultOf(ended)).toEqual({ value: "v2", rounds: 2, stopped: "max-rounds", verdict: "INCONCLUSIVE" });
  expect(flow.calls.critic).toHaveLength(2);
  expect(flow.calls.critic?.[1]?.prompt).toContain("v2");
}, 30_000);

test("verify asks every seat through every lens and a failing vote fails what needs all", async () => {
  const flow = await host({
    lenient: () => ({ verdict: "PASS", findings: [] }),
    strict: (call) => (call.prompt.includes("security") ? { verdict: "FAIL", findings: [{ title: "secret in log", evidence: "line 3", severity: "blocks" }] } : { verdict: "PASS", findings: [] }),
  });
  const ended = await flow.run(`
    import { verify } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const all = await verify("all", { subject: "the patch", by: ["lenient", "strict"], lenses: ["security", "style"] });
      const most = await verify("most", { subject: "the patch", by: ["lenient", "strict"], lenses: ["security", "style"], require: "majority" });
      const alone = await verify("alone", { subject: "the patch", by: ["strict"], notAuthor: "strict" });
      return { all: all.verdict, votes: all.votes.length, findings: all.findings.map((f) => f.title), most: most.verdict, alone: alone.verdict };
    });`);
  expect(resultOf(ended)).toEqual({ all: "FAIL", votes: 4, findings: ["secret in log"], most: "PASS", alone: "INCONCLUSIVE" });
  expect(flow.calls.strict?.[0]?.prompt).toContain("security");
}, 30_000);

test("a gate that does not pass throws, or answers the judgement when asked to return", async () => {
  const flow = await host({ judge: () => ({ verdict: "FAIL", findings: [{ title: "wrong", evidence: "x", severity: "blocks" }] }) });
  const ended = await flow.run(`
    import { gate } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const returned = await gate("soft", { subject: "s", by: "judge", onFail: "return" });
      try {
        await gate("hard", { subject: "s", by: "judge" });
        return "opened";
      } catch (error) {
        return { name: (error as Error).name, returned: returned.verdict };
      }
    });`);
  expect(resultOf(ended)).toEqual({ name: "GateFailed", returned: "FAIL" });
}, 30_000);

test("a panel scores blind candidates, and with no judge independent of the author decides nothing", async () => {
  const flow = await host({
    one: (call) => ({ scores: call.prompt.includes("## A\nshort") ? { A: 60, B: 92 } : { A: 92, B: 60 } }),
    two: () => ({ scores: { A: 50, B: 90 } }),
  });
  const ended = await flow.run(`
    import { panel } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const candidates = { short: "short", long: "a longer answer" };
      const judged = await panel("pick", { candidates, judges: [{ harness: "one", vendor: "v1" }, { harness: "two", vendor: "v2" }], rubric: ["clear"], blind: true });
      const own = await panel("own", { candidates, judges: [{ harness: "one", vendor: "v1" }], rubric: ["clear"], authorVendor: "v1" });
      return { winner: judged.winner, band: judged.band, own: own.band, ownWinner: own.winner };
    });`);
  expect(resultOf(ended)).toEqual({ winner: "long", band: "PASS", own: "INCONCLUSIVE", ownWinner: null });
  expect(flow.calls.one?.[0]?.prompt).not.toContain("## short");
  expect(flow.calls.one).toHaveLength(1);
}, 30_000);

test("a loop steps until done or its most rounds, and saturation stops when a round finds nothing new", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { loop, saturate } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const counted = await loop("count", { init: 0, step: async (n) => n + 2, done: (n) => n >= 5, max: 10 });
      const capped = await loop("cap", { init: 0, step: async (n) => n + 1, done: (n) => n >= 5, max: 2 });
      const found = await saturate("find", { step: async (_seen, round) => (round < 3 ? [round, round] : [1]), same: (a, b) => a === b, max: 9 });
      return { counted, capped, found };
    });`);
  expect(resultOf(ended)).toEqual({
    counted: { state: 6, rounds: 3, hitMax: false },
    capped: { state: 2, rounds: 2, hitMax: true },
    found: { items: [1, 2], rounds: 3, saturated: true },
  });
}, 30_000);

test("a script's output can be the Attempt of a revision judged by verify, votes and all", async () => {
  const flow = await host({ checker: () => ({ verdict: "PASS", findings: [] }) });
  const ended = await flow.run(`
    import { Attempt, revise, verify } from "@niwa-labs/flow";
    export default workflow({ output: Attempt(z.object({ n: z.number() })) }, async () =>
      revise("count", {
        write: async (_feedback, round) => ({ n: round }),
        judge: ({ n }) => verify("check", { subject: String(n), by: ["checker"] }),
      }));`);
  expect(resultOf(ended)).toMatchObject({ value: { n: 1 }, rounds: 1, stopped: "accepted", judged: { verdict: "PASS", votes: [{ verdict: "PASS" }] } });
}, 30_000);
test("a panel counts only the sheets that score every candidate", () => {
  const two = ["x", "y"];
  const rules = { pass: 85, warn: 75 };
  expect(decidePanel(two, [{ x: 99 }], "majority", rules)).toMatchObject({ winner: null, band: "INCONCLUSIVE", scores: { x: [], y: [] } });
  expect(decidePanel(two, [{ x: 99 }, { x: 90, y: 10 }], "unanimous", rules)).toMatchObject({ winner: "x", scores: { x: [90], y: [10] } });
});

test("a majority of a panel is of the judges that voted, a tie being no vote", () => {
  const two = ["x", "y"];
  const rules = { pass: 85, warn: 75 };
  const tied = { x: 50, y: 50 };
  expect(decidePanel(two, [{ x: 90, y: 10 }, tied, tied], "majority", rules)).toMatchObject({ winner: "x", split: false });
  expect(decidePanel(two, [{ x: 90, y: 10 }, tied], "unanimous", rules)).toMatchObject({ winner: null, split: true });
  expect(decidePanel(two, [tied, tied], "majority", rules)).toMatchObject({ winner: null, split: true, band: "INCONCLUSIVE" });
});

test("a panel whose judge scored only some candidates decides nothing", async () => {
  const flow = await host({ partial: () => ({ scores: { A: 99 } }) });
  const ended = await flow.run(`
    import { panel } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await panel("pick", { candidates: { one: "first", two: "second" }, judges: [{ harness: "partial", vendor: "v" }], rubric: ["clear"], blind: true });
      return { winner: out.winner, band: out.band, scores: out.scores };
    });`);
  expect(resultOf(ended)).toEqual({ winner: null, band: "INCONCLUSIVE", scores: { one: [], two: [] } });
}, 30_000);
