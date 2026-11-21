// Addresses.
//
// "A message always carries who sent it. A bare string where an
// address is expected is rejected."
//
// The scenario runs in one process, against a real host on a temporary home:
//
//   1. the messages plugin is installed on the host
//   2. the action "message.send" is called with a full envelope: the message
//      that comes back carries who sent it, and the record "message.sent" in the
//      journal carries the same envelope
//   3. the action is called with a bare string where an address is expected:
//      the call is refused, and nothing is written
//   4. the same refusal holds for the sender, for the body and for the task
//   5. a caller that is bound to an address is that address: the payload cannot
//      claim to come from somebody else
//   6. a caller that is not bound must say who sent the message: a message
//      without a sender is refused

import { expect, test } from "bun:test";

import { OWNER, action, principalOf, record, seq, owner } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin, bindingOf } from "@niwa-labs/plugin";
import type { ClientId, HandlerId, InvocationId, RecordType, StoredRecord } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import { MessageReceived, MessageSent, messageSend, messages, render } from "@niwa-labs/messages";
import type { Message } from "@niwa-labs/messages";
import { TaskId } from "@niwa-labs/tasks";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

/** The data of a message record: the whole envelope. */
const Envelope = z.object({
  id: z.string(),
  from: z.object({ kind: z.string() }).passthrough(),
  to: z.object({ kind: z.string() }).passthrough(),
  body: z.object({ type: z.string() }),
});

/** How long the reader waits for one more record before it says there is none. */
const READ_TIMEOUT_MS = 200;

/**
 * The records of one message type.
 *
 * The subscription never ends by itself, so the reader waits for one record at a time and
 * stops when the wait passes with nothing new. The subscription is opened after the writes
 * it reads, so the history it holds is the whole journal at that moment.
 */
async function messageRecords(
  host: Host,
  type: RecordType<Message>,
  expected: number,
): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  const stream = host.records.since({ types: [type] }) as AsyncGenerator<StoredRecord>;
  for (let index = 0; index < expected; index += 1) {
    const next = await Promise.race([
      stream.next(),
      Bun.sleep(READ_TIMEOUT_MS).then(() => "timed out" as const),
    ]);
    if (next === "timed out") break;
    if (next.done === true) break;
    found.push(next.value);
  }
  return found;
}

/** The call, or the error it was refused with. */
async function call(host: Host, input: unknown): Promise<unknown | Error> {
  return host.call(messageSend(), input as never).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

test("addresses: a message always carries who sent it, and a bare string where an address is expected is rejected", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(messages({ bind: () => undefined }));
  await host.serve();

  try {
    // 1. The plugin declares its two records.
    expect(String(MessageSent.name)).toBe("message.sent");
    expect(String(MessageReceived.name)).toBe("message.received");

    // 2. A message sent with a full envelope carries who sent it, and the
    //    record in the journal carries the same envelope.
    const sent = await host.call(messageSend(), {
      from: { kind: "agent", id: "rin" },
      to: { kind: "agent", id: "executor" },
      body: { type: "assignment", text: "Move the parsing into its own module." },
    });

    expect(sent.from).toEqual({ kind: "agent", id: "rin" });
    expect(sent.to).toEqual({ kind: "agent", id: "executor" });
    expect(sent.id.length).toBeGreaterThan(0);

    const records = await messageRecords(host, MessageSent, 1);
    expect(records.length).toBe(1);
    expect(String(records[0]?.type)).toBe("message.sent");
    const parsed = Envelope.safeParse(records[0]?.data);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.id).toBe(sent.id);
    // The sender of the record is the sender of the message, always.
    expect(parsed.success && parsed.data.from).toEqual({ kind: "agent", id: "rin" });

    // 3. A bare string where an address is expected is refused, and nothing is
    //    written.
    const refused = await call(host, {
      from: { kind: "agent", id: "rin" },
      to: "executor",
      body: { type: "assignment", text: "A bare string is not an address." },
    });
    expect(refused).toBeInstanceOf(Error);
    expect((await messageRecords(host, MessageSent, 1)).length).toBe(1);

    // 4. The same holds for the sender, for the body and for the task.
    for (const input of [
      {
        from: "rin",
        to: { kind: "agent", id: "executor" },
        body: { type: "update", text: "x" },
      },
      {
        from: { kind: "agent", id: "rin" },
        to: { kind: "agent", id: "executor" },
        body: { type: "update", text: "x" },
        task: 7,
      },
      {
        from: { kind: "agent", id: "rin" },
        to: { kind: "agent", id: "executor" },
        body: { type: "update", text: "x" },
        task: "task-1",
        extra: true,
      },
    ]) {
      expect(await call(host, input)).toBeInstanceOf(Error);
    }
    expect((await messageRecords(host, MessageSent, 1)).length).toBe(1);
  } finally {
    await host.close();
    await home.cleanup();
  }
});

test("addresses: a bound caller is the sender, and an unbound caller must say who sent it", async () => {
  // 5. A caller that is bound to an address is that address: the payload cannot
  //    claim to come from somebody else.
  const boundHome = await tempHome();
  const bound = createNiwa({ home: boundHome.path });
  bound.use(messages({ bind: () => owner }));
  await bound.serve();

  try {
    const sent = await bound.call(messageSend(), {
      from: { kind: "agent", id: "someone-else" },
      to: { kind: "agent", id: "executor" },
      body: { type: "update", text: "x" },
    });
    // The binding wins: the payload does not change who the caller is.
    expect(sent.from).toEqual({ kind: "owner" });
  } finally {
    await bound.close();
    await boundHome.cleanup();
  }

  // 6. A caller that is not bound must say who sent the message: a message
  //    without a sender is refused.
  const unboundHome = await tempHome();
  const unbound = createNiwa({ home: unboundHome.path });
  unbound.use(messages({ bind: () => undefined }));
  await unbound.serve();

  try {
    expect(
      await call(unbound, {
        to: { kind: "agent", id: "executor" },
        body: { type: "update", text: "x" },
      }),
    ).toBeInstanceOf(Error);

    // The sender of that message is given when the caller is not bound.
    const named = await unbound.call(messageSend(), {
      from: { kind: "agent", id: "rin" },
      to: { kind: "agent", id: "executor" },
      body: { type: "update", text: "x" },
    });
    expect(named.from).toEqual({ kind: "agent", id: "rin" });
  } finally {
    await unbound.close();
    await unboundHome.cleanup();
  }
});

test("addresses: a message unfolds into text that says who sent it", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(messages({ bind: () => undefined }));
  await host.serve();

  try {
    const sent = await host.call(messageSend(), {
      from: { kind: "agent", id: "rin" },
      to: { kind: "agent", id: "executor" },
      task: TaskId.parse("task-1a2b3c"),
      body: { type: "assignment", kind: "change", text: "Move the parsing." },
    });

    const text = render(sent);
    expect(text).toContain("agent rin");
    expect(text).toContain("agent executor");
    expect(text).toContain("assignment");
    expect(text).toContain("Move the parsing.");
    expect(text).toContain("task-1a2b3c");
  } finally {
    await host.close();
    await home.cleanup();
  }
});

test("caller: a client is the sender the transport says, whatever the payload claims", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(messages());
  await host.serve();
  const client = await connect({ home: home.path, id: "alice" });

  try {
    const sent = await client.call(messageSend(), {
      from: { kind: "agent", id: "someone-else" },
      to: { kind: "agent", id: "executor" },
      body: { type: "update", text: "x" },
    });
    expect(sent.from).toMatchObject({ kind: "client" });
    expect(JSON.stringify(sent.from)).toContain("alice");

    const records = await messageRecords(host, MessageSent, 1);
    expect(records[0]?.actor).toMatchObject({ kind: "client" });
    expect(JSON.stringify(records[0]?.actor)).toContain("alice");
    expect(records[0]?.cause).toBeNull();
    expect(records[0]?.root).toBe(records[0]?.id);
    expect(Envelope.parse(records[0]?.data).from).toEqual(sent.from);
  } finally {
    await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("caller: a client whose principal is the owner speaks as the owner, every other client as itself", () => {
  const bind = bindingOf();

  // The principal is what says who a client speaks for: the owner's token gave it.
  expect(bind({ kind: "client", id: "telegram#3" as ClientId, principal: OWNER })).toEqual({ kind: "owner" });

  // A label that says owner means nothing without the token: the client speaks as itself.
  expect(bind({ kind: "client", id: "owner:telegram#3" as ClientId })).toEqual({
    kind: "client",
    id: "owner:telegram#3",
  });
  expect(
    bind({ kind: "client", id: "owner:telegram#3" as ClientId, principal: principalOf("client", "owner:telegram#3") }),
  ).toEqual({ kind: "client", id: "owner:telegram#3" });
  expect(
    bind({ kind: "client", id: "owner:telegram#3" as ClientId, principal: principalOf("session", "mark-1") }),
  ).toEqual({ kind: "client", id: "owner:telegram#3" });

  // Every other client speaks as itself.
  expect(bind({ kind: "client", id: "alice#1" as ClientId })).toEqual({
    kind: "client",
    id: "alice#1",
  });

  // The host and a handler stand for nobody.
  expect(bind({ kind: "host" })).toBeUndefined();
  expect(bind({ kind: "handler", handler: "rin/answer" as HandlerId, invocation: "inv-1" as InvocationId })).toBeUndefined();
});

test("caller: a client the binding does not know cannot pick its own address", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(messages({ bind: () => undefined }));
  await host.serve();
  const client = await connect({ home: home.path, id: "mallory" });

  try {
    const refused = await client
      .call(messageSend(), {
        from: { kind: "owner" },
        to: { kind: "agent", id: "executor" },
        body: { type: "update", text: "x" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(Error);
    expect((await messageRecords(host, MessageSent, 1)).length).toBe(0);
  } finally {
    await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("ActionContext.emit: a type of another plugin is refused", async () => {
  const Foreign = record("foreign.fact", z.object({ n: z.number() }));
  const Own = record("own.fact", z.object({ n: z.number() }));
  const steal = action("own.steal", {
    description: "writes a type that another plugin declared",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    async run(_input, ctx) {
      await ctx.emit(Foreign, { n: 1 });
      return {};
    },
  });
  const write = action("own.write", {
    description: "writes its own type",
    input: z.object({}),
    output: z.object({ id: z.string() }),
    recovery: "repeat",
    async run(_input, ctx) {
      const stored = await ctx.emit(Own, { n: 1 });
      return { id: stored.id };
    },
  });

  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(
    plugin("foreign", (api) => {
      api.declare(Foreign);
    }),
  );
  host.use(
    plugin("own", (api) => {
      api.declare(Own);
      api.action(steal);
      api.action(write);
    }),
  );
  await host.serve();

  try {
    await expect(host.call(steal, {})).rejects.toThrow();
    const first = await host.call(write, {});
    const second = await host.call(write, {});
    // Outside an invocation each call is its own operation, so each writes its own record.
    expect(first.id).not.toBe(second.id);
  } finally {
    await host.close();
    await home.cleanup();
  }
});
