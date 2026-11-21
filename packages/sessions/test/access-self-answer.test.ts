// A session cannot answer the question about its own call, and a connection with no token is not the owner.
//
// The access ask of a call is a request to the owner. It ends only by an answer of the owner:
// `submit-answer` and `request.resolve` answer only a question addressed to the caller, and the
// asker ignores an answer that does not carry the owner's address.

import { afterEach, expect, test } from "bun:test";

import { z } from "zod";

import { action, actionName, grant, principalOf } from "@niwa-labs/core";
import type { RuleSpec, Token } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { REQUEST_ANSWER, REQUEST_OPEN, REQUEST_RESOLVE } from "@niwa-labs/requests/records";
import {
  connect,
  connectAsOwner,
  createNiwa,
  eventually,
  HostError,
  pick,
  requests,
  tempHome,
  token,
} from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { SUBMIT_ANSWER_ACTION, submitAnswerAction } from "../src/index.ts";


const ran: string[] = [];

const probe = plugin("self-answer-probe", (api) => {
  api.action(
    action("probe.run", {
      description: "Records the call.",
      input: z.object({ n: z.string() }),
      output: z.object({ ran: z.string() }),
      recovery: "repeat",
      effect: "write",
      run: async (input) => {
        ran.push(input.n);
        return { ran: input.n };
      },
    }),
  );
  api.action(submitAnswerAction(() => api.journal?.()));
});

const Open = z.object({ requests: z.array(z.object({ id: z.string(), question: z.string().optional() })) });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  ran.length = 0;
});

/** A host with the default binding, one session that asks under a rule, and the owner. */
async function served(rules: RuleSpec[]) {
  const home = await tempHome();
  const host: Host = createNiwa({ home: home.path });
  host.use(probe, requests());
  await host.serve();
  const secret: Token = host.issueToken(principalOf("session", "s1"), { grant: grant(rules) });
  const owner = await connectAsOwner(home.path);
  const session = await connect({ home: home.path, id: "s1", token: secret });
  const watcher = await connect({ home: home.path, id: "s1-second", token: secret });
  cleanups.push(async () => {
    await owner.close();
    await session.close();
    await watcher.close();
    await host.close();
    await home.cleanup();
  });
  const open = async () => Open.parse(await owner.call(REQUEST_OPEN, {})).requests;
  return { host, home: home.path, owner, session, watcher, open };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HostError);
  return (error as HostError).message;
}

const ASKING: RuleSpec[] = [
  { do: "probe.run", ask: true },
  SUBMIT_ANSWER_ACTION,
  "request.resolve",
  "request.answer",
];

test("a session cannot answer the access ask about its own call, by submit-answer, resolve or answer", async () => {
  const s = await served(ASKING);
  const pending = s.session.call(actionName("probe.run"), { n: "mine" });
  const settled = pending.then(
    () => "let through",
    (error: unknown) => (error instanceof HostError ? error.message : String(error)),
  );
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  const id = asked?.id ?? "";
  expect(id).toMatch(/^req-[0-9a-f]{6,8}$/);

  expect(await refusal(s.watcher.call(actionName(SUBMIT_ANSWER_ACTION), { question: id, value: "once" }))).toContain(
    "only the addressee",
  );
  expect(await refusal(s.watcher.call(REQUEST_RESOLVE, { id, answer: pick("once") }))).toContain("only the addressee");
  expect(await refusal(s.watcher.call(REQUEST_ANSWER, { id, answer: pick("once") }))).toContain("only the addressee");

  // Nothing ran, and the question still waits for the owner.
  expect(ran).toEqual([]);
  expect((await s.open()).map((entry) => entry.id)).toEqual([id]);

  await s.owner.call(REQUEST_ANSWER, { id, answer: pick("once") });
  expect(await pending).toEqual({ ran: "mine" });
  expect(await settled).toBe("let through");
  expect(ran).toEqual(["mine"]);
});

test("an answer of the owner through resolve lets the call through", async () => {
  const s = await served(ASKING);
  const pending = s.session.call(actionName("probe.run"), { n: "by-resolve" });
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  await s.owner.call(REQUEST_RESOLVE, { id: asked?.id ?? "", answer: pick("once") });
  expect(await pending).toEqual({ ran: "by-resolve" });
});

test("an answer with no address on it does not let the call through: only the owner's does", async () => {
  const s = await served(ASKING);
  const pending = s.session.call(actionName("probe.run"), { n: "nobody" });
  const denied = refusal(pending);
  await eventually(async () => (await s.open()).length === 1);
  const [asked] = await s.open();
  // The host itself is in process and answers for no address: the request is answered, and the call is not let through.
  await s.host.call(REQUEST_RESOLVE, { id: asked?.id ?? "", answer: pick("once") });
  expect(await denied).toContain("not answered");
  expect(ran).toEqual([]);
});

test("a connection with no token stands on the default profile, and the owner's token is the owner", async () => {
  const s = await served(ASKING);
  const plain = await connect({ home: s.home, id: "owner:web" });
  const unknown = await connect({ home: s.home, token: token("zzzz") });
  cleanups.push(async () => {
    await plain.close();
    await unknown.close();
  });
  for (const client of [plain, unknown]) {
    expect(await refusal(client.call(actionName("probe.run"), { n: "x" }))).toContain("not in the grant");
    expect(await refusal(client.call(REQUEST_OPEN, {}))).toContain("not in the grant");
    expect(await refusal(client.call(actionName("access.switch"), { all: "off" }))).toContain("not in the grant");
    expect(await refusal(client.call(actionName("access.mine"), {}))).toContain("not in the grant");
  }
  expect(ran).toEqual([]);

  // The owner, with the owner's token, is not limited: the same calls go through.
  expect(await s.owner.call(actionName("probe.run"), { n: "owner" })).toEqual({ ran: "owner" });
  expect(Open.parse(await s.owner.call(REQUEST_OPEN, {})).requests).toEqual([]);
});

test("the default profile is what a connection with no token may do, and the owner may change it", async () => {
  const s = await served([]);
  const plain = await connect({ home: s.home, id: "plain" });
  cleanups.push(() => plain.close());
  await s.owner.call(actionName("access.profile.set"), { name: "default", rules: ["probe.run"] });
  expect(await plain.call(actionName("probe.run"), { n: "allowed-now" })).toEqual({ ran: "allowed-now" });
  expect(await refusal(plain.call(REQUEST_OPEN, {}))).toContain("not in the grant");
});
