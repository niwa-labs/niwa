// The requests module: "The executor asks; the task sleeps; the
// question is in the list of open requests; an answer continues the work."
//
// One test runs in a real host process that is killed with SIGKILL while the executor waits, and
// started again. The other scenarios run in one process, against a real host on a temporary home.

import { expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { grant, principalOf, record, agent, owner } from "@niwa-labs/core";
import type { Host } from "@niwa-labs/host";
import type { NiwaApi } from "@niwa-labs/client";
import type { StoredRecord, Timestamp } from "@niwa-labs/core";
import {
  REQUEST_ANSWER,
  REQUEST_ASK,
  REQUEST_CANCEL,
  REQUEST_OPEN,
  REQUEST_FIND,
  REQUEST_GET,
  REQUEST_RESOLVE,
  RequestAnswered,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpiredRecord,
  QuestionName,
  ResolverRegistry,
  requestAsk,
  question,
  requests,
} from "@niwa-labs/requests";
import {
  eventually,
  spawnHost,
  tempHome,
  STATE_TYPE,
  invocationOf,
  lastState,
  pick,
  watch,
  connectAsOwner,
} from "@niwa-labs/testing";
import { z } from "zod";

import {
  Answered,
  Ended,
  OWNER_CLIENT,
  Proceed,
  ReleaseBranch,
  Start,
  bind,
  executor,
} from "./fixtures/requests-host.ts";

const SCRIPT = new URL("./fixtures/requests-host.ts", import.meta.url).pathname;

const Listed = z.object({ requests: z.array(z.record(z.string(), z.unknown())) });

/** What answering a request answers: whether the answer stands, and why it does not. */
const AnswerResultSchema = z.object({
  id: z.string(),
  accepted: z.boolean(),
  reason: z.enum(["cancelled", "expired"]).optional(),
});

type AnswerResult = z.infer<typeof AnswerResultSchema>;

/** The records of one type, read from the journal as the observer saw it. */
function of(seen: StoredRecord[], type: { name: string }): StoredRecord[] {
  return seen.filter((record) => record.type === type.name);
}

/** The id of the one request that was created. */
function requestIdOf(seen: StoredRecord[]): string {
  const created = of(seen, RequestCreated);
  expect(created).toHaveLength(1);
  return (created[0]?.data as { id: string }).id;
}

/** What the owner sees in the list of open requests. */
async function openIds(client: NiwaApi): Promise<unknown[]> {
  const listed = Listed.parse(await client.call(REQUEST_OPEN, {}));
  return listed.requests.map((entry) => entry.id);
}

test("the executor asks, the work sleeps through a kill, and an answer after the restart continues it", async () => {
  const home = await tempHome();
  const first = spawnHost(SCRIPT, home.path);
  let second: ReturnType<typeof spawnHost> | undefined;
  const clients: NiwaApi[] = [];
  let observer: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    await first.ready();
    const asker = await connectAsOwner(home.path);
    clients.push(asker);
    await asker.emit(Start, { release: "1.0" });

    // The question is in the journal, and the executor is waiting, not failed.
    observer = await watch(home.path);
    const seen = observer.seen;
    await eventually(
      () => of(seen, RequestCreated).length === 1 && lastState(seen)?.state === "waiting",
      10_000,
      "the request was not created, or the executor did not wait",
    );
    const id = requestIdOf(seen);
    expect(of(seen, RequestAnswered)).toHaveLength(0);

    // The host dies without a clean shutdown while the executor waits.
    await first.kill();
    await observer.stop();
    await asker.close();

    second = spawnHost(SCRIPT, home.path);
    await second.ready();
    expect(second.pid).not.toBe(first.pid);

    const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
    const intruder = await connect({ home: home.path, id: "intruder" });
    clients.push(ownerClient, intruder);
    observer = await watch(home.path);
    const after = observer.seen;

    // The question is on the list of open requests, and it was not asked again.
    expect(await openIds(ownerClient)).toContain(id);
    await eventually(() => of(after, RequestCreated).length === 1, 10_000, "the journal was not read");
    expect(of(after, Answered)).toHaveLength(0);

    // Somebody with no token is on the default profile, which does not answer a request, whatever the payload says.
    await expect(intruder.call(REQUEST_ANSWER, { id, answer: pick("next"), by: owner })).rejects.toThrow(
      "not in the grant",
    );
    expect(of(after, RequestAnswered)).toHaveLength(0);

    // The owner answers: the work continues in the invocation that waited before the kill.
    await ownerClient.call(REQUEST_ANSWER, { id, answer: pick("main") });
    await eventually(() => of(after, Answered).length === 1, 10_000, "the work did not continue");
    expect(of(after, Answered)[0]?.data).toEqual({ release: "1.0", branch: "main" });
    expect(of(after, RequestCreated)).toHaveLength(1);
    // The state of the invocation follows the record its handler wrote, so the test waits for it.
    await eventually(
      () => lastState(after, invocationOf(after))?.state === "done",
      10_000,
      "the invocation did not end as done",
    );
    expect(await openIds(ownerClient)).not.toContain(id);

    // The same answer again changes nothing; another answer is refused; the first stands.
    await ownerClient.call(REQUEST_ANSWER, { id, answer: pick("main") });
    await expect(ownerClient.call(REQUEST_ANSWER, { id, answer: pick("next") })).rejects.toThrow("already answered");
    expect(of(after, RequestAnswered)).toHaveLength(1);
    expect((of(after, RequestAnswered)[0]?.data as { by: unknown }).by).toEqual(owner);
  } finally {
    await observer?.stop();
    for (const client of clients) await client.close().catch(() => {});
    await first.stop();
    await second?.stop();
    await home.cleanup();
  }
});

/** A host with the requests module and the executor, and a client for the owner. */
async function serve(resolvers?: ResolverRegistry) {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind, ...(resolvers === undefined ? {} : { resolvers }) }));
  host.use(executor());
  await host.serve();
  const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
  const observed = await watch(home.path);
  return {
    host,
    home,
    ownerClient,
    seen: observed.seen,
    async close() {
      await observed.stop();
      await ownerClient.close();
      await host.close();
      await home.cleanup();
    },
  };
}

/** A client the host issued a token with no grant: nothing limits it, and it is not the owner. */
function plainClient(host: Host, home: string, id: string): Promise<NiwaApi> {
  return connect({ home, id, token: host.issueToken(principalOf("client", id)) });
}

test("requests: request.ask called directly returns the open request at once and does not fail", async () => {
  const world = await serve();
  try {
    // Outside a step nothing can wait: the request is made and its id comes back, still open.
    const asked = await world.ownerClient.call<unknown, { id: string; status: string }>(REQUEST_ASK, { to: owner, ...ReleaseBranch });
    expect(asked.status).toBe("open");
    expect(asked.id.startsWith("req-")).toBe(true);
    expect(await openIds(world.ownerClient)).toContain(asked.id);

    // The caller reads it later by the id, and finds the answer there once the owner gave it.
    const open = await world.ownerClient.call<unknown, { status: string }>(REQUEST_GET, { id: asked.id });
    expect(open.status).toBe("open");
    await world.ownerClient.call(REQUEST_ANSWER, { id: asked.id, answer: pick("next") });
    const answered = await world.ownerClient.call<unknown, { status: string; answer?: unknown }>(REQUEST_GET, { id: asked.id });
    expect(answered.status).toBe("answered");
    expect(answered.answer).toEqual(pick("next"));
  } finally {
    await world.close();
  }
});

test("requests: a cancelled request is never answered, and only a party to it may cancel", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "2.0" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    const intruder = await plainClient(world.host, world.home.path, "intruder");

    try {
      await expect(intruder.call(REQUEST_CANCEL, { id })).rejects.toThrow("asker or the addressee");
    } finally {
      await intruder.close();
    }
    expect(of(world.seen, RequestCancelledRecord)).toHaveLength(0);

    await world.ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });
    await world.ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });
    await eventually(() => of(world.seen, RequestCancelledRecord).length === 1, 10_000, "no cancellation");
    expect(await openIds(world.ownerClient)).not.toContain(id);

    // An answer to a cancelled request does nothing: it is not refused, it does not stand.
    const late = await world.ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id, answer: pick("main") },
    );
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe("cancelled");
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
    expect(of(world.seen, Answered)).toHaveLength(0);
  } finally {
    await world.close();
  }
});

test("requests: request.find gives the request a record caused, by the name of its question", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "2.0" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const created = of(world.seen, RequestCreated)[0];
    const { id, question } = created?.data as { id: string; question: string };
    const cause = created?.cause;
    expect(cause).toBeTruthy();

    const found = await world.ownerClient.call(REQUEST_FIND, { cause, question });
    expect(found).toEqual({ id });
    // Another record, or another question, caused no request.
    expect(await world.ownerClient.call(REQUEST_FIND, { cause: created?.id, question })).toEqual({});
    expect(await world.ownerClient.call(REQUEST_FIND, { cause, question: "other" })).toEqual({});
  } finally {
    await world.close();
  }
});

/** A handler that stands for an address of its own asks, and withdraws what it asked, as itself. */
const AskAsMe = record("requests.ask-as-me", z.object({ key: z.string() }), { open: true });
const WithdrawMine = record("requests.withdraw-mine", z.object({ id: z.string() }), { open: true });
const ME = agent("planner");

test("requests: a handler asks as the address it says, and cancels its own request as that address", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  const refused: string[] = [];
  host.use(
    plugin("requests-planner", (api) => {
      api.declare(AskAsMe, WithdrawMine);
      api.on(AskAsMe, { concurrency: Number.POSITIVE_INFINITY }, async (_data, step) => {
        await step.outcome(requestAsk, { to: owner, ...ReleaseBranch, from: ME });
      });
      api.on(WithdrawMine, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
        try {
          await step(REQUEST_CANCEL, { id: data.id, reason: "not needed", by: ME });
        } catch (error) {
          refused.push(String(error));
        }
      });
    }),
  );
  await host.serve();
  const observed = await watch(home.path);
  const intruder = await plainClient(host, home.path, "intruder");
  try {
    await host.emit(AskAsMe, { key: "one" });
    await eventually(() => of(observed.seen, RequestCreated).length === 1, 10_000, "no request");
    expect(of(observed.seen, RequestCreated)[0]?.data).toMatchObject({ from: ME });
    const id = requestIdOf(observed.seen);

    // A client is held to its binding: the payload does not make it the asker.
    await intruder.call(requestAsk, { to: owner, ...ReleaseBranch, from: ME }).catch(() => {});
    await eventually(() => of(observed.seen, RequestCreated).length === 2, 10_000, "no second request");
    const intruded = (of(observed.seen, RequestCreated)[1]?.data as { from?: { kind: string; id?: string } }).from;
    expect(intruded?.kind).toBe("client");
    expect(intruded?.id?.startsWith("intruder")).toBe(true);

    await host.emit(WithdrawMine, { id });
    await eventually(() => of(observed.seen, RequestCancelledRecord).length === 1 || refused.length > 0, 10_000, "no cancellation");
    expect(refused).toEqual([]);
    expect(of(observed.seen, RequestCancelledRecord)[0]?.data).toMatchObject({ id, by: ME });
  } finally {
    await observed.stop();
    await intruder.close();
    await host.close();
    await home.cleanup();
  }
});

/** A handler that cancels a request and says who cancels, as a handler that stands for an address may. */
const CancelIt = record("requests.cancel-it", z.object({ id: z.string() }), { open: true });

test("requests: a handler may say who cancels; a client that says it in the payload is still held to its binding", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(executor());
  host.use(
    plugin("requests-canceller", (api) => {
      api.declare(CancelIt);
      api.on(CancelIt, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
        await step(REQUEST_CANCEL, { id: data.id, reason: "the handler decided", by: owner });
      });
    }),
  );
  await host.serve();
  const observed = await watch(home.path);
  const intruder = await plainClient(host, home.path, "intruder");
  try {
    await host.emit(Start, { release: "2.1" });
    await eventually(() => of(observed.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(observed.seen);

    // The payload does not make the intruder a party: a client is whoever its binding says.
    await expect(intruder.call(REQUEST_CANCEL, { id, by: owner })).rejects.toThrow("asker or the addressee");
    expect(of(observed.seen, RequestCancelledRecord)).toHaveLength(0);

    await host.emit(CancelIt, { id });
    await eventually(() => of(observed.seen, RequestCancelledRecord).length === 1, 10_000, "no cancellation");
    expect(of(observed.seen, RequestCancelledRecord)[0]?.data).toMatchObject({ id, by: { kind: "owner" } });
  } finally {
    await observed.stop();
    await intruder.close();
    await host.close();
    await home.cleanup();
  }
});

test("an operator ask stays open for the owner when automatic and raw answers are refused", async () => {
  const resolvers = new ResolverRegistry();
  resolvers.register(ReleaseBranch, () => ({ answered: true, answer: pick("next") }));
  const world = await serve(resolvers);
  const token = world.host.issueToken(principalOf("session", "writer"), { grant: grant(["emit:request.answered"]) });
  const writer = await connect({ home: world.home.path, token });
  try {
    await world.host.emit(Start, { release: "operator", ownerOnly: true });
    await eventually(() => of(world.seen, RequestCreated).length === 1);
    const id = RequestCreated.schema.parse(of(world.seen, RequestCreated)[0]?.data).id;
    expect(await world.ownerClient.call(REQUEST_RESOLVE, { id, answer: pick("next") })).toEqual({ answered: false });
    await expect(writer.emit(RequestAnswered, { id, answer: pick("next"), by: owner })).rejects.toMatchObject({ code: "Denied" });
    expect(await world.host.records.read({ types: [RequestAnswered.name] })).toHaveLength(0);
    expect(await openIds(world.ownerClient)).toContain(id);
    await world.ownerClient.call(REQUEST_ANSWER, { id, answer: pick("main") });
    await eventually(() => of(world.seen, Answered).length === 1);
    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "operator", branch: "main" });
  } finally {
    await writer.close();
    await world.close();
  }
});

test("requests: a resolver answers before the request reaches the owner, and the answer is a record", async () => {
  const resolvers = new ResolverRegistry();
  resolvers.register(ReleaseBranch, () => ({ answered: true, answer: pick("next") }));
  const world = await serve(resolvers);
  try {
    await world.host.emit(Start, { release: "3.0" });
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the resolver did not answer");

    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "3.0", branch: "next" });
    const answered = of(world.seen, RequestAnswered);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toEqual({ id: requestIdOf(world.seen), answer: pick("next") });
    expect(await openIds(world.ownerClient)).toEqual([]);
  } finally {
    await world.close();
  }
});

test("requests: a resolve with an answer answers the request that no resolver answered", async () => {
  // The resolver says no, so the request stays open for its addressee.
  const resolvers = new ResolverRegistry();
  resolvers.register("*", () => ({ answered: false }));
  const world = await serve(resolvers);
  try {
    await world.host.emit(Start, { release: "3.1" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);

    // The resolve carries the answer, and the request is answered by it.
    const resolved = await world.host.call<{ id: string; answer: unknown }, { answered: boolean }>(
      REQUEST_RESOLVE,
      { id, answer: pick("next") } as never,
    );
    expect(resolved.answered).toBe(true);
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the asker did not go on");
    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "3.1", branch: "next" });
    expect(of(world.seen, RequestAnswered)).toHaveLength(1);
  } finally {
    await world.close();
  }
});

test("requests: a resolve with an answer writes the answer, and the schema is checked", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "3.2" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);

    // The question asks for a branch name: a number is not one.
    await expect(
      world.host.call(REQUEST_RESOLVE, { id, answer: pick("nope") } as never),
    ).rejects.toThrow("not valid");
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);

    // The right answer answers the request, and the asker goes on.
    const resolved = await world.host.call<{ id: string; answer: unknown }, { answered: boolean }>(
      REQUEST_RESOLVE,
      { id, answer: pick("main") } as never,
    );
    expect(resolved.answered).toBe(true);
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the asker did not go on");
    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "3.2", branch: "main" });
  } finally {
    await world.close();
  }
});

test("requests: how a resolve found its answer is kept apart from the answer", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "3.3" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);

    await world.host.call(REQUEST_RESOLVE, {
      id,
      answer: pick("main"),
      info: { how: "recalled", area: "releases", source: "decision-1" },
    } as never);
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the asker did not go on");
    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "3.3", branch: "main" });
    expect(of(world.seen, RequestAnswered)[0]?.data).toMatchObject({
      answer: pick("main"),
      how: "recalled",
      area: "releases",
      source: "decision-1",
    });
  } finally {
    await world.close();
  }
});

test("requests: a resolver that says no leaves the request to the owner", async () => {
  const resolvers = new ResolverRegistry();
  resolvers.register("*", () => ({ answered: false }));
  const world = await serve(resolvers);
  try {
    await world.host.emit(Start, { release: "4.0" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    await eventually(async () => (await openIds(world.ownerClient)).includes(requestIdOf(world.seen)), 10_000);
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
  } finally {
    await world.close();
  }
});

test("requests: the list of open requests holds an invocation that is paused", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  const Boom = record("requests.boom", z.object({}));
  host.use(requests({ bind }));
  host.use(
    plugin("requests-boom", (api) => {
      api.declare(Boom);
      api.on(Boom, { concurrency: Number.POSITIVE_INFINITY }, async () => {
        throw new Error("the handler cannot do it");
      });
    }),
  );
  await host.serve();
  const observed = await watch(home.path);
  const client = await connectAsOwner(home.path, OWNER_CLIENT);

  try {
    await host.emit(Boom, {});
    await eventually(() => of(observed.seen, { name: STATE_TYPE }).length > 0 && lastState(observed.seen)?.state === "paused");

    const listed = Listed.parse(await client.call(REQUEST_OPEN, {}));
    const paused = listed.requests.filter((entry) => entry.kind === "paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.invocation).toBe(invocationOf(observed.seen));
    expect(paused[0]?.choices).toEqual(expect.arrayContaining(["retry", "cancel"]));
  } finally {
    await observed.stop();
    await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("rq-1: a request cancelled while the asker waits ends the ask with RequestCancelled", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "5.0" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    await eventually(async () => (await openIds(world.ownerClient)).includes(id), 10_000, "the request is not open");

    // The owner cancels: the asker must not wait for ever.
    await world.ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });
    await eventually(() => of(world.seen, Ended).length === 1, 10_000, "the asker was not woken");
    expect(of(world.seen, Ended)[0]?.data).toEqual({ release: "5.0", ended: "cancelled" });
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
    expect(await openIds(world.ownerClient)).not.toContain(id);
  } finally {
    await world.close();
  }
});

test("rq-1: a request whose deadline passes is expired once, and the asker gets RequestExpired", async () => {
  const world = await serve();
  try {
    const deadline = (Date.now() + 500) as Timestamp;
    await world.host.emit(Start, { release: "6.0", deadline });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");

    // The time runs out: the module writes the expiry, and the asker is woken by it.
    await eventually(() => of(world.seen, RequestExpiredRecord).length === 1, 10_000, "no expiry");
    await eventually(() => of(world.seen, Ended).length === 1, 10_000, "the asker was not woken");
    expect(of(world.seen, Ended)[0]?.data).toEqual({ release: "6.0", ended: "expired" });
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);

    // The expiry is written once: the id is a function of the request alone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(of(world.seen, RequestExpiredRecord)).toHaveLength(1);
    expect(await openIds(world.ownerClient)).not.toContain(requestIdOf(world.seen));
  } finally {
    await world.close();
  }
});

test("rq-1: a host that starts after the deadline expires the request once, not twice", async () => {
  const home = await tempHome();
  const first = spawnHost(SCRIPT, home.path);
  let second: ReturnType<typeof spawnHost> | undefined;
  const clients: NiwaApi[] = [];
  let observer: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    await first.ready();
    const asker = await connectAsOwner(home.path);
    clients.push(asker);
    observer = await watch(home.path);
    const seen = observer.seen;

    // The request is made with a deadline that is still in the future.
    await asker.emit(Start, { release: "7.0", deadline: (Date.now() + 3000) as Timestamp });
    await eventually(() => of(seen, RequestCreated).length === 1, 10_000, "no request");
    expect(of(seen, RequestExpiredRecord)).toHaveLength(0);

    // The host dies before the deadline and stays down until after it.
    await first.kill();
    await observer.stop();
    await asker.close();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // The host comes back: the request is past its deadline, and it expires now.
    second = spawnHost(SCRIPT, home.path);
    await second.ready();
    const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
    clients.push(ownerClient);
    observer = await watch(home.path);
    const after = observer.seen;
    await eventually(() => of(after, RequestExpiredRecord).length === 1, 10_000, "the request did not expire");
    await eventually(() => of(after, Ended).length === 1, 10_000, "the asker was not woken");
    expect(of(after, Ended)[0]?.data).toEqual({ release: "7.0", ended: "expired" });

    // The expiry is written once: the id is a function of the request alone.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(of(after, RequestExpiredRecord)).toHaveLength(1);
    expect(of(after, Ended)).toHaveLength(1);
  } finally {
    await observer?.stop();
    for (const client of clients) await client.close().catch(() => {});
    await first.stop();
    await second?.stop();
    await home.cleanup();
  }
});

test("rq-1: after a restart the ask that ended in a cancel throws RequestCancelled again, with no new effects", async () => {
  const home = await tempHome();
  const first = spawnHost(SCRIPT, home.path);
  let second: ReturnType<typeof spawnHost> | undefined;
  const clients: NiwaApi[] = [];
  let observer: Awaited<ReturnType<typeof watch>> | undefined;

  try {
    await first.ready();
    const asker = await connectAsOwner(home.path);
    const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
    clients.push(asker, ownerClient);
    observer = await watch(home.path);
    const seen = observer.seen;

    // The handler holds after the request ended, so the ask is over and the handler is not.
    await asker.emit(Start, { release: "8.0", gate: true });
    await eventually(() => of(seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(seen);
    await eventually(async () => (await openIds(ownerClient)).includes(id), 10_000, "the request is not open");
    await ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });
    await eventually(() => of(seen, RequestCancelledRecord).length === 1, 10_000, "no cancellation");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(of(seen, Ended)).toHaveLength(0);

    await first.kill();
    await observer.stop();
    second = spawnHost(SCRIPT, home.path);
    await second.ready();
    observer = await watch(home.path);
    const after = observer.seen;
    await asker.emit(Proceed, { release: "8.0" });
    await eventually(() => of(after, Ended).length === 1, 10_000, "the handler did not go on");

    // The replayed ask threw RequestCancelled from the recorded wait: nothing was asked again.
    expect(of(after, Ended)[0]?.data).toEqual({ release: "8.0", ended: "cancelled" });
    expect(of(after, RequestCreated)).toHaveLength(1);
    expect(of(after, RequestCancelledRecord)).toHaveLength(1);
    expect(of(after, RequestExpiredRecord)).toHaveLength(0);
    expect(of(after, RequestAnswered)).toHaveLength(0);
  } finally {
    await observer?.stop();
    for (const client of clients) await client.close().catch(() => {});
    await first.stop();
    await second?.stop();
    await home.cleanup();
  }
});

test("rq-5: an answer to a cancelled request does nothing, and the answerer is told why", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "9.0" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    await world.ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });
    await eventually(() => of(world.seen, RequestCancelledRecord).length === 1, 10_000, "no cancellation");

    // The answer comes too late: it is not refused, it is refused to stand, and nothing is written.
    const late = await world.ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id, answer: pick("main") },
    );
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe("cancelled");
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
    expect(of(world.seen, Answered)).toHaveLength(0);
    expect(await openIds(world.ownerClient)).not.toContain(id);
  } finally {
    await world.close();
  }
});

test("rq-5: an answer to an expired request does nothing, and the answerer is told why", async () => {
  const world = await serve();
  try {
    const deadline = (Date.now() + 500) as Timestamp;
    await world.host.emit(Start, { release: "9.1", deadline });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    await eventually(() => of(world.seen, RequestExpiredRecord).length === 1, 10_000, "no expiry");

    const late = await world.ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id, answer: pick("main") },
    );
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe("expired");
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
    expect(of(world.seen, Answered)).toHaveLength(0);
  } finally {
    await world.close();
  }
});

test("rq-5: an answer that does not pass the schema of the question is refused, and the request stays open", async () => {
  const world = await serve();
  try {
    await world.host.emit(Start, { release: "9.2" });
    await eventually(() => of(world.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(world.seen);
    await eventually(async () => (await openIds(world.ownerClient)).includes(id), 10_000, "the request is not open");

    // The question asks for a branch name: a number is not one.
    await expect(
      world.ownerClient.call(REQUEST_ANSWER, { id, answer: pick("nope") }),
    ).rejects.toThrow("not valid");
    expect(of(world.seen, RequestAnswered)).toHaveLength(0);
    expect(await openIds(world.ownerClient)).toContain(id);

    // The right answer still answers the request, and the asker goes on.
    const answered = await world.ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id, answer: pick("main") },
    );
    expect(answered.accepted).toBe(true);
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the asker did not go on");
    expect(of(world.seen, Answered)[0]?.data).toEqual({ release: "9.2", branch: "main" });
  } finally {
    await world.close();
  }
});

test("requests: one answer among twenty open requests writes nothing for the nineteen that still wait", async () => {
  const world = await serve();
  try {
    const releases = Array.from({ length: 20 }, (_, n) => `bulk-${String(n)}`);
    for (const release of releases) await world.host.emit(Start, { release });
    await eventually(() => of(world.seen, RequestCreated).length === 20, 20_000, "not all asked");
    await eventually(
      () => world.seen.filter((r) => r.type === STATE_TYPE && (r.data as { state: string }).state === "waiting").length === 20,
      20_000,
      "not all waiting",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const before = world.seen.length;
    const waitingStreams = new Set(world.seen.filter((r) => r.stream.startsWith("invocation:")).map((r) => r.stream));
    const asked = of(world.seen, RequestCreated).find(
      (r) => (r.data as { input: { detail: string } }).input.detail === "bulk-7",
    );
    const id = (asked?.data as { id: string }).id;
    await world.ownerClient.call(REQUEST_ANSWER, { id, answer: pick("main") });
    await eventually(() => of(world.seen, Answered).length === 1, 10_000, "the asker did not go on");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const answeredStream = of(world.seen, Answered)[0]?.stream;
    const touched = world.seen
      .slice(before)
      .filter((r) => waitingStreams.has(r.stream) && r.stream !== answeredStream);
    expect(touched.map((r) => `${r.stream} ${r.type}`)).toEqual([]);
  } finally {
    await world.close();
  }
}, 60_000);

/** Wakes a handler that asks one question named "probe.answer", of the kind it names. */
const Probe = record("requests.probe", z.object({ shape: z.enum(["number", "text", "even"]) }));

/** The same question name, asked as several questions: the answer is checked against the question of its own request. */
function probeQuestion(shape: "number" | "text" | "even") {
  const name = QuestionName.parse("probe.answer");
  return shape === "text"
    ? question(name, { kind: "text", title: shape })
    : question(name, { kind: "form", title: shape, schema: { type: "number" } });
}

function prober() {
  return plugin("requests-probe", (api) => {
    api.declare(Probe);
    api.on(Probe, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const asked = probeQuestion(data.shape);
      // While the ask waits, the zod schema of the value checks it whole: JSON Schema cannot say "even".
      const check = data.shape === "even" ? z.number().refine((n) => n % 2 === 0, "an even number") : undefined;
      await step(requestAsk, { to: owner, ...asked, ...(check === undefined ? {} : { check }) });
    });
  });
}

test("ans-1: two open asks of one question name with different questions each check their own, also after a restart", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(prober());
  await host.serve();
  let second: ReturnType<typeof spawnHost> | undefined;
  let ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
  let observed = await watch(home.path);
  try {
    await host.emit(Probe, { shape: "number" });
    await eventually(() => of(observed.seen, RequestCreated).length === 1, 10_000, "no first request");
    await host.emit(Probe, { shape: "text" });
    await eventually(() => of(observed.seen, RequestCreated).length === 2, 10_000, "no second request");

    const created = of(observed.seen, RequestCreated).map(
      (r) => r.data as { id: string; input: { title: string; kind: string; schema?: unknown } },
    );
    const numberId = created.find((data) => data.input.title === "number")?.id ?? "";
    const textId = created.find((data) => data.input.title === "text")?.id ?? "";
    // The question is written whole with each request: its kind and its schema.
    expect(created.find((data) => data.id === numberId)?.input).toMatchObject({ kind: "form", schema: { type: "number" } });
    expect(created.find((data) => data.id === textId)?.input).toMatchObject({ kind: "text" });

    // Each answer is checked against the question of its own request, not the last one declared.
    await expect(ownerClient.call(REQUEST_ANSWER, { id: numberId, answer: { form: "forty-two" } })).rejects.toThrow("not valid");
    await expect(ownerClient.call(REQUEST_ANSWER, { id: textId, answer: { form: 42 } })).rejects.toThrow("not valid");
    expect(of(observed.seen, RequestAnswered)).toHaveLength(0);

    // A host that starts again on the same journal, in another process without the code that
    // asked and without the schemas this process holds, checks the same.
    await observed.stop();
    await ownerClient.close();
    await host.close();
    second = spawnHost(SCRIPT, home.path);
    await second.ready();
    ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
    observed = await watch(home.path);

    await expect(ownerClient.call(REQUEST_ANSWER, { id: numberId, answer: { form: "forty-two" } })).rejects.toThrow("not valid");
    await expect(ownerClient.call(REQUEST_ANSWER, { id: textId, answer: { form: 42 } })).rejects.toThrow("not valid");
    const toNumber = await ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id: numberId, answer: { form: 42 } },
    );
    const toText = await ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id: textId, answer: { text: "forty-two" } },
    );
    expect(toNumber.accepted).toBe(true);
    expect(toText.accepted).toBe(true);
  } finally {
    await observed.stop();
    await ownerClient.close().catch(() => {});
    await host.close();
    await second?.stop();
    await home.cleanup();
  }
}, 30_000);

test("ans-1: while the ask waits, its schema checks the answer whole, refinements included", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(prober());
  await host.serve();
  const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
  const observed = await watch(home.path);
  try {
    await host.emit(Probe, { shape: "even" });
    await eventually(() => of(observed.seen, RequestCreated).length === 1, 10_000, "no request");
    const id = requestIdOf(observed.seen);
    // JSON Schema cannot say "even": the recorded schema is a number, the refinement is not lost.
    await expect(ownerClient.call(REQUEST_ANSWER, { id, answer: { form: 3 } })).rejects.toThrow("an even number");
    expect(of(observed.seen, RequestAnswered)).toHaveLength(0);
    const answered = await ownerClient.call<{ id: string; answer: unknown }, AnswerResult>(
      REQUEST_ANSWER,
      { id, answer: { form: 4 } },
    );
    expect(answered.accepted).toBe(true);
  } finally {
    await observed.stop();
    await ownerClient.close();
    await host.close();
    await home.cleanup();
  }
});
