import { expect, test } from "bun:test";
import { z } from "zod";
import { action, CORE_TYPES, grant, principalOf, record, RecordRefused } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { connectAsOwner, eventually, tempHome } from "@niwa-labs/testing";

const revision = z.object({ id: z.string(), basedOn: z.number(), next: z.number() });
function guarded(name: string) {
  return record(name, revision, { open: true, guard: {
    group: "admission.pages",
    key: data => data.id,
    initial: () => 0,
    admit: (state, data) => data.basedOn === state ? undefined : { code: "stale", reason: "revision changed" },
    fold: (_state, data) => data.next,
  } });
}
const Create = guarded("admission.created");
const Edit = guarded("admission.edited");
const Trigger = record("admission.trigger", z.object({}));
const Wake = record("admission.wake", z.object({}));
const Result = record("admission.result", z.object({}));
const data = (id: string, basedOn: number, next: number) => ({ id, basedOn, next });
const pages = plugin("admission", api => api.declare(Create, Edit, Trigger, Wake, Result));

test("record guards serialize competing writes and replay accepted and refused intents after restart", async () => {
  const home = await tempHome();
  let host = createNiwa({home: home.path});
  try {
    host.use(pages);
    await host.serve();
    const writes = [1, 2].map(n => host.emit(Create, data("a", 0, n), {id: "race-" + n}));
    const [winner, loser] = await Promise.allSettled(writes);
    expect(winner?.status).toBe("fulfilled");
    expect(loser).toMatchObject({status: "rejected", reason: {code: "stale", entity: "a"}});
    await host.close();

    host = createNiwa({home: home.path});
    host.use(pages);
    await host.serve();
    expect((await host.emit(Create, data("a", 0, 1), {id: "race-1"})).id).toBe("race-1");
    await host.emit(Edit, data("a", 1, 0));
    // The previously refused intent is still refused, even though its predicate holds now.
    await expect(host.emit(Create, data("a", 0, 2), {id: "race-2"})).rejects.toBeInstanceOf(RecordRefused);
    await expect(host.emit(Create, data("a", 0, 3), {id: "race-2"})).rejects.toThrow("different content");
    expect(await host.records.read({types: [CORE_TYPES.recordRefused]})).toHaveLength(1);
    await host.emit(Create, data("a", 0, 2));
  } finally { await host.close(); await home.cleanup(); }
});

test("a wire batch checks every grant and rolls back earlier entity transitions on refusal", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  host.use(pages);
  await host.serve();
  const client = await connectAsOwner(home.path);
  const token = host.issueToken(principalOf("session", "writer"), {grant: grant(["emit:admission.created"])});
  const limited = await connect({home: home.path, id: "writer", token});
  try {
    const first = {type: Create, data: data("a", 0, 1), opts: {id: "batch-first"}};
    await expect(limited.emitAll([first, {type: Result, data: {}}])).rejects.toThrow();
    expect(await host.records.read({types: [Create, Edit]})).toHaveLength(0);

    const bad = [first, {type: Edit, data: data("b", 7, 8), opts: {id: "batch-failure"}}] as const;
    await expect(client.emitAll(bad)).rejects.toBeInstanceOf(RecordRefused);
    expect(await host.records.read({types: [Create, Edit]})).toHaveLength(0);
    const audit = (await host.records.read({types: [CORE_TYPES.recordRefused]}))[0];
    expect(audit).toMatchObject({actor: {kind: "client"}, data: {attempted: "batch-failure", entity: "b", code: "stale"}});

    // Replaying the whole refused batch must not start its first transition again.
    await client.emit(Create, data("a", 0, 3));
    await expect(client.emitAll(bad)).rejects.toMatchObject({audit: {id: audit!.id}});
    expect(await host.records.read({types: [CORE_TYPES.recordRefused]})).toHaveLength(1);
    const rows = await client.emitAll([{type: Edit, data: data("a", 3, 4)}, {type: Edit, data: data("a", 4, 5)}]);
    expect(rows).toHaveLength(2);
  } finally { await limited.close(); await client.close(); await host.close(); await home.cleanup(); }
});

test("a durable handler catches the same refusal and resumes past a committed action batch", async () => {
  const home = await tempHome();
  const batch = action("admission.batch", {
    description: "Write two page revisions", input: z.object({}), output: z.null(), recovery: "repeat", effect: "record",
    async run(_, ctx) {
      await ctx.emitAll([{type: Create, data: data("a", 0, 1)}, {type: Edit, data: data("a", 1, 2)}]);
      await ctx.wait(Wake);
      return null;
    },
  });
  const worker = plugin("admission", api => {
    api.declare(Create, Edit, Trigger, Wake, Result);
    api.action(batch);
    api.on(Trigger, async (_, step) => {
      try { await step.emit(Edit, data("x", 1, 2), {key: "refusal"}); }
      catch (error) { if (!(error instanceof RecordRefused)) throw error; }
      await step(batch, {}, {key: "batch"});
      await step.emit(Result, {});
    });
  });
  let host = createNiwa({home: home.path});
  try {
    host.use(worker);
    await host.serve();
    await host.emit(Trigger, {});
    await eventually(async () => (await host.records.read({types: [CORE_TYPES.invocationState]})).some(row => (row.data as {state:string}).state === "waiting"));
    await host.close();
    host = createNiwa({home: home.path});
    host.use(worker);
    await host.serve();
    await host.emit(Wake, {});
    await eventually(async () => (await host.records.read({types:[Result]})).length === 1);
    expect(await host.records.read({types: [Create, Edit]})).toHaveLength(2);
    expect(await host.records.read({types: [CORE_TYPES.recordRefused]})).toHaveLength(1);
  } finally { await host.close(); await home.cleanup(); }
});

test("replacing guard code folds historical records without readmission and rolls back an invalid fold", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  host.use(pages);
  await host.serve();
  try {
    await host.emit(Create, data("a", 0, 3));
    const replacement = (fold: (_: number, entry: z.infer<typeof revision>) => number) => {
      const updated = record(Create.name, revision, {guard: {
        ...Create.guard!, initial: () => 0,
        admit: () => ({code:"closed", reason:"closed for new writes"}), fold,
      }});
      return plugin("admission", api => api.declare(updated, Edit));
    };
    expect(() => host.use(replacement(() => { throw new Error("invalid historical revision"); }))).toThrow("invalid historical revision");
    await host.emit(Edit, data("a", 3, 4));
    host.use(replacement((_state, entry) => entry.next));
    await host.emit(Edit, data("a", 4, 5));
    await expect(host.emit(Create, data("b", 0, 3))).rejects.toMatchObject({code:"closed"});
  } finally { await host.close(); await home.cleanup(); }
});

test("a named call returns its original typed refusal across connections", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  let calls = 0;
  const stale = action("admission.stale", {
    description:"Edit a stale revision", recovery:"repeat", effect:"record", input:z.object({}), output:z.null(),
    async run(_, ctx) {
      calls++;
      await ctx.emit(Edit, data("a", 9, 10));
      return null;
    },
  });
  host.use(plugin("admission", api => { api.declare(Edit); api.action(stale); }));
  await host.serve();
  try {
    for (let n = 0; n < 2; n++) {
      const client = await connectAsOwner(home.path);
      try {
        await expect(client.call(stale, {}, {operation: "named-edit"})).rejects.toMatchObject({
          name: "RecordRefused", code: "stale", recordType: Edit.name,
        });
      } finally { await client.close(); }
    }
    expect(calls).toBe(1);
  } finally { await host.close(); await home.cleanup(); }
});

test("a named operation retrying on a new connection reuses its committed guarded write", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  let first = true;
  const edit = action("admission.retry", {
    description:"Retry after writing", recovery:"repeat-with-key", effect:"record", input:z.object({}), output:z.string(),
    async run(_, ctx) {
      const row = await ctx.emit(Create, data("a", 0, 1));
      if (first) { first = false; throw new Error("interrupted after write"); }
      return row.id;
    },
  });
  host.use(plugin("admission", api => { api.declare(Create); api.action(edit); }));
  await host.serve();
  try {
    const original = await connectAsOwner(home.path);
    try { await expect(original.call(edit, {}, {operation: "same-write"})).rejects.toThrow("interrupted after write"); }
    finally { await original.close(); }
    const retry = await connectAsOwner(home.path);
    try {
      const id = await retry.call(edit, {}, {operation: "same-write"});
      expect((await host.records.read({types: [Create]})).map(row => row.id)).toEqual([id]);
    } finally { await retry.close(); }
  } finally { await host.close(); await home.cleanup(); }
});

test("the entity state cache preserves a fold's map values within a batch", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  const Item = record("admission.members", z.object({owner: z.string(), member: z.string()}), {guard: {
    group: "admission.members", key: data => data.owner, initial: () => new Map<string, number>(),
    admit: (members, data) => members.has(data.member) ? {code: "duplicate", reason: "member already exists"} : undefined,
    fold: (members, data) => new Map(members).set(data.member, members.size + 1),
  }});
  host.use(plugin("admission", api => api.declare(Item)));
  try {
    await host.serve();
    const item = {type: Item, data: {owner: "a", member: "x"}};
    await expect(host.emitAll([item, item])).rejects.toMatchObject({code: "duplicate"});
    await host.emitAll([item]);
  } finally { await host.close(); await home.cleanup(); }
});

test("an action's next write follows the refusal when the action handles a lost race", async () => {
  const home = await tempHome();
  const host = createNiwa({home: home.path});
  const handle = action("admission.handle", {
    description: "Handle a lost race", input: z.object({}), output: z.null(), effect: "record", recovery: "repeat",
    async run(_, ctx) {
      try { await ctx.emit(Edit, data("a", 9, 10)); }
      catch (error) { if (!(error instanceof RecordRefused)) throw error; }
      await ctx.emit(Result, {});
      return null;
    },
  });
  host.use(plugin("admission", api => { api.declare(Edit, Result); api.action(handle); }));
  try {
    await host.serve();
    await host.call(handle, {});
    const [audit, note] = await host.records.read({types: [CORE_TYPES.recordRefused, Result]});
    expect(note).toMatchObject({cause: audit!.id, root: audit!.id});
  } finally { await host.close(); await home.cleanup(); }
});
