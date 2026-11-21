// The group helpers in a real script: a map keeps the order of its items and turns a failure into
// a value but never a refusal of the grant; a swarm reports its gaps; a stream gives its first
// passing branch; consensus agrees on what the seats answered; a graph is checked before it runs
// and runs a node once what it needs is done.

import { afterEach, expect, test } from "bun:test";

import { graphProblems, gridCells, seatKeys } from "../src/index.ts";
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

test("map gives the outcomes in the order of the items, whichever ended first, and a failure as a value", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { map } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await map("items", [30, 1, 10], { key: (n) => "n" + String(n) }, async (n) => {
        await sleep(n);
        if (n === 10) throw new Error("ten is not wanted");
        return n * 2;
      });
      return out;
    });`);
  expect(resultOf(ended)).toEqual([
    { ok: true, value: 60 },
    { ok: true, value: 2 },
    { ok: false, error: { name: "Error", message: "ten is not wanted" } },
  ]);
}, 30_000);

test("map throws a refusal of the grant instead of keeping it as a value", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { map } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      try {
        await map("items", ["a", "b"], { key: (k) => k }, async (k) => {
          if (k === "b") throw Object.assign(new Error("the grant does not hold it"), { name: "Denied" });
          return k;
        });
        return "kept";
      } catch (error) {
        return (error as Error).name;
      }
    });`);
  expect(resultOf(ended)).toBe("Denied");
}, 30_000);

test("a key that cannot name a branch, or one given twice, fails the helper before it runs anything", async () => {
  const flow = await host({ worker: () => ({ answer: "x" }) });
  const ended = await flow.run(`
    import { map } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const errors: string[] = [];
      for (const keys of [["a", "a"], ["a.b"], [""]]) {
        try {
          await map("m" + String(errors.length), keys, { key: (k) => k }, async () => ask({ harness: "worker" }, "work"));
        } catch (error) {
          errors.push((error as Error).message);
        }
      }
      return errors;
    });`);
  const errors = resultOf(ended) as string[];
  expect(errors).toHaveLength(3);
  expect(errors[0]).toContain("given twice");
  expect(errors[1]).toContain('may not hold "."');
  expect(flow.calls.worker).toHaveLength(0);
}, 30_000);

test("a swarm keeps the valid results, runs a refused worker once more and reports the gaps", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { swarm } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const tries: Record<string, number> = {};
      const out = await swarm("crew", {
        briefs: { good: 1, flaky: 2, bad: 3 },
        respawn: 1,
        worker: async (brief, id) => {
          tries[id] = (tries[id] ?? 0) + 1;
          if (id === "flaky" && tries[id] === 1) throw new Error("not this time");
          return id === "bad" ? -brief : brief * 10;
        },
        valid: (result) => result > 0,
      });
      return { ...out, tries };
    });`);
  expect(resultOf(ended)).toEqual({ results: { good: 10, flaky: 20 }, gaps: ["bad"], dropped: ["bad"], tries: { good: 1, flaky: 2, bad: 2 } });
}, 30_000);

test("a swarm keeps the result of a brief named like a property every object has", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { swarm } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await swarm("crew", { briefs: { ["__proto__"]: 1, plain: 2 }, worker: async (brief) => brief * 10 });
      return { kept: Object.keys(out.results).sort(), gaps: out.gaps };
    });`);
  expect(resultOf(ended)).toEqual({ kept: ["__proto__", "plain"], gaps: [] });
}, 30_000);

test("firstPassing takes the first passing outcome of a stream and leaves the rest to be read", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { firstPassing, stream } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      await using probes = stream("probe", {
        fast: async () => { await sleep(1); return 1; },
        good: async () => { await sleep(40); return 5; },
        late: async () => { await sleep(150); return 7; },
      });
      const first = await firstPassing(probes, (n) => n > 3);
      const rest = await probes.rest();
      return { first, late: rest.late };
    });`);
  expect(resultOf(ended)).toEqual({ first: { key: "good", value: 5 }, late: { ok: true, value: 7 } });
}, 30_000);

test("consensus asks every seat and agrees on the answers that came back", async () => {
  const flow = await host({ a: () => ({ n: 4 }), b: () => ({ n: 4 }), c: () => ({ n: 9 }) });
  const ended = await flow.run(`
    import { consensus, askSeat } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await consensus("count", {
        seats: ["a", "b", "c"],
        run: (seat) => askSeat(seat, "How many?", z.object({ n: z.number() })),
        agree: (all) => {
          const counts = new Map<number, number>();
          for (const one of all) counts.set(one.n, (counts.get(one.n) ?? 0) + 1);
          const top = [...counts].find(([, c]) => c * 2 > all.length);
          return top === undefined ? null : { n: top[0] };
        },
      });
      return out.value;
    });`);
  expect(resultOf(ended)).toEqual({ n: 4 });
  expect([flow.calls.a, flow.calls.b, flow.calls.c].map((calls) => calls?.length)).toEqual([1, 1, 1]);
}, 30_000);

test("a graph runs a node once what it needs is done, skips below a failure and gives each node what it needs", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { graph } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const order: string[] = [];
      const out = await graph("build", [
        { id: "lib", needs: [] },
        { id: "app", needs: ["lib"] },
        { id: "docs", needs: [] },
        { id: "broken", needs: ["docs"] },
        { id: "site", needs: ["broken", "app"] },
      ], {
        run: async (node, done) => {
          order.push(node.id);
          if (node.id === "broken") throw new Error("it broke");
          return node.id + "(" + Object.keys(done).sort().join(",") + ")";
        },
      });
      return { order, ...out };
    });`);
  const out = resultOf(ended) as { order: string[]; results: Record<string, { ok: boolean; value?: string }>; skipped: string[] };
  expect(out.results.app).toEqual({ ok: true, value: "app(docs,lib)" });
  expect(out.results.broken?.ok).toBe(false);
  expect(out.skipped).toEqual(["site"]);
  expect(out.order.slice(0, 2)).toEqual(["docs", "lib"]);
}, 30_000);

test("a node named like a property every object has waits for that node, and its result is kept", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { graph } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const out = await graph("names", [
        { id: "constructor", needs: [] },
        { id: "after", needs: ["constructor", "__proto__"] },
        { id: "__proto__", needs: [] },
      ], {
        run: async (node, done) => {
          if (node.id !== "after") { await sleep(20); return node.id + "-done"; }
          return Object.keys(done).sort();
        },
      });
      return { keys: Object.keys(out.results).sort(), after: out.results.after };
    });`);
  expect(resultOf(ended)).toEqual({ keys: ["__proto__", "after", "constructor"], after: { ok: true, value: ["__proto__", "constructor"] } });
}, 30_000);

test("a graph with a missing node, an id given twice or a cycle is refused before it runs", () => {
  expect(graphProblems([{ id: "a", needs: ["ghost"] }])).toEqual(['the node "a" needs "ghost", which is not in the graph']);
  expect(graphProblems([{ id: "a", needs: [] }, { id: "a", needs: [] }])).toEqual(['the node "a" is given twice']);
  expect(graphProblems([{ id: "a", needs: ["b"] }, { id: "b", needs: ["c"] }, { id: "c", needs: ["a"] }])).toEqual(["the nodes form a cycle: a -> b -> c -> a"]);
  expect(graphProblems([{ id: "a", needs: [] }, { id: "b", needs: ["a"] }])).toEqual([]);
});

test("the cells of a grid are every combination, in the order of its keys and values", () => {
  expect(gridCells({ size: [1, 2], mode: ["x", "y"] })).toEqual([
    { size: 1, mode: "x" },
    { size: 1, mode: "y" },
    { size: 2, mode: "x" },
    { size: 2, mode: "y" },
  ]);
});
test("seat keys number a seat met again with a name no other seat has", () => {
  expect(seatKeys(["judge", "judge", "judge-2"], "a seat")).toEqual(["judge", "judge-3", "judge-2"]);
  expect(seatKeys(["judge-2", "judge", "judge"], "a seat")).toEqual(["judge-2", "judge", "judge-3"]);
  expect(seatKeys(["a", "a", "a"], "a seat")).toEqual(["a", "a-2", "a-3"]);
});


test("map throws a refusal of the grant as soon as it is committed, not when the branches before it ended", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { map } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      try {
        await map("items", ["slow", "refused"], { key: (k) => k }, async (k) => {
          if (k === "slow") { await sleep("1h"); return k; }
          throw Object.assign(new Error("the grant does not hold it"), { name: "Denied" });
        });
        return "kept";
      } catch (error) {
        return (error as Error).name;
      }
    });`);
  expect(resultOf(ended)).toBe("Denied");
}, 30_000);

test("a question the owner left unanswered leaves a map and a swarm, and a worker that met it is not run again", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { map, swarm } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const mapped = await map("asks", ["a"], { key: (k) => k }, async () => ask.confirm("Go on?", { timeout: "50ms" })).then(() => "kept", (error) => (error as Error).name);
      let tries = 0;
      const swarmed = await swarm("crew", {
        briefs: { one: 1 },
        respawn: 1,
        worker: async () => { tries += 1; return ask.confirm("Go on?", { timeout: "50ms" }); },
      }).then(() => "kept", (error) => (error as Error).name);
      return { mapped, swarmed, tries };
    });`);
  expect(resultOf(ended)).toEqual({ mapped: "AskExpired", swarmed: "AskExpired", tries: 1 });
}, 30_000);

test("a swarm worker that opens a named scope can run again after a failed attempt", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { swarm } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      let tries = 0;
      return swarm("crew", {
        briefs: { one: 1 },
        respawn: 1,
        worker: async (brief) => scope("work", undefined, async () => {
          tries += 1;
          if (tries === 1) throw new Error("not this time");
          return brief * 7;
        }),
      });
    });`);
  expect(resultOf(ended)).toEqual({ results: { one: 7 }, gaps: [], dropped: [] });
}, 30_000);

test("a stream that cannot be opened gives every read the error of its opening", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { stream } from "@niwa-labs/flow";
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const first = stream("dup", { x: async () => 1 });
      const second = stream("dup", { x: async () => 2 });
      const errors: string[] = [];
      for (const read of [() => second.next(), () => second.rest(), () => second.pending()]) {
        await read().catch((error) => errors.push((error as Error).message));
      }
      return { errors, first: await first.next() };
    });`);
  const out = resultOf(ended) as { errors: string[]; first: unknown };
  expect(out.errors).toHaveLength(3);
  for (const message of out.errors) expect(message).toContain("opened twice");
  expect(out.first).toEqual({ key: "x", result: { ok: true, value: 1 } });
}, 30_000);

test("every way to read a stream throws a refusal of the grant", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { stream } from "@niwa-labs/flow";
    const refused = async () => { throw Object.assign(new Error("the grant does not hold it"), { name: "Denied" }); };
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const name = (read: () => Promise<unknown>) => read().then(() => "kept", (error) => (error as Error).name);
      const next = await name(async () => stream("next", { refused }).next());
      const rest = await name(async () => stream("rest", { refused }).rest());
      const ready = await name(async () => {
        const s = stream("ready", { refused });
        for (let tries = 0; tries < 100; tries += 1) {
          const got = await s.ready();
          if (got.length > 0) return got;
          await sleep(20);
        }
        return "nothing was ready";
      });
      const each = await name(async () => { for await (const _ of stream("each", { refused })) { /* read */ } });
      return { next, rest, ready, each };
    });`);
  expect(resultOf(ended)).toEqual({ next: "Denied", rest: "Denied", ready: "Denied", each: "Denied" });
}, 30_000);

test("a branch keyed __proto__ keeps its outcome in parallel, in the rest of a stream and when ranked", async () => {
  const flow = await host();
  const ended = await flow.run(`
    import { parallel, rankAll, stream } from "@niwa-labs/flow";
    const own = (table: object) => Object.keys(table);
    export default workflow({ output: z.json() }, async (): Promise<any> => {
      const done = await parallel<string, any>({ ["__proto__"]: async () => ({ n: 1 }), plain: async () => 2 });
      const rest = await stream("rest", { ["__proto__"]: async () => { throw new Error("no"); }, plain: async () => 2 }).rest();
      const ranked = await rankAll(stream("rank", { ["__proto__"]: async () => 5, plain: async () => 2 }), async () => "__proto__");
      return { done: own(done), n: Object.getOwnPropertyDescriptor(done, "__proto__")?.value, rest: own(rest), failed: Object.getOwnPropertyDescriptor(rest, "__proto__")?.value?.ok, ranked: ranked.value };
    });`);
  expect(resultOf(ended)).toEqual({ done: ["__proto__", "plain"], n: { n: 1 }, rest: ["__proto__", "plain"], failed: false, ranked: 5 });
}, 30_000);
