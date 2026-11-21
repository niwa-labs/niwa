// A tool permission question becomes a question for the owner: the approval of a tool is one of
// the things that waits for the owner.
//
// The insert plugin is served by a real host, with the requests module beside it, and a harness
// side that carries the answers back:
//
//   1. a report of a permission question creates a request to the owner, with the choices of the
//      event and an id of the harness, the session and the request id
//   2. the owner answers: the side that asked carries the answer back, once
//   3. somebody who is not the owner cannot answer the request

import { expect, test } from "bun:test";

import { actionName, owner, principalOf, seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { harnessId, INSERT_REPORT_ACTION, sessionId } from "@niwa-labs/harness";
import type { HarnessInsert, PermissionAnswer, PermissionAskedEvent } from "@niwa-labs/harness";
import type { CallerBinding } from "@niwa-labs/plugin";
import {
  REQUEST_ANSWER,
  REQUEST_CANCEL,
  RequestAnswered,
  RequestCreated,
  RequestExpiredRecord,
} from "@niwa-labs/requests/records";
import { connect, connectAsOwner, createNiwa, eventually, requests, tempHome } from "@niwa-labs/testing";

import { insertPlugin, PermissionRouter } from "../src/index.ts";

/** The action an insert calls to report what happened inside the harness. */
const REPORT = actionName(INSERT_REPORT_ACTION);

/** The label the owner's client connects with; the host adds the number of the connection. */
const OWNER_CLIENT = "owner-ui";

/** The owner's client speaks as the owner; every other client speaks as itself. */
const bind: CallerBinding = (caller) => {
  if (caller.kind !== "client") return undefined;
  return caller.id.startsWith(`${OWNER_CLIENT}#`) ? owner : { kind: "client", id: caller.id };
};

/** The harness the question comes from. */
const HARNESS = harnessId("claude-code");

/** The side of the harness: it carries the answers back to the harness that asked. */
function side(answered: PermissionAnswer[]): HarnessInsert {
  return {
    events: async function* () {},
    answerPermission: async (answer) => void answered.push(answer),
  };
}

/** The event of a tool that asks for permission. */
function asked(requestId = "tool-1"): PermissionAskedEvent {
  return {
    kind: "permission-asked",
    session: sessionId(HARNESS, "s1"),
    requestId,
    tool: "Bash",
    detail: "rm -rf build",
  };
}

/** The records of one type, as the journal holds them. */
async function recordsOf(client: Awaited<ReturnType<typeof connect>>, type: string): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  const stream = client.records.since({ types: [type as never] }) as AsyncGenerator<StoredRecord>;
  for (;;) {
    const next = await Promise.race([stream.next(), Bun.sleep(500).then(() => "timed out" as const)]);
    if (next === "timed out" || next.done === true) break;
    found.push(next.value);
  }
  return found;
}

/** A host with the insert plugin and the requests module, and a client for the owner. */
async function serve(permissionTimeoutMs?: number) {
  const home = await tempHome();
  const answered: PermissionAnswer[] = [];
  const router = new PermissionRouter();
  router.register(HARNESS, side(answered));

  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(insertPlugin({ router, ...(permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs }) }));
  await host.serve();

  const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
  const reporter = await connect({ home: home.path, id: "insert-reporter" });
  return {
    home,
    host,
    answered,
    ownerClient,
    reporter,
    async close() {
      await ownerClient.close();
      await reporter.close();
      await host.close();
      await home.cleanup();
    },
  };
}

test("a permission question becomes a request to the owner, and the answer goes back to the side that asked", async () => {
  const world = await serve();
  try {
    await world.reporter.call(REPORT, asked());

    // The question is a request to the owner, with the choices of the event.
    await eventually(async () => (await recordsOf(world.ownerClient, RequestCreated.name)).length === 1, 10_000, "no request");
    const created = (await recordsOf(world.ownerClient, RequestCreated.name))[0];
    const data = created?.data as {
      id: string;
      to: { kind: string };
      question: string;
      input: { kind: string; title: string; options: Array<{ id: string; flavor: string }>; subject: { tool: string } };
    };
    expect(data.to).toEqual(owner);
    expect(data.question).toBe("insert.permission");
    expect(data.input.kind).toBe("permission");
    expect(data.input.options.map((option) => option.id)).toEqual(["allow", "deny"]);
    expect(data.input.options.map((option) => option.flavor)).toEqual(["allow_once", "reject_once"]);
    expect(data.input.subject.tool).toBe("Bash");
    expect(data.id).toMatch(/^req-[0-9a-f]{6,8}$/);
    // The answer goes back to the side that asked, once.
    await world.ownerClient.call(REQUEST_ANSWER, { id: data.id, answer: { ids: ["allow"] } });
    await eventually(() => world.answered.length === 1, 10_000, "the answer did not reach the side");
    expect(world.answered).toEqual([{ requestId: "tool-1", allow: true }]);

    // The same answer again changes nothing: the side is asked once.
    await world.ownerClient.call(REQUEST_ANSWER, { id: data.id, answer: { ids: ["allow"] } });
    expect(world.answered).toHaveLength(1);
  } finally {
    await world.close();
  }
});

test("a refusal by the owner is carried back as a refusal", async () => {
  const world = await serve();
  try {
    await world.reporter.call(REPORT, asked("tool-2"));
    await eventually(async () => (await recordsOf(world.ownerClient, RequestCreated.name)).length === 1, 10_000, "no request");
    const created = (await recordsOf(world.ownerClient, RequestCreated.name))[0];
    const id = (created?.data as { id: string }).id;

    await world.ownerClient.call(REQUEST_ANSWER, { id, answer: { ids: ["deny"] } });
    await eventually(() => world.answered.length === 1, 10_000, "the answer did not reach the side");
    expect(world.answered).toEqual([{ requestId: "tool-2", allow: false }]);
  } finally {
    await world.close();
  }
});

test("somebody who is not the owner cannot answer the question", async () => {
  const world = await serve();
  // A client the host issued a token with no grant: nothing limits it, and it is not the owner.
  const intruder = await connect({
    home: world.home.path,
    id: "intruder",
    token: world.host.issueToken(principalOf("client", "intruder")),
  });
  try {
    await world.reporter.call(REPORT, asked("tool-3"));
    await eventually(async () => (await recordsOf(world.ownerClient, RequestCreated.name)).length === 1, 10_000, "no request");
    const created = (await recordsOf(world.ownerClient, RequestCreated.name))[0];
    const id = (created?.data as { id: string }).id;

    await expect(intruder.call(REQUEST_ANSWER, { id, answer: { ids: ["allow"] } })).rejects.toThrow(
      "only the addressee",
    );
    expect(world.answered).toHaveLength(0);
    expect(await recordsOf(world.ownerClient, RequestAnswered.name)).toHaveLength(0);
  } finally {
    await intruder.close();
    await world.close();
  }
});

test("a question nobody can carry the answer for is not asked", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  // No side is registered for the harness: the answer would have nowhere to go.
  host.use(insertPlugin({ router: new PermissionRouter() }));
  await host.serve();
  const client = await connect({ home: home.path, id: "insert-reporter" });
  const observer = await connectAsOwner(home.path);

  try {
    await client.call(REPORT, asked("tool-4"));
    await eventually(
      async () => (await recordsOf(observer, "insert.permission-asked")).length === 1,
      10_000,
      "the question was not recorded",
    );
    // The question is a record, and nobody waits for an answer to it.
    expect(await recordsOf(observer, RequestCreated.name)).toHaveLength(0);
  } finally {
    await observer.close();
    await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("an answer given after the host restarted while waiting reaches the side once", async () => {
  const home = await tempHome();
  const first = createNiwa({ home: home.path });
  first.use(requests({ bind }));
  const firstRouter = new PermissionRouter();
  firstRouter.register(HARNESS, side([]));
  first.use(insertPlugin({ router: firstRouter }));
  await first.serve();
  const reporter = await connect({ home: home.path, id: "insert-reporter" });
  await reporter.call(REPORT, asked("tool-5"));
  const observer = await connectAsOwner(home.path);
  await eventually(async () => (await recordsOf(observer, RequestCreated.name)).length === 1, 10_000, "no request");
  const id = ((await recordsOf(observer, RequestCreated.name))[0]?.data as { id: string }).id;
  await observer.close();
  await reporter.close();
  await first.close();

  // The host starts again: the side is new, and the question is still open.
  const answered: PermissionAnswer[] = [];
  const router = new PermissionRouter();
  router.register(HARNESS, side(answered));
  const second = createNiwa({ home: home.path });
  second.use(requests({ bind }));
  second.use(insertPlugin({ router }));
  await second.serve();
  const ownerClient = await connectAsOwner(home.path, OWNER_CLIENT);
  try {
    await ownerClient.call(REQUEST_ANSWER, { id, answer: { ids: ["allow"] } });
    await eventually(() => answered.length === 1, 10_000, "the answer did not reach the side");
    await Bun.sleep(500);
    expect(answered).toEqual([{ requestId: "tool-5", allow: true }]);
    expect(await recordsOf(ownerClient, RequestCreated.name)).toHaveLength(1);
  } finally {
    await ownerClient.close();
    await second.close();
    await home.cleanup();
  }
});

test("a permission question that is cancelled answers the side deny, with the reason", async () => {
  const world = await serve();
  try {
    await world.reporter.call(REPORT, asked("tool-6"));
    await eventually(async () => (await recordsOf(world.ownerClient, RequestCreated.name)).length === 1, 10_000, "no request");
    const id = ((await recordsOf(world.ownerClient, RequestCreated.name))[0]?.data as { id: string }).id;

    // The owner cancels: the side that asked must not wait for ever.
    await world.ownerClient.call(REQUEST_CANCEL, { id, reason: "not now" });

    await eventually(() => world.answered.length === 1, 10_000, "the cancellation did not reach the side");
    expect(world.answered).toEqual([{ requestId: "tool-6", allow: false, reason: "cancelled" }]);

    // The side is told once: the question is not pending any more.
    await Bun.sleep(500);
    expect(world.answered).toHaveLength(1);
    expect(await recordsOf(world.ownerClient, RequestAnswered.name)).toHaveLength(0);
  } finally {
    await world.close();
  }
});

test("a permission question whose time runs out answers the side deny, with the reason", async () => {
  // The question stops waiting in a moment, so nobody has to answer it.
  const world = await serve(500);
  try {
    await world.reporter.call(REPORT, asked("tool-7"));

    await eventually(() => world.answered.length === 1, 10_000, "the expiry did not reach the side");
    expect(world.answered).toEqual([{ requestId: "tool-7", allow: false, reason: "expired" }]);

    // The expiry is written once, and the side is told once.
    await Bun.sleep(500);
    expect(world.answered).toHaveLength(1);
    expect(await recordsOf(world.ownerClient, RequestExpiredRecord.name)).toHaveLength(1);
    expect(await recordsOf(world.ownerClient, RequestAnswered.name)).toHaveLength(0);
  } finally {
    await world.close();
  }
});
