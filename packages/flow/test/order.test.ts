// The helpers that order work, in a real script: map-reduce in batches, a pick over every outcome
// of a stream, a grid of parameters scored cell by cell, and a revision up a ladder of seats.

import { afterEach, expect, test } from "bun:test";

import { flowHost, resultOf } from "./support.ts";
import type { FlowHost } from "./support.ts";

const hosts: FlowHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.close();
}, 30_000);

async function host(agents: Parameters<typeof flowHost>[0] = {}): Promise<FlowHost> {
  const made = await flowHost(agents);
  hosts.push(made);
  return made;
}

test("map-reduce maps the items in batches and reduces the outcomes in the order of the batches", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { mapReduce } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const batches: number[][] = [];
      const total = await mapReduce("sum", [1, 2, 3, 4, 5], {
        batch: 2,
        key: (n) => "n" + String(n),
        map: async (batch) => {
          batches.push(batch);
          await sleep(10 * (3 - batch.length));
          if (batch.includes(5)) throw new Error("five is not wanted");
          return batch.reduce((sum, n) => sum + n, 0);
        },
        reduce: async (parts) => parts.map((part) => (part.ok ? part.value : part.error.message)),
      });
      return { total, batches: batches.length };
    });`);
  expect(resultOf(ended)).toEqual({ total: [3, 7, "five is not wanted"], batches: 3 });
}, 30_000);

test("rankAll waits for every outcome of a stream, then takes the branch the ranking picks", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { rankAll, stream } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      await using drafts = stream("drafts", {
        short: async () => "ab",
        long: async () => { await sleep(20); return "abcd"; },
        broken: async (): Promise<string> => { throw new Error("no draft"); },
      });
      const best = await rankAll(drafts, async (all) => {
        const lengths = Object.entries(all).map(([key, one]) => [key, one.ok ? one.value.length : -1] as const);
        return lengths.sort((a, b) => b[1] - a[1])[0]![0] as "short" | "long" | "broken";
      });
      await using again = stream("again", { broken: async (): Promise<string> => { throw new Error("no draft"); } });
      const refused = await rankAll(again, async () => "broken" as const).then(() => "picked", (error: Error) => error.message);
      await using other = stream("other", { only: async () => "x" });
      const unknown = await rankAll(other, async () => "constructor" as "only").then(() => "picked", (error: Error) => error.message);
      return { key: best.key, value: best.value, seen: Object.keys(best.all).sort(), refused, unknown };
    });`);
  expect(resultOf(ended)).toEqual({
    key: "long",
    value: "abcd",
    seen: ["broken", "long", "short"],
    refused: 'rankAll: "broken" failed (no draft), it cannot be picked',
    unknown: 'rankAll: "constructor" is not a branch of the stream',
  });
}, 30_000);

test("a grid runs every cell, scores the ones that ran and names the best, a failed cell scoring nothing", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { paramGrid } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await paramGrid("tune", {
        grid: { size: [1, 2, 3], scale: [10] },
        run: async (cell) => {
          if (cell.size === 3) throw new Error("too big");
          return cell.size * cell.scale;
        },
        score: (result) => result,
      });
      return { scores: out.cells.map((cell) => (cell.result.ok ? cell.score : null)), best: out.best };
    });`);
  expect(resultOf(ended)).toEqual({ scores: [10, 20, null], best: 1 });
}, 30_000);

test("escalate writes with the next seat after each failed judgement, and stops at the first pass", async () => {
  const flow = await host({ cheap: () => ({ answer: "a guess" }), strong: () => ({ answer: "the answer" }), top: () => ({ answer: "unused" }) });
  const ended = await flow.run(`
    import { escalate } from "@niwa-labs/flow";
    export default workflow({ uses: ["session.start.*"], output: z.json() }, async (): Promise<any> => {
      const out = await escalate("solve", {
        seats: ["cheap", "strong", "top"],
        write: async (seat, feedback) => (await agent("Solve it." + (feedback === null ? "" : " Last time: " + feedback.findings[0]!.title), { harness: seat as "cheap" | "strong" | "top" })).answer,
        judge: async (value) =>
          value === "the answer"
            ? { verdict: "PASS", findings: [], method: "exact" }
            : { verdict: "FAIL", findings: [{ title: "a guess is not an answer", evidence: value, severity: "blocks" }], method: "exact" },
      });
      return { value: out.value, rounds: out.rounds, stopped: out.stopped };
    });`);
  expect(resultOf(ended)).toEqual({ value: "the answer", rounds: 2, stopped: "accepted" });
  expect(flow.calls.cheap?.map((call) => call.prompt)).toEqual(["Solve it."]);
  expect(flow.calls.strong?.map((call) => call.prompt)).toEqual(["Solve it. Last time: a guess is not an answer"]);
  expect(flow.calls.top).toEqual([]);
}, 30_000);
