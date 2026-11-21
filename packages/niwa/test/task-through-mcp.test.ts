// Assign and be free.
// "From an agent in one harness, through MCP, create a task for an agent in another harness.
//  The call returns at once. The result arrives. The trace joins the request, the task, the
//  session and the result."
//
// The run is a real one: a host process on a temporary home, the MCP surface of that host, and a
// real MiniMax Code session behind it. The client asks for the task, the call returns at once,
// the executor of the task starts one mcode session, and the session's answer ends the task.
//
// The second run of the check has a real agent as the asker: a Claude Code session, on the model
// the check names, which sees niwa through niwa's own MCP server. That session creates the task
// and asks for its result, so the asker is an agent in a harness rather than a program holding
// an MCP client. The journal must show the task created by that session's own MCP client, the
// one mcode session the executor started, and the result that came back to the asker.
//
// The tests are skipped unless NIWA_LIVE=1 and the "mcode" binary is on the PATH.

import { expect, test } from "bun:test";

import { actionName, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import { spawnHost, tempHome, live, connectAsOwner, NO_ADVISOR } from "@niwa-labs/testing";
import { z } from "zod";

import { jsonOf, mcpPair } from "./fixtures/mcp-pair.ts";

const HOST_SCRIPT = new URL("./fixtures/task-mcp-host.ts", import.meta.url).pathname;

/** The harness the executor of the task addresses: the mcode installation of the host. */
const HARNESS = "mcode-test";

/** The harness the asker of the task talks through: the Claude Code installation of the host. */
const ASKER_HARNESS = "claude-test";

/** The id of the task under test. */
const TASK_ID = "live-task";

/** The id of the task the real agent asks for. */
const AGENT_TASK_DESCRIPTION = "agent task";

/** The tool that says who the caller is, so the test knows the address it speaks as. */
const CALLER_TOOL = "b1_caller";

/** The tool that creates a task. */
const CREATE_TOOL = "task_create";

/** The tool that gives the result of a task. */
const RESULT_TOOL = "task_result";

/** How long the call that assigns the task may take before it is too slow. */
const ASSIGN_BUDGET_MS = 2_000;

/** How long the work may take before the test gives up on it. */
const WORK_DEADLINE_MS = 180_000;

/** How long the turn of the real agent may take before the test gives up on it. */
const AGENT_TURN_DEADLINE_MS = 300_000;

/** The data of a "session.started" record: the session it names. */
const SessionStartedData = z.object({ session: z.string() });

/** The data of a "task.done" record: how the task ended. */
const TaskDoneData = z.object({
  task: z.string(),
  outcome: z.object({ status: z.string(), result: z.unknown().optional() }),
});

/** The data of a "message.sent" record: who sent what to whom. */
const MessageSentData = z.object({
  to: z.object({ kind: z.string(), id: z.string() }),
  body: z.object({ type: z.string() }),
});

/** The value that is there, or a failure that says what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the ${what} is not there`);
  return value;
}

/** The type of a record, as a plain string. */
function typeOf(record: StoredRecord): string {
  return String(record.type);
}

/** The records of one type, from the whole journal. */
function recordsOf(records: readonly StoredRecord[], type: string): StoredRecord[] {
  return records.filter((record) => typeOf(record) === type);
}

/** The client of an MCP session, as the transport bound it: "mcp:<id>". */
function mcpActorOf(record: StoredRecord): string | undefined {
  const actor = record.actor;
  if (actor.kind !== "client") return undefined;
  return actor.id;
}

test.skipIf(!(live && Bun.which("mcode")))(
  "assign and be free: a task created through MCP returns at once, and the mcode session answers it",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      pair = await mcpPair(home.path);
      api = await connectAsOwner(home.path);
      const client = pair.client;

      // The client asks as the MCP session speaks: the address the transport bound it to.
      const caller = jsonOf(await client.callTool({ name: CALLER_TOOL, arguments: {} })) as {
        caller: string;
        kind: string;
      };
      expect(caller.kind).toBe("client");
      const clientAddress = { kind: "client" as const, id: caller.caller };

      // The task is assigned: the call returns at once, and the work goes on behind it.
      const assignedAt = Date.now();
      const created = await client.callTool({
        name: CREATE_TOOL,
        arguments: {
          id: TASK_ID,
          kind: "study",
          text: "Reply with the single word ok.",
          askedBy: clientAddress,
          responsible: { kind: "agent", id: `executor:${HARNESS}` },
          reportTo: clientAddress,
        },
      });
      const assignMs = Date.now() - assignedAt;
      expect(created.isError).toBeFalsy();
      expect(jsonOf(created)).toEqual({ id: TASK_ID });
      expect(assignMs).toBeLessThan(ASSIGN_BUDGET_MS);

      // The result arrives: the call waits for the task to end, and the answer is the one
      // the mcode session gave.
      const waitedAt = Date.now();
      const answered = await client.callTool(
        { name: RESULT_TOOL, arguments: { task: TASK_ID } },
        undefined,
        { timeout: WORK_DEADLINE_MS + 60_000 },
      );
      const resultMs = Date.now() - waitedAt;
      expect(answered.isError).toBeFalsy();
      const outcome = TaskDoneData.parse(jsonOf(answered));
      expect(outcome.task).toBe(TASK_ID);
      expect(outcome.outcome.status).toBe("result");
      expect(String(outcome.outcome.result ?? "").toLowerCase()).toContain("ok");

      // The journal tells the whole story.
      const records = await api.records.read();
      const taskCreated = must(
        recordsOf(records, "task.created")[0],
        "the record of the task that was created",
      );
      const taskDone = must(recordsOf(records, "task.done")[0], "the record of the task that ended");

      // The trace from the task joins the session and the end of the task, and it is one chain.
      const traced = await api.trace(taskCreated.id);
      const tracedTypes = traced.map((record) => typeOf(record));
      expect(tracedTypes).toContain("session.started");
      expect(tracedTypes).toContain("task.done");
      expect(tracedTypes).toContain("message.sent");
      const roots = new Set(traced.map((record) => String(record.root)));
      expect(roots.size).toBe(1);
      expect(String(must(traced[0], "the record the trace started from").root)).toBe(
        String(taskCreated.id),
      );

      // The session of the trace is the mcode session of the host.
      const sessionStarted = must(
        traced.find((record) => typeOf(record) === "session.started"),
        "the record of the session that was started",
      );
      const session = SessionStartedData.parse(sessionStarted.data);
      expect(session.session.startsWith(`${HARNESS} `)).toBe(true);

      // Exactly one session was started: the executor does not start a second one.
      expect(recordsOf(records, "session.started")).toHaveLength(1);

      // The end of the task went where the task says to report.
      const reported = recordsOf(records, "message.sent").filter(
        (record) => MessageSentData.parse(record.data).body.type === "result",
      );
      expect(reported).toHaveLength(1);
      expect(MessageSentData.parse(must(reported[0], "the report of the result").data).to).toEqual(
        clientAddress,
      );

      const doneMs = taskDone.at - taskCreated.at;
      console.log(
        `live timings: assign ${String(assignMs)} ms, task.done at +${String(doneMs)} ms, result after ${String(resultMs)} ms`,
      );
    } finally {
      await pair?.close();
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
    }
  },
  300_000,
);

test.skipIf(!(live && Bun.which("mcode") && Bun.which("claude")))(
  "with a real agent as the asker: a Claude Code session creates the task through niwa's MCP server and reads its result",
  async () => {
    const home = await tempHome();
    const host = spawnHost(HOST_SCRIPT, home.path);
    let api: Awaited<ReturnType<typeof connect>> | undefined;

    try {
      await host.ready();
      api = await connectAsOwner(home.path);

      // The asker is a real session: a Claude Code session that sees niwa's own actions
      // through niwa's MCP server. The host gives it only the two actions it needs.
      const startedAt = Date.now();
      const started = await api.call(actionName("session.start"), {
        harness: ASKER_HARNESS,
        prompt: [
          "You are the asker of a task in niwa, and you talk to niwa through your MCP server.",
          "",
          "Do exactly this, in this order, with the MCP tools named mcp__niwa__task_create and",
          "mcp__niwa__task_result:",
          `1. Call mcp__niwa__task_create with the input {"kind":"agent","description":"${AGENT_TASK_DESCRIPTION}",` +
            `"text":"Reply with the single word ok.","askedBy":{"kind":"client","id":"mcp:asker"},` +
            `"responsible":{"kind":"agent","id":"executor:${HARNESS}"},` +
            `"reportTo":{"kind":"client","id":"mcp:asker"}}.`,
          "2. Call mcp__niwa__task_result with the input {\"task\": <the id that task_create returned>} and wait for it.",
          "3. Answer with the result that came back, and nothing else.",
          NO_ADVISOR,
        ].join("\n"),
        model: "haiku",
        visible: { actions: ["task.create", "task.result"] },
      });
      const startMs = Date.now() - startedAt;
      const askerSession = (started as { ref: string }).ref;
      expect(askerSession.startsWith(`${ASKER_HARNESS} `)).toBe(true);

      // The asker's own answer is in the transcript of its session: the turn it finished
      // with says what it replied.
      const answeredAt = Date.now();
      const answer = await waitForAnswer(api, askerSession, AGENT_TURN_DEADLINE_MS);
      const answerMs = Date.now() - answeredAt;

      // The task was created by the MCP client of the asker's session, not by the test.
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

      // The executor started exactly one mcode session, and it is the session of the trace.
      const startedSessions = recordsOf(records, "session.started");
      expect(startedSessions).toHaveLength(2);
      const mcodeSessions = startedSessions.filter((record) => {
        const data = SessionStartedData.parse(record.data);
        return data.session.startsWith(`${HARNESS} `);
      });
      expect(mcodeSessions).toHaveLength(1);

      // The task ended with "ok", and the trace from the task is one chain.
      const done = must(
        recordsOf(records, "task.done").find((record) => {
          const data = record.data as { task?: string } | undefined;
          return data?.task === taskId;
        }),
        "the record of the task that ended",
      );
      const outcome = TaskDoneData.parse(done.data);
      expect(outcome.outcome.status).toBe("result");
      expect(String(outcome.outcome.result ?? "").toLowerCase()).toContain("ok");

      const traced = await api.trace(created.id);
      const tracedTypes = traced.map((record) => typeOf(record));
      expect(tracedTypes).toContain("session.started");
      expect(tracedTypes).toContain("task.done");
      expect(tracedTypes).toContain("message.sent");
      const roots = new Set(traced.map((record) => String(record.root)));
      expect(roots.size).toBe(1);
      expect(String(must(traced[0], "the record the trace started from").root)).toBe(
        String(created.id),
      );

      // The asker's answer is the result, and the asker used only the two niwa tools it was given.
      expect(answer.toLowerCase().replace(/[^a-z]/g, "")).toBe("ok");
      const transcript = (await api.call(actionName("session.read"), { session: askerSession })) as {
        records: { kind: string; name?: string }[];
      };
      const niwaCalls = transcript.records
        .filter((record) => record.kind === "tool-call" && (record.name ?? "").includes("niwa"))
        .map((record) => record.name ?? "");
      expect(niwaCalls.length).toBeGreaterThanOrEqual(2);
      for (const name of niwaCalls) expect(name).toMatch(/task_(create|result)$/);

      const doneMs = done.at - created.at;
      console.log(
        `agent live timings: session.start ${String(startMs)} ms, task.done at +${String(doneMs)} ms, answer after ${String(answerMs)} ms`,
      );
      console.log(`agent answer: ${answer}`);
      console.log(`agent mcp client: ${mcpClientId}`);
    } finally {
      await api?.close();
      await host.stop().catch(() => {});
      await home.cleanup();
      // Nothing outlives the host: no process was started on this home and is still running.
      await Bun.sleep(500);
      const left = Bun.spawnSync(["pgrep", "-f", home.path]);
      expect(left.stdout.toString().trim()).toBe("");
    }
  },
  600_000,
);

/**
 * The answer of the asker, read through the reading side of its harness.
 *
 * The answer is what the session said after it read the result of the task: the transcript
 * holds the call of the result tool and the text that came after it, so the answer is the
 * first thing the session said once that call had been answered.
 */
async function waitForAnswer(
  api: Awaited<ReturnType<typeof connect>>,
  askerSession: string,
  deadlineMs: number,
): Promise<string> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const read = await api.call(actionName("session.read"), { session: askerSession });
    const records = (read as { records: { kind: string; text?: string; name?: string }[] }).records;
    const answered = records.findIndex(
      (record) => record.kind === "tool-result" && (record.name ?? "").endsWith("task_result"),
    );
    if (answered !== -1) {
      for (const record of records.slice(answered + 1)) {
        if (
          record.kind === "assistant" &&
          typeof record.text === "string" &&
          record.text.trim() !== ""
        ) {
          return record.text.trim();
        }
      }
    }
    if (Date.now() >= until) {
      throw new Error(`the asker session said nothing within ${String(deadlineMs)} ms`);
    }
    await Bun.sleep(500);
  }
}
