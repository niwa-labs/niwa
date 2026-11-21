// Live: a task through MCP, asked by a real mcode session.
//
// The mirror of the test of a task through MCP with a Claude Code asker, with the asker being a real MiniMax Code session instead of
// a Claude Code one. The asker is started by niwa with niwa's own MCP server, so it sees niwa
// through that server: it creates the task with the tool of niwa's server and waits for the
// result with another one.
//
// What the scenario expects of niwa:
//
//   1. the asker session really talks through the MCP server: the task it created was created
//      by an MCP client, and the tools it called are niwa's;
//   2. the executor started exactly one mcode session, and the task ended with its answer;
//   3. the trace from the task joins the session and the end of the task.
//
// A mcode kind that cannot pass the servers to a session fails the scenario: it is not skipped.
//
// The test is skipped unless NIWA_LIVE=1 and the "mcode" binary is on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";

const HOST_SCRIPT = new URL("./fixtures/task-mcp-agent-host.ts", import.meta.url).pathname;

/** The harness the executor of the task addresses. */
const EXECUTOR_HARNESS = "mcode-executor";

/** The harness the asker of the task talks through. */
const ASKER_HARNESS = "mcode-asker";

/** The id of the task the real agent asks for. */
const AGENT_TASK_DESCRIPTION = "agent task";

/** How long the turn of the real agent may take. */
const AGENT_TURN_DEADLINE_MS = 900_000;

/** The type of a record, as a plain string. */
function typeOf(record: StoredRecord): string {
  return String(record.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((record) => typeOf(record) === type);
}

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/** The data of a "session.started" record: the session it names. */
const SessionStartedData = z.object({ session: z.string() });

/** The data of a "task.done" record: how the task ended. */
const TaskDoneData = z.object({
  task: z.string(),
  outcome: z.object({ status: z.string(), result: z.unknown().optional() }),
});

/** The MCP client that made a call, as the transport bound it. */
function mcpActorOf(record: StoredRecord): string | undefined {
  const actor = record.actor;
  if (actor.kind !== "client") return undefined;
  return actor.id;
}

/** Wait until the condition holds; the failure says what was waited for. */
async function until(
  fn: () => boolean | Promise<boolean>,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const untilAt = Date.now() + deadlineMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= untilAt) throw new Error(`${what} did not happen within ${String(deadlineMs)} ms`);
    await Bun.sleep(500);
  }
}

test.skipIf(!(live && Bun.which("mcode")))(
  "a task through MCP with a real mcode asker: the asker creates the task through niwa's MCP server and reads its result",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      // The asker is a real session: a MiniMax Code session that sees niwa through niwa's own
      // MCP server. The host gives it only the actions it needs.
      const startedAt = Date.now();
      const started = (await api.call(actionName("session.start"), {
        harness: ASKER_HARNESS,
        prompt: [
          "You are the asker of a task in niwa, and you talk to niwa through your MCP server.",
          "",
          "Do exactly this, in this order, with the MCP tools named mcp__niwa__task_create and",
          "mcp__niwa__task_result:",
          `1. Call mcp__niwa__task_create with the input {"kind":"agent","description":"${AGENT_TASK_DESCRIPTION}",` +
            `"text":"Reply with the single word ok.","askedBy":{"kind":"client","id":"mcp:asker"},` +
            `"responsible":{"kind":"agent","id":"executor:${EXECUTOR_HARNESS}"},` +
            `"reportTo":{"kind":"client","id":"mcp:asker"}}.`,
          "2. Call mcp__niwa__task_result with the input {\"task\": <the id that task_create returned>} and wait for it.",
          "3. Answer with the result that came back, and nothing else.",
        ].join("\n"),
        model: "minimax/MiniMax-M3.1-Flash",
        visible: { actions: ["task.create", "task.result"] },
      })) as { session: string; ref: string };
      const startMs = Date.now() - startedAt;
      const askerSession = started.ref;
      expect(askerSession.startsWith(`${ASKER_HARNESS} `)).toBe(true);

      // The task was created by the asker, through the MCP server of niwa.
      await until(
        async () => {
          const records = await api!.records.read();
          return recordsOf(records, "task.created").some((record) => {
            const data = record.data as { id?: string; description?: string } | undefined;
            return data?.description === AGENT_TASK_DESCRIPTION;
          });
        },
        AGENT_TURN_DEADLINE_MS,
        "the task was not created",
      );

      const records = await api.records.read();
      const created = must(
        recordsOf(records, "task.created").find((record) => {
          const data = record.data as { id?: string; description?: string } | undefined;
          return data?.description === AGENT_TASK_DESCRIPTION;
        }),
        "the record of the task the agent created",
      );
      const mcpClientId = must(mcpActorOf(created), "the MCP client that created the task");
      expect(mcpClientId.startsWith("mcp:")).toBe(true);
      const taskId = (created.data as { id: string }).id;

      // The task ends with the answer of the session.
      await until(
        async () => {
          const now = await api!.records.read();
          return recordsOf(now, "task.done").some((record) => {
            const data = record.data as { task?: string } | undefined;
            return data?.task === taskId;
          });
        },
        AGENT_TURN_DEADLINE_MS,
        "the task did not end",
      );
      const after = await api.records.read();
      const done = must(
        recordsOf(after, "task.done").find((record) => {
          const data = record.data as { task?: string } | undefined;
          return data?.task === taskId;
        }),
        "the record of the task that ended",
      );
      // The executor started exactly one mcode session. The start of a session returns once it
      // is named, so the asker creates the task while its own first turn runs: the executor's
      // session is counted once the task has ended, not the moment it was created.
      const executorSessions = recordsOf(after, "session.started").filter((record) => {
        const data = SessionStartedData.parse(record.data);
        return data.session.startsWith(`${EXECUTOR_HARNESS} `);
      });
      expect(executorSessions).toHaveLength(1);

      const outcome = TaskDoneData.parse(done.data);
      expect(outcome.outcome.status).toBe("result");
      expect(String(outcome.outcome.result ?? "").toLowerCase()).toContain("ok");

      // The trace from the task joins the session and the end of the task: one chain.
      const traced = await api.trace(created.id);
      const tracedTypes = traced.map((record) => typeOf(record));
      expect(tracedTypes).toContain("session.started");
      expect(tracedTypes).toContain("task.done");
      const roots = new Set(traced.map((record) => String(record.root)));
      expect(roots.size).toBe(1);

      // The asker used niwa's own tools: the transcript of its session says so.
      const transcript = (await api.call(actionName("session.read"), { session: askerSession })) as {
        records: { kind: string; name?: string }[];
      };
      const niwaCalls = transcript.records
        .filter((record) => record.kind === "tool-call" && (record.name ?? "").includes("niwa"))
        .map((record) => record.name ?? "");
      expect(niwaCalls.length).toBeGreaterThanOrEqual(2);
      for (const name of niwaCalls) expect(name).toMatch(/task_(create|result)$/);

      console.log(
        `live timings: session.start ${String(startMs)} ms, task.done at +${String(done.at - created.at)} ms`,
      );
      console.log(`agent mcp client: ${mcpClientId}`);
      console.log(`agent tool calls: ${JSON.stringify(niwaCalls)}`);
    } finally {
      await api?.close().catch(() => undefined);
      // A clean stop: the host disposes its harness children, which run in process groups of
      // their own and would outlive a SIGKILL of the host.
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  AGENT_TURN_DEADLINE_MS + 600_000,
);
