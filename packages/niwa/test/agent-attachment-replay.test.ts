// Repeat the action from the same operation after its attachment record reached the journal.
// Its nested steps must line up with the original calls, including the watch after the write.
import { expect, test } from "bun:test";
import { agents } from "@niwa-labs/agent";
import type { Action, ActionContext, JournalReader, RecordType, StoredRecord } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";

test("replaying attach and detach completes the original watch operation", async () => {
  const handlers = new Map<string, Action<any, any>>();
  const rows: StoredRecord[] = [];
  const reader = { since: (_: number, names: string[]) => rows.filter((row) => names.includes(row.type)) } as unknown as JournalReader;
  agents({ agents: [{ name: "rin", harness: "fake", prompt: "Read tasks." }], digests: false }).setup({
    action: (action: Action<any, any>) => handlers.set(action.name, action), declare() {}, offer() {}, offers: () => [], on() {}, subscribers() {},
    service() {}, summarize() {}, journal: () => reader,
  } as unknown as PluginApi);
  async function replay(action: string, input: unknown, interruptAt: string, expected: string[]) {
    const run = handlers.get(action)!;
    const calls: string[][] = [];
    async function attempt(interrupt: boolean) {
      const steps: string[] = [];
      calls.push(steps);
      let ordinal = 0;
      const ctx = {
        caller: { kind: "host" },
        operationId: action,
        emit: async (type: RecordType<unknown>, data: unknown) => {
          const id = `${action}/${++ordinal}`;
          let stored = rows.find((row) => row.id === id);
          if (!stored) {
            stored = { id, seq: rows.length + 1, type: type.name, data } as StoredRecord;
            rows.push(stored);
          }
          if (interrupt && type.name === interruptAt) throw new Error("process stopped");
          return stored;
        },
        step: { outcome: async (ref: { name: string }) => {
          steps.push(ref.name);
          if (ref.name === "session.read") return { status: "completed", value: { records: [], coverage: { status: "empty" } } };
          return { status: "completed", value: { watching: true } };
        } },
      } as unknown as ActionContext;
      return run.run(run.input.parse(input), ctx);
    }
    await expect(attempt(true)).rejects.toThrow("process stopped");
    await attempt(false);
    expect(calls[1]).toEqual(expected);
    expect(calls[1]?.slice(0, calls[0]!.length)).toEqual(calls[0]);
    expect(rows.filter((row) => row.type === interruptAt)).toHaveLength(1);

    // Another attachment won while this operation was stopped. An old operation cannot change its watch.
    rows.push({ id: `replacement-${action}`, seq: rows.length + 1, type: "agent.attached", data: { agent: "rin", cwd: "/replacement", session: "fake ext" } } as StoredRecord);
    await attempt(false);
    expect(calls.at(-1)).not.toContain(action === "agent.attach" ? "history.watch" : "history.unwatch");
  }
  await replay("agent.attach", { agent: "rin", harness: "fake", native: "ext", cwd: "/tmp" }, "agent.attached", ["session.read", "history.watch"]);
  await replay("agent.detach", { session: "fake ext" }, "agent.detached", ["history.unwatch"]);
});
