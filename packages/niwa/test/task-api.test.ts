// The ids, list and get of tasks and messages, and the result schema of a task.
//
// A real host in this process on a temporary home, with the messages and the tasks modules. The
// owner is the caller: it speaks as `{ kind: "owner" }`, so the tasks it makes with the owner as
// the responsible party are the ones it finishes itself.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { recordId } from "@niwa-labs/core";
import type { Address as AddressType, JournalReader } from "@niwa-labs/core";
import {
  MessageId,
  MessageSent,
  messageGetRef,
  messageIds,
  messageListRef,
  messageReceiveRef,
  messages,
} from "@niwa-labs/messages";

import {
  taskAssigned,
  taskCreate,
  taskFail,
  taskFinish,
  taskGet,
  taskList,
  taskResult,
  tasks,
} from "@niwa-labs/tasks";
import { eventually, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { jsonOf, mcpPair, textOf } from "./fixtures/mcp-pair.ts";

const OWNER: AddressType = { kind: "owner" };
const ASKER: AddressType = { kind: "agent", id: "asker" };

/** A task the owner is responsible for, so the owner may finish it. */
const contract = (description: string, result?: Record<string, unknown>) => ({
  kind: "change",
  description,
  text: `Do the work: ${description}.`,
  askedBy: ASKER,
  responsible: OWNER,
  reportTo: ASKER,
  ...(result === undefined ? {} : { result }),
});

/** A host with the two modules, and a client of the owner. */
async function withHost(run: (client: Awaited<ReturnType<typeof connectAsOwner>>, home: string) => Promise<void>) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages());
  niwa.use(tasks());
  await niwa.serve();
  try {
    const client = await connectAsOwner(home.path);
    try {
      await run(client, home.path);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}

const SHAPE = { type: "object", properties: { files: { type: "number" } }, required: ["files"] };

test("a task gets an id niwa issues, and a caller's own id is refused", async () => {
  await withHost(async (client) => {
    const first = await client.call(taskCreate, contract("Split the parser"));
    const second = await client.call(taskCreate, contract("Fix the lockfile"));
    expect(first.id).toMatch(/^task-[0-9a-f]{6,8}$/);
    expect(second.id).not.toBe(first.id);

    // The contract has no `--id`: and an unknown field is refused, not ignored.
    await expect(
      // @ts-expect-error a caller never chooses the id of a task
      client.call(taskCreate, { ...contract("Choose my own id"), id: "task-aaaaaa" }),
    ).rejects.toThrow(/id/);

    // The description is a few words on one line.
    await expect(client.call(taskCreate, contract("ab"))).rejects.toThrow(/description/);
    await expect(client.call(taskCreate, contract("two\nlines"))).rejects.toThrow(/description/);
  });
}, 30_000);

test("task.list shows ids and descriptions, task.get one task by any text that names it", async () => {
  await withHost(async (client) => {
    const parser = (await client.call(taskCreate, contract("Split the parser"))).id;
    const lockfile = (await client.call(taskCreate, contract("Fix the lockfile"))).id;

    const listed = await client.call(taskList, {});
    expect<unknown>(listed.items.map((item) => [item.id, item.description, item.status])).toEqual([
      [parser, "Split the parser", "open"],
      [lockfile, "Fix the lockfile", "open"],
    ]);
    expect(listed.items[0]).toMatchObject({ kind: "change", responsible: OWNER });

    await client.call(taskFinish, { task: lockfile, result: "locked" });
    expect((await client.call(taskList, { status: "done" })).items.map((item) => item.id)).toEqual([lockfile]);
    expect((await client.call(taskList, { status: "open" })).items.map((item) => item.id)).toEqual([parser]);

    // The whole task, by its id, by the end of it, and by the start of it.
    const whole = await client.call(taskGet, { id: parser });
    expect(whole).toMatchObject({ id: parser, description: "Split the parser", status: "open", kind: "change" });
    expect(whole.outcome).toBeUndefined();
    expect((await client.call(taskGet, { id: parser.slice(-5) })).id).toBe(parser);
    expect((await client.call(taskGet, { id: parser.slice(0, -1) })).id).toBe(parser);
    expect((await client.call(taskGet, { id: lockfile })).outcome).toEqual({ status: "result", result: "locked" });

    // A text that fits both is refused with the candidates, and one that fits none is unknown.
    await expect(client.call(taskGet, { id: "task-" })).rejects.toThrow(`${parser}`);
    await expect(client.call(taskGet, { id: "task-" })).rejects.toThrow(`${lockfile}`);
    await expect(client.call(taskGet, { id: "zzzzzz" })).rejects.toThrow('no task "zzzzzz"');
  });
}, 30_000);

test("a result that does not fit the declared schema is refused and the task stays open", async () => {
  await withHost(async (client) => {
    const { id } = await client.call(taskCreate, contract("Count the files", SHAPE));

    // The assignment carries the schema, so whoever does the work is shown it.
    await eventually(async () => (await client.call(messageListRef, { task: id })).items.length === 1, 10_000, "the assignment was not sent");
    const assignment = (await client.call(messageListRef, { task: id })).items;
    const sent = await client.call(messageGetRef, { id: assignment[0]?.id ?? "" });
    expect(sent.body).toMatchObject({ type: "assignment", result: SHAPE });

    await expect(client.call(taskFinish, { task: id, result: { files: "two" } })).rejects.toThrow(
      /does not fit the schema.*files/,
    );
    await expect(client.call(taskFinish, { task: id, result: "two files" })).rejects.toThrow(/does not fit the schema/);
    // Nothing was written: the task is still open, and the right result ends it.
    expect((await client.call(taskGet, { id })).status).toBe("open");
    expect(await client.call(taskFinish, { task: id, result: { files: 2 } })).toEqual({
      task: id,
      outcome: { status: "result", result: { files: 2 } },
    });
    expect(await client.call(taskResult, { task: id })).toEqual({
      task: id,
      outcome: { status: "result", result: { files: 2 } },
    });
    await expect(client.call(taskFinish, { task: id, result: { files: 3 } })).rejects.toThrow("already done");

    // A failure is not a result: it needs no shape.
    const failing = (await client.call(taskCreate, contract("Count the dirs", SHAPE))).id;
    expect((await client.call(taskFail, { task: failing, reason: "no dirs" })).outcome).toEqual({
      status: "failure",
      reason: "no dirs",
    });
    // A task that declared nothing takes any result.
    const plain = (await client.call(taskCreate, contract("Say anything"))).id;
    expect((await client.call(taskFinish, { task: plain, result: [1, "a"] })).outcome.status).toBe("result");
  });
}, 30_000);

test("a result schema must describe an object and be readable, or the task is not made", async () => {
  await withHost(async (client) => {
    await expect(client.call(taskCreate, contract("A text result", { type: "string" }))).rejects.toThrow(/must describe an object/);
    await expect(client.call(taskCreate, contract("No type", { properties: {} }))).rejects.toThrow(/must describe an object/);
    await expect(
      client.call(taskCreate, contract("A dangling reference", { type: "object", properties: { a: { $ref: "#/$defs/nowhere" } } })),
    ).rejects.toThrow(/cannot be read/);
    expect((await client.call(taskList, {})).items).toEqual([]);
  });
}, 30_000);

test("task.assigned shows the caller the open tasks that declared a schema", async () => {
  await withHost(async (client) => {
    const declared = (await client.call(taskCreate, contract("Count the files", SHAPE))).id;
    await client.call(taskCreate, contract("Say anything"));
    // Somebody else's task is not the caller's.
    await client.call(taskCreate, { ...contract("Count for them", SHAPE), responsible: ASKER });

    expect<unknown>(await client.call(taskAssigned, {})).toEqual({
      tasks: [{ task: declared, description: "Count the files", result: SHAPE }],
    });
    await client.call(taskFinish, { task: declared, result: { files: 1 } });
    expect(await client.call(taskAssigned, {})).toEqual({ tasks: [] });
  });
}, 30_000);

test("a message gets an id niwa issues, and list and get find it again, sent or received", async () => {
  await withHost(async (client) => {
    const { id: task } = await client.call(taskCreate, contract("Split the parser"));
    await client.call(taskFinish, { task, result: "done" });
    await eventually(async () => (await client.call(messageListRef, { task })).items.length === 2, 10_000, "the task sent two messages");
    const received = await client.call(messageReceiveRef, {
      from: { kind: "client", id: "outside" },
      to: OWNER,
      body: { type: "question", text: "Is the parser split yet?\nPlease answer soon." },
    });
    expect(received.id).toMatch(/^msg-[0-9a-f]{6,8}$/);

    const listed = (await client.call(messageListRef, {})).items;
    // The assignment and the result of the task, then the one that came in.
    expect(listed.map((item) => item.kind)).toEqual(["assignment", "result", "question"]);
    expect(new Set(listed.map((item) => item.id)).size).toBe(3);
    expect<unknown>(listed[0]?.description).toBe("assignment: Do the work: Split the parser.");
    expect(listed[2]).toMatchObject({ id: received.id, description: "question: Is the parser split yet?", to: OWNER });
    expect(listed.filter((item) => item.task === task)).toHaveLength(2);
    expect((await client.call(messageListRef, { task })).items.map((item) => item.kind)).toEqual(["assignment", "result"]);

    expect(await client.call(messageGetRef, { id: received.id })).toEqual(received);
    expect((await client.call(messageGetRef, { id: received.id.slice(-5) })).id).toBe(received.id);
    await expect(client.call(messageGetRef, { id: "msg-" })).rejects.toThrow("names 3 messages");
    await expect(client.call(messageGetRef, { id: "zzzzzz" })).rejects.toThrow('no message "zzzzzz"');
  });
}, 30_000);

test("a message id is seeded by the record it is written in: a repeated call gets the id it had", async () => {
  const home = await tempHome();
  let journal: () => JournalReader | undefined = () => undefined;
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages());
  niwa.use(
    plugin("probe", (api) => {
      journal = () => api.journal?.();
    }),
  );
  await niwa.serve();
  try {
    const ids = messageIds(() => journal());
    const written = await niwa.emit(MessageSent, {
      id: MessageId.parse("msg-aaaaaa"),
      from: OWNER,
      to: ASKER,
      body: { type: "update", text: "hi" },
    });

    // The record the message was written in is its seed: the same seed finds the same id, whatever its hash would give.
    expect<unknown>(ids.issue(written.id)).toBe("msg-aaaaaa");
    // Another record gets an id of its own.
    const other = ids.issue(recordId("op-2/emit/1"));
    expect(other).not.toBe("msg-aaaaaa");
    expect(other).toMatch(/^msg-[0-9a-f]{6,8}$/);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("the MCP tool that finishes a task shows the schema of the results the caller owes", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages());
  niwa.use(tasks());
  await niwa.serve();
  let pair: Awaited<ReturnType<typeof mcpPair>> | undefined;
  try {
    const client = await connectAsOwner(home.path);
    pair = await mcpPair(home.path);
    const finishTool = async () => (await pair?.client.listTools())?.tools.find((tool) => tool.name === "task_finish");

    // No task is owed: the tool is as the action declares it.
    expect(JSON.stringify((await finishTool())?.inputSchema)).not.toContain('"enum"');

    const { id } = await client.call(taskCreate, contract("Count the files", SHAPE));
    const shown = await finishTool();
    expect(shown?.inputSchema.properties).toMatchObject({
      task: { type: "string", enum: [id] },
      result: SHAPE,
    });
    expect(shown?.inputSchema.required).toEqual(["task", "result"]);
    expect(shown?.description).toContain(`${id} (Count the files)`);

    // A result that does not fit is refused through the tool, a fitting one ends the task.
    const refused = await pair.client.callTool({ name: "task_finish", arguments: { task: id, result: { files: "x" } } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("does not fit the schema");
    const done = await pair.client.callTool({ name: "task_finish", arguments: { task: id, result: { files: 4 } } });
    expect(jsonOf(done)).toEqual({ task: id, outcome: { status: "result", result: { files: 4 } } });

    // The task is done: it is not owed any more.
    expect(JSON.stringify((await finishTool())?.inputSchema)).not.toContain(id);
    await client.close().catch(() => {});
  } finally {
    await pair?.close();
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
