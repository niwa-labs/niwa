/**
 * A graph of work: each node runs once every node it needs has succeeded, given their results.
 *
 * The graph is checked before anything runs: a node that needs a missing one, an id given twice
 * and a cycle are refused. Nodes that become ready together start in the order of their ids, so
 * a replay starts them in the same order whichever finished first.
 */

import { checkKey, checkKeys, isFatal, script } from "./script.ts";
import type { Settled } from "./types.ts";

/** A node of a graph: its id, and the ids of the nodes it needs. */
export interface GraphNode {
  id: string;
  needs: string[];
}

/**
 * The problems of a graph: missing nodes, ids given twice, and cycles. Empty when it can run.
 * The cycle is named by its ids in the order they are met.
 */
export function graphProblems(nodes: readonly GraphNode[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) problems.push(`the node "${node.id}" is given twice`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const need of node.needs) if (!byId.has(need)) problems.push(`the node "${node.id}" needs "${need}", which is not in the graph`);
  }
  const state = new Map<string, "open" | "done">();
  const walk = (id: string, path: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      problems.push(`the nodes form a cycle: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    for (const need of byId.get(id)?.needs ?? []) if (byId.has(need)) walk(need, [...path, id]);
    state.set(id, "done");
  };
  for (const id of [...byId.keys()].sort()) walk(id, []);
  return problems;
}

/**
 * Run a graph. `onFail: "skip-descendants"` (the default) skips what depends on a failed node and
 * runs the rest; `"stop"` cancels what is running and skips everything not started.
 */
export async function graph<N extends GraphNode, R>(
  key: string,
  nodes: readonly N[],
  opts: { concurrency?: number; run: (node: N, done: Record<string, R>) => Promise<R>; onFail?: "skip-descendants" | "stop" },
): Promise<{ results: Record<string, Settled<R>>; skipped: string[] }> {
  checkKey(key, "the key of a graph");
  checkKeys(
    nodes.map((node) => node.id),
    "the id of a node",
  );
  const problems = graphProblems(nodes);
  if (problems.length > 0) throw new TypeError(`graph "${key}": ${problems.join("; ")}`);
  const onFail = opts.onFail ?? "skip-descendants";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = [...byId.keys()].sort();

  return script().scope(key, opts.concurrency === undefined ? undefined : { concurrency: opts.concurrency }, async (s) => {
    const results: Record<string, Settled<R>> = {};
    const done: Record<string, R> = {};
    const started = new Set<string>();
    const skipped = new Set<string>();
    let stopped = false;

    const startReady = (): void => {
      if (stopped) return;
      for (const id of ids) {
        if (started.has(id) || skipped.has(id)) continue;
        const node = byId.get(id) as N;
        if (!node.needs.every((need) => need in done)) continue;
        started.add(id);
        const given = { ...done };
        s.start(id, () => opts.run(node, given));
      }
    };
    const skipBelow = (failed: string): void => {
      for (let grew = true; grew; ) {
        grew = false;
        for (const id of ids) {
          if (started.has(id) || skipped.has(id)) continue;
          const node = byId.get(id) as N;
          if (node.needs.some((need) => need === failed || skipped.has(need) || (need in results && !(results[need] as Settled<R>).ok))) {
            skipped.add(id);
            grew = true;
          }
        }
      }
    };

    startReady();
    for (let got = await s.next(); got !== null; got = await s.next()) {
      const settled = got.result as Settled<R>;
      if (!settled.ok && isFatal(settled.error)) throw Object.assign(new Error(settled.error.message), { name: settled.error.name });
      results[got.key] = settled;
      if (settled.ok) done[got.key] = settled.value;
      else if (onFail === "stop" && !stopped) {
        stopped = true;
        await s.cancel(`the node "${got.key}" failed`);
      } else skipBelow(got.key);
      startReady();
    }
    for (const id of ids) if (!started.has(id)) skipped.add(id);
    return { results, skipped: ids.filter((id) => skipped.has(id)) };
  });
}
