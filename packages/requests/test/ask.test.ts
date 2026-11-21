// A call under an `ask` rule creates a request to the owner and waits for
// the answer. `once` lets this call through, `run` lasts as long as the subject's grant, `always` is
// written into the grant, and no answer is a denial. The answers in force survive a restart.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { CORE_TYPES, action, actionName, deny, grant, owner as ownerAddress, principalOf, seq } from "@niwa-labs/core";
import type { RuleSpec, Token } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { HostError, connect, createNiwa, eventually, tempHome, testClock, connectAsOwner, pick } from "@niwa-labs/testing";
import type { Host, NiwaApi, TestClock } from "@niwa-labs/testing";

import { REQUEST_ANSWER, REQUEST_CANCEL, REQUEST_OPEN, RequestAnswered, requests } from "../src/index.ts";


/** The inputs the probe was run with, in order: what the owner let through is what ran. */
const ran: string[] = [];

const probe = plugin("ask-probe", (api) => {
  const make = (name: string) =>
    action(name, {
      description: `Records the call: ${name}.`,
      input: z.object({ n: z.string() }),
      output: z.object({ ran: z.string() }),
      recovery: "repeat",
      effect: "write",
      run: async (input) => {
        ran.push(`${name}:${input.n}`);
        return { ran: input.n };
      },
    });
  const guarded = make("probe.guarded");
  api.action(make("probe.run"));
  api.action(make("probe.other"));
  api.action(guarded);
  api.guard(guarded, (input) => (input.n === "no" ? deny("the guard says no") : undefined));
});

const AskedList = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      question: z.string().optional(),
      input: z.unknown(),
    }),
  ),
});

interface Served {
  readonly host: Host;
  readonly home: string;
  readonly clock: TestClock;
  readonly owner: NiwaApi;
  readonly secret: Token;
  readonly subject: NiwaApi;
  /** The answer the owner gives to the question that is open now. */
  answer(value: string): Promise<void>;
  /** The questions that wait for the owner now. */
  open(): Promise<z.infer<typeof AskedList>["requests"]>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  ran.length = 0;
});

async function served(
  rules: RuleSpec[],
  opts: { requests?: boolean; home?: { path: string; cleanup(): Promise<void> } } = {},
): Promise<Served> {
  const home = opts.home ?? (await tempHome());
  const clock = testClock(1_700_000_000_000);
  const host = createNiwa({ home: home.path, clock });
  host.use(probe, ...(opts.requests === false ? [] : [requests()]));
  await host.serve();
  const secret = host.issueToken(principalOf("session", "s1"), { grant: grant(rules) });
  const clients: NiwaApi[] = [];
  const owner = await connectAsOwner(home.path);
  const subject = await connect({ home: home.path, token: secret });
  clients.push(owner, subject);
  const open = async () => AskedList.parse(await owner.call(REQUEST_OPEN, {})).requests;
  const served: Served = {
    host,
    home: home.path,
    clock,
    owner,
    secret,
    subject,
    open,
    async answer(value) {
      await eventually(async () => (await open()).length > 0);
      const [first] = await open();
      await owner.call(REQUEST_ANSWER, { id: first?.id ?? "", answer: pick(value) });
    },
    async close() {
      for (const client of clients) await client.close();
      await host.close();
    },
  };
  cleanups.push(async () => {
    await served.close().catch(() => undefined);
    if (opts.home === undefined) await home.cleanup();
  });
  return served;
}

const call = (api: NiwaApi, name: string, n: string, reason?: string) =>
  api.call(actionName(name), { n }, reason === undefined ? undefined : { reason });

async function denial(promise: Promise<unknown>): Promise<HostError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HostError);
  return error as HostError;
}

test("a call under an ask rule asks the owner with who, what, the input and the reason", async () => {
  const s = await served([{ do: "probe.run", ask: true }]);
  const pending = call(s.subject, "probe.run", "alpha", "to finish the release");
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  expect(asked?.question).toBe("access.ask");
  // The question is a permission, and its subject holds the input of the call as it is.
  expect(asked?.input).toMatchObject({
    kind: "permission",
    options: [{ id: "once" }, { id: "run" }, { id: "always" }, { id: "no" }],
    subject: { who: "session:s1", action: "probe.run", rule: "call:probe.run", input: { n: "alpha" }, reason: "to finish the release" },
  });
  // Nothing ran while the owner had not answered.
  expect(ran).toEqual([]);
  await s.answer("once");
  expect(await pending).toEqual({ ran: "alpha" });
  expect(ran).toEqual(["probe.run:alpha"]);
});

test("once lets only this call through; the next call asks again, whatever its input", async () => {
  const s = await served([{ do: "probe.run", ask: true }]);
  const first = call(s.subject, "probe.run", "a");
  await s.answer("once");
  await first;

  const second = denial(call(s.subject, "probe.run", "b"));
  await eventually(async () => (await s.open()).length === 1);
  expect(ran).toEqual(["probe.run:a"]);
  const again = denial(call(s.subject, "probe.run", "a"));
  await eventually(async () => (await s.open()).length === 2);
  await s.answer("no");
  await s.answer("no");
  expect((await second).message).toContain("refused by the owner");
  await again;
  expect(ran).toEqual(["probe.run:a"]);
});

test("run lasts for the subject's grant and survives a restart", async () => {
  const home = await tempHome();
  const first = await served([{ do: "probe.run", ask: true }], { home });
  const pending = call(first.subject, "probe.run", "a");
  await first.answer("run");
  await pending;
  // Any input passes now, without a question; another action still asks.
  await call(first.subject, "probe.run", "b");
  expect(await first.open()).toEqual([]);
  const rows = await first.host.records.read({ types: [CORE_TYPES.accessAnswered] });
  expect(rows.map((row) => (row.data as { scope: string }).scope)).toEqual(["run"]);

  // The same home, the same token: the answer in force is a record, so it is still in force.
  const secret = first.secret;
  await first.close();
  const host = createNiwa({ home: home.path });
  host.use(probe, requests());
  await host.serve();
  const again = await connect({ home: home.path, token: secret });
  try {
    expect(await call(again, "probe.run", "c")).toEqual({ ran: "c" });
    const owner = await connectAsOwner(home.path);
    expect(AskedList.parse(await owner.call(REQUEST_OPEN, {})).requests).toEqual([]);
    await owner.close();
  } finally {
    await again.close();
    await host.close();
    await home.cleanup();
  }
});

test("always is written into the grant as an exact rule; a sibling the owner was not asked about asks", async () => {
  const s = await served([{ do: "probe.*", ask: true }, "access.mine"]);
  const pending = call(s.subject, "probe.run", "a");
  await s.answer("always");
  await pending;

  const mine = z.object({ rules: z.array(z.union([z.string(), z.object({ do: z.string(), ask: z.boolean().optional() })])) }).parse(await s.subject.call(actionName("access.mine"), {}));
  expect(mine.rules).toContain("call:probe.run");
  expect(mine.rules).toContainEqual({ do: "call:probe.*", ask: true });

  await call(s.subject, "probe.run", "b");
  expect(await s.open()).toEqual([]);
  const sibling = denial(call(s.subject, "probe.other", "x"));
  await eventually(async () => (await s.open()).length === 1);
  await s.answer("no");
  await sibling;
  expect(ran).toEqual(["probe.run:a", "probe.run:b"]);
});

test("no answer in time is a typed denial 'not answered', and the request ends as expired", async () => {
  const s = await served([{ do: "probe.run", ask: true }]);
  const pending = denial(call(s.subject, "probe.run", "a"));
  await eventually(async () => (await s.open()).length === 1);
  await s.clock.advance(11 * 60 * 1000);
  const error = await pending;
  expect(error.message).toContain("not answered");
  expect(error.denied).toMatchObject({ missing: "call:probe.run" });
  expect(await s.open()).toEqual([]);
  expect(ran).toEqual([]);
});

test("a cancelled question and a host with nobody to ask are denials too", async () => {
  const s = await served([{ do: "probe.run", ask: true }]);
  const pending = denial(call(s.subject, "probe.run", "a"));
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  await s.owner.call(REQUEST_CANCEL, { id: asked?.id ?? "" });
  expect((await pending).message).toContain("not answered");

  const bare = await served([{ do: "probe.run", ask: true }], { requests: false });
  expect((await denial(call(bare.subject, "probe.run", "a"))).message).toContain("not answered");
  expect(ran).toEqual([]);
});

test("the guards still run after an allowed ask and may refuse", async () => {
  const s = await served([{ do: "probe.guarded", ask: true }]);
  const pending = denial(call(s.subject, "probe.guarded", "no"));
  await s.answer("run");
  expect((await pending).message).toContain("the guard says no");
  expect(ran).toEqual([]);
});

test("the decision of an allowed ask records the scope that let it through", async () => {
  const s = await served([{ do: "probe.run", ask: true }]);
  const pending = call(s.subject, "probe.run", "a");
  await s.answer("once");
  await pending;
  const rows = await s.host.records.read({ types: [CORE_TYPES.accessDecided] });
  expect(rows.map((row) => row.data)).toContainEqual(
    expect.objectContaining({ name: "probe.run", outcome: "allowed", answered: "once", rule: "call:probe.run" }),
  );
});

test("a subject that may write the answer record itself cannot confirm its own call as the owner", async () => {
  const s = await served([{ do: "probe.run", ask: true }, "emit:request.answered"]);
  const pending = call(s.subject, "probe.run", "a");
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  // The record says the owner answered, but the one who wrote it is the subject's own client.
  await s.subject.emit(RequestAnswered, { id: asked?.id as never, answer: pick("always"), by: ownerAddress });
  expect(await s.open()).toHaveLength(1);
  expect(ran).toEqual([]);
  const rows = await s.host.records.read({ types: [CORE_TYPES.accessAnswered] });
  expect(rows).toEqual([]);
  await s.answer("once");
  expect(await pending).toEqual({ ran: "a" });
});
